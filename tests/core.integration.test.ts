import { describe, expect, it } from "vitest";
import { DomainError } from "../packages/contracts/src/index.js";
import { FakeProvider } from "../packages/fake-provider/src/index.js";
import { InMemoryMediaStore, JobService, ProviderExecutionService } from "../packages/media-core/src/index.js";

const auth = { tenantId: "tenant-a", subjectId: "subject-a", clientId: "test", scopes: [] };
const request = { prompt: "a red kite", outputCount: 1 };

describe("P0-01 core integration", () => {
  it("persists one semantic result for the same subject/tool/key/hash and rejects a different hash", async () => {
    const store = new InMemoryMediaStore();
    store.addWorkspace({ id: "ws-a", tenantId: "tenant-a", name: "A", status: "active" }, ["subject-a"]);
    const service = new JobService(store);
    const first = await service.create(auth, { workspaceId: "ws-a", idempotencyKey: "a".repeat(16), request, modelId: "image-v1" });
    const repeated = await service.create(auth, { workspaceId: "ws-a", idempotencyKey: "a".repeat(16), request, modelId: "image-v1" });
    expect(repeated).toEqual(first);
    await expect(service.create(auth, { workspaceId: "ws-a", idempotencyKey: "a".repeat(16), request: { prompt: "different" }, modelId: "image-v1" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(store.jobs).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);
  });

  it("hides a workspace that belongs to another tenant or subject", async () => {
    const store = new InMemoryMediaStore();
    store.addWorkspace({ id: "ws-b", tenantId: "tenant-b", name: "B", status: "active" }, ["subject-b"]);
    await expect(new JobService(store).create(auth, { workspaceId: "ws-b", idempotencyKey: "b".repeat(16), request, modelId: "image-v1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("turns unknown provider submission into reconciling without a second submit", async () => {
    const store = new InMemoryMediaStore();
    store.addWorkspace({ id: "ws-a", tenantId: "tenant-a", name: "A", status: "active" }, ["subject-a"]);
    const job = await new JobService(store).create(auth, { workspaceId: "ws-a", idempotencyKey: "u".repeat(16), request, modelId: "image-v1" });
    const provider = new FakeProvider();
    const persistedExecution = store.providerExecutions[0];
    const execution = { tenantId: "tenant-a", workspaceId: "ws-a", jobId: job.jobId, providerExecutionId: persistedExecution.id, providerRequestKey: persistedExecution.providerRequestKey, providerModelId: persistedExecution.providerModelId };
    const service = new ProviderExecutionService(store, provider);
    await service.submit(execution, { scenario: "unknown" });
    expect((await store.findJob(job.jobId))?.status).toBe("reconciling");
    expect(provider.submitCalls).toBe(1);
    await expect(service.submit(execution, { scenario: "unknown" })).rejects.toMatchObject({ code: "PROVIDER_SUBMISSION_UNKNOWN" });
    expect(provider.submitCalls).toBe(1);
  });

  it("makes Fake Provider failures deterministic and webhook duplicates idempotent", async () => {
    const provider = new FakeProvider();
    const ctx = { tenantId: "tenant-a", workspaceId: "ws-a", jobId: "job-2", providerExecutionId: "pe-2", providerRequestKey: "request-2" };
    const submission = await provider.submit(ctx, { scenario: "failure" });
    await expect(provider.getStatus(ctx, submission.providerJobId!)).resolves.toMatchObject({ status: "failed", error: { providerCode: "FAKE_DETERMINISTIC_FAILURE" } });
    expect(provider.acceptWebhook("event-1")).toBe(true);
    expect(provider.acceptWebhook("event-1")).toBe(false);
  });
});
