import { describe, expect, it } from "vitest";
import { DomainError } from "../packages/contracts/src/index.js";
import { FakeProvider } from "../packages/fake-provider/src/index.js";
import { InMemoryMediaStore, JobService, ProviderExecutionService, WebhookEventRecord } from "../packages/media-core/src/index.js";
import { AesGcmPayloadProtector, UrlImportPolicy, isBlockedNetworkAddress } from "../packages/security/src/index.js";
import { MemoryObjectStore, ObjectStore } from "../packages/storage/src/index.js";
import { AssetIngestService, ProviderPoller, ProviderReconciler, QueuePort, WebhookProcessor, pollDelayForAttempt } from "../packages/workers/src/index.js";

const auth = { tenantId: "tenant-a", subjectId: "subject-a", clientId: "test", scopes: [] };

describe("P0-02 provider safety", () => {
  it("turns an uncertain provider timeout into reconciling and refuses a blind resubmit", async () => {
    const store = new InMemoryMediaStore();
    store.addWorkspace({ id: "ws-a", tenantId: "tenant-a", name: "A", status: "active" }, ["subject-a"]);
    const job = await new JobService(store).create(auth, {
      workspaceId: "ws-a",
      idempotencyKey: "t".repeat(16),
      request: { prompt: "timeout" },
      modelId: "image-v1",
    });
    const provider = new FakeProvider();
    const service = new ProviderExecutionService(store, provider);
    const persistedExecution = store.providerExecutions[0];
    const ctx = {
      tenantId: "tenant-a",
      workspaceId: "ws-a",
      jobId: job.jobId,
      providerExecutionId: persistedExecution.id,
      providerRequestKey: persistedExecution.providerRequestKey,
      providerModelId: persistedExecution.providerModelId,
    };

    await expect(service.submit(ctx, { scenario: "timeout" })).rejects.toMatchObject({
      code: "PROVIDER_SUBMISSION_UNKNOWN",
      retryable: true,
    });
    expect((await store.findJob(job.jobId))?.status).toBe("reconciling");
    expect(provider.submitCalls).toBe(1);

    await expect(service.submit(ctx, { scenario: "timeout" })).rejects.toMatchObject({
      code: "PROVIDER_SUBMISSION_UNKNOWN",
    });
    expect(provider.submitCalls).toBe(1);
  });

  it("keeps an internally successful provider job running until Asset ingest completes", async () => {
    const store = new InMemoryMediaStore();
    store.addWorkspace({ id: "ws-a", tenantId: "tenant-a", name: "A", status: "active" }, ["subject-a"]);
    const job = await new JobService(store).create(auth, {
      workspaceId: "ws-a",
      idempotencyKey: "s".repeat(16),
      request: { prompt: "success" },
      modelId: "image-v1",
    });
    const provider = new FakeProvider();
    const executionService = new ProviderExecutionService(store, provider);
    const persistedExecution = store.providerExecutions[0];
    const ctx = {
      tenantId: "tenant-a",
      workspaceId: "ws-a",
      jobId: job.jobId,
      providerExecutionId: persistedExecution.id,
      providerRequestKey: persistedExecution.providerRequestKey,
      providerModelId: persistedExecution.providerModelId,
    };
    await executionService.submit(ctx, { scenario: "success" });

    const queued: Array<{ topic: string; payload: Record<string, unknown>; delayMs?: number }> = [];
    const queue: QueuePort = {
      async enqueue(topic, payload, options) {
        queued.push({ topic, payload, delayMs: options?.delayMs });
      },
    };
    const poller = new ProviderPoller(executionService, queue);
    await expect(poller.poll({
      ctx,
      providerJobId: `fake-${persistedExecution.providerRequestKey}`,
      attempt: 0,
      subjectId: "subject-a",
      jobKind: "image",
      requestId: "req-success",
    })).resolves.toMatchObject({ status: "succeeded" });

    expect((await store.findJob(job.jobId))?.status).toBe("running");
    expect(queued).toHaveLength(1);
    expect(queued[0].topic).toBe("asset.ingest.requested");
  });

  it("reconciles an unknown submission and schedules non-terminal polling with backoff", async () => {
    const store = new InMemoryMediaStore();
    store.addWorkspace({ id: "ws-a", tenantId: "tenant-a", name: "A", status: "active" }, ["subject-a"]);
    const job = await new JobService(store).create(auth, {
      workspaceId: "ws-a",
      idempotencyKey: "r".repeat(16),
      request: { prompt: "unknown" },
      modelId: "image-v1",
    });
    const provider = new FakeProvider();
    const executionService = new ProviderExecutionService(store, provider);
    const persistedExecution = store.providerExecutions[0];
    const ctx = {
      tenantId: "tenant-a",
      workspaceId: "ws-a",
      jobId: job.jobId,
      providerExecutionId: persistedExecution.id,
      providerRequestKey: persistedExecution.providerRequestKey,
      providerModelId: persistedExecution.providerModelId,
    };
    await executionService.submit(ctx, { scenario: "unknown" });

    const queued: Array<{ topic: string; delayMs?: number }> = [];
    const queue: QueuePort = {
      async enqueue(topic, _payload, options) {
        queued.push({ topic, delayMs: options?.delayMs });
      },
    };
    const reconciler = new ProviderReconciler(executionService, queue);
    await expect(reconciler.reconcile({
      ctx,
      providerJobId: `fake-${persistedExecution.providerRequestKey}`,
      attempt: 0,
      subjectId: "subject-a",
      jobKind: "image",
      requestId: "req-unknown",
    })).resolves.toMatchObject({ status: "running" });

    expect((await store.findJob(job.jobId))?.status).toBe("running");
    expect(queued).toEqual([{ topic: "provider.poll.requested", delayMs: 5_000 }]);
    expect(pollDelayForAttempt(99)).toBe(300_000);
  });
});

describe("P0-02 URL import safety", () => {
  it("rejects non-HTTPS and private/reserved destinations", async () => {
    const privatePolicy = new UrlImportPolicy(async () => ["10.1.2.3"]);
    await expect(privatePolicy.assertAllowed("http://example.com/file.png")).rejects.toMatchObject({ code: "UNSAFE_SOURCE_URL" });
    await expect(privatePolicy.assertAllowed("https://example.com/file.png")).rejects.toMatchObject({ code: "UNSAFE_SOURCE_URL" });

    const metadataPolicy = new UrlImportPolicy(async () => ["169.254.169.254"]);
    await expect(metadataPolicy.assertAllowed("https://metadata.example/file.png")).rejects.toMatchObject({ code: "UNSAFE_SOURCE_URL" });

    expect(isBlockedNetworkAddress("127.0.0.1")).toBe(true);
    expect(isBlockedNetworkAddress("192.168.1.5")).toBe(true);
    expect(isBlockedNetworkAddress("8.8.8.8")).toBe(false);
  });

  it("allows a public HTTPS destination after DNS validation", async () => {
    const policy = new UrlImportPolicy(async () => ["8.8.8.8"]);
    await expect(policy.assertAllowed("https://cdn.example.com/file.png")).resolves.toMatchObject({
      protocol: "https:",
      hostname: "cdn.example.com",
    });
  });
});

describe("P0-02 webhook handling", () => {
  it("verifies, encrypts, deduplicates, and enqueues only the first event", async () => {
    const provider = new FakeProvider();
    const seen = new Set<string>();
    const records: WebhookEventRecord[] = [];
    const queued: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const eventStore = {
      async recordWebhookEvent(event: WebhookEventRecord) {
        const key = `${event.providerId}:${event.providerEventId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        records.push(event);
        return true;
      },
    };
    const queue: QueuePort = {
      async enqueue(topic, payload) {
        queued.push({ topic, payload });
      },
    };
    const protector = new AesGcmPayloadProtector(new Uint8Array(32).fill(7));
    const processor = new WebhookProcessor("fake", provider, eventStore, queue, protector);
    const body = new TextEncoder().encode('{"status":"done"}');
    const headers = { "x-fake-signature": "valid", "x-fake-event-id": "evt-1" };

    await expect(processor.accept(headers, body)).resolves.toEqual({ eventId: "evt-1", duplicate: false });
    await expect(processor.accept(headers, body)).resolves.toEqual({ eventId: "evt-1", duplicate: true });

    expect(records).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect(records[0].payloadEncrypted).not.toEqual(body);
    expect(Buffer.from(records[0].payloadEncrypted).includes(Buffer.from("done"))).toBe(false);

    await expect(processor.accept({ ...headers, "x-fake-signature": "bad" }, body)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("P0-02 asset ingest", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  it("archives provider media before completing the internal job", async () => {
    const objectStore = new MemoryObjectStore();
    const completed: unknown[] = [];
    const completionStore = {
      async completeJobWithAsset(...args: unknown[]) {
        completed.push(args);
      },
    };
    const fetcher = {
      async fetch() {
        return { sourceUrl: "https://cdn.example.com/result.png", body: png, mimeType: "image/png" };
      },
    };
    const service = new AssetIngestService(fetcher, objectStore, completionStore);

    const asset = await service.ingest({
      tenantId: "tenant-a",
      subjectId: "subject-a",
      workspaceId: "ws-a",
      jobId: "job-a",
      jobKind: "image",
      requestId: "req-a",
      outputUrl: "https://cdn.example.com/result.png",
    });

    expect(asset.status).toBe("ready");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.storageBucket).toBe("memory");
    expect(asset.storageKey).toContain("tenant-a/ws-a/job-a/");
    expect(objectStore.objects.size).toBe(1);
    expect(completed).toHaveLength(1);
  });

  it("does not complete the job when private object storage fails", async () => {
    let completed = false;
    const failingStore: ObjectStore = {
      async putObject() { throw new Error("storage unavailable"); },
      async createPresignedPut() { throw new Error("not used"); },
      async createSignedReadUrl() { throw new Error("not used"); },
    };
    const fetcher = {
      async fetch() {
        return { sourceUrl: "https://cdn.example.com/result.png", body: png, mimeType: "image/png" };
      },
    };
    const completionStore = {
      async completeJobWithAsset() { completed = true; },
    };
    const service = new AssetIngestService(fetcher, failingStore, completionStore);

    await expect(service.ingest({
      tenantId: "tenant-a",
      subjectId: "subject-a",
      workspaceId: "ws-a",
      jobId: "job-a",
      jobKind: "image",
      requestId: "req-a",
      outputUrl: "https://cdn.example.com/result.png",
    })).rejects.toThrow("storage unavailable");
    expect(completed).toBe(false);
  });

  it("rejects MIME spoofing before private storage", async () => {
    const objectStore = new MemoryObjectStore();
    const service = new AssetIngestService(
      { async fetch() { return { sourceUrl: "https://cdn.example.com/result.png", body: png, mimeType: "video/mp4" }; } },
      objectStore,
      { async completeJobWithAsset() { throw new Error("must not be called"); } },
    );

    await expect(service.ingest({
      tenantId: "tenant-a",
      subjectId: "subject-a",
      workspaceId: "ws-a",
      jobId: "job-a",
      jobKind: "image",
      requestId: "req-a",
      outputUrl: "https://cdn.example.com/result.png",
    })).rejects.toMatchObject({ code: "ASSET_REJECTED" });
    expect(objectStore.objects.size).toBe(0);
  });
});
