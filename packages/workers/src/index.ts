import { createHash, randomUUID } from "node:crypto";
import { Asset, Audit, DomainError, Outbox, ProviderAdapter, ProviderExecutionContext, ProviderStatusResult } from "@xiaoshuren/contracts";
import { AssetCompletionStore, ProviderExecutionService, WebhookEventStore } from "@xiaoshuren/media-core";
import { detectMediaMime, FetchedMedia, PayloadProtector } from "@xiaoshuren/security";
import { ObjectStore } from "@xiaoshuren/storage";

export interface QueuePort {
  enqueue(topic: string, payload: Record<string, unknown>, options?: { delayMs?: number }): Promise<void>;
}

const POLL_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 300_000] as const;

export const pollDelayForAttempt = (attempt: number): number =>
  POLL_DELAYS_MS[Math.min(Math.max(attempt, 0), POLL_DELAYS_MS.length - 1)];

type ProviderWatchInput = {
  ctx: ProviderExecutionContext;
  providerJobId: string;
  attempt: number;
  subjectId: string;
  jobKind: "image" | "video";
  requestId: string;
};

const routeProviderObservation = async (
  queue: QueuePort,
  input: ProviderWatchInput,
  observation: ProviderStatusResult,
): Promise<void> => {
  if (observation.status === "succeeded") {
    for (const output of observation.outputs ?? []) {
      await queue.enqueue("asset.ingest.requested", {
        tenantId: input.ctx.tenantId,
        subjectId: input.subjectId,
        workspaceId: input.ctx.workspaceId,
        jobId: input.ctx.jobId,
        jobKind: input.jobKind,
        requestId: input.requestId,
        outputUrl: output.url,
        providerMimeType: output.mimeType,
      });
    }
    return;
  }

  if (observation.status === "queued" || observation.status === "running" || observation.status === "unknown") {
    await queue.enqueue(
      "provider.poll.requested",
      {
        ...input,
        attempt: input.attempt + 1,
      },
      { delayMs: pollDelayForAttempt(input.attempt) },
    );
  }
};

export class ProviderPoller {
  constructor(
    private readonly executionService: ProviderExecutionService,
    private readonly queue: QueuePort,
  ) {}

  async poll(input: ProviderWatchInput): Promise<ProviderStatusResult> {
    const observation = await this.executionService.observe(input.ctx, input.providerJobId);
    await routeProviderObservation(this.queue, input, observation);
    return observation;
  }
}

export class ProviderReconciler {
  constructor(
    private readonly executionService: ProviderExecutionService,
    private readonly queue: QueuePort,
  ) {}

  async reconcile(input: ProviderWatchInput): Promise<ProviderStatusResult> {
    const observation = await this.executionService.reconcile(input.ctx, input.providerJobId);
    await routeProviderObservation(this.queue, input, observation);
    return observation;
  }
}

export class WebhookProcessor {
  constructor(
    private readonly providerId: string,
    private readonly provider: ProviderAdapter,
    private readonly eventStore: WebhookEventStore,
    private readonly queue: QueuePort,
    private readonly protector: PayloadProtector,
  ) {}

  async accept(headers: Record<string, string>, rawBody: Uint8Array): Promise<{ eventId: string; duplicate: boolean }> {
    if (!this.provider.verifyWebhook) {
      throw new DomainError("INTERNAL_ERROR", "Provider webhook verification is not configured");
    }

    const verification = await this.provider.verifyWebhook(headers, rawBody);
    if (!verification.valid) {
      throw new DomainError("FORBIDDEN", "Webhook signature is invalid");
    }

    const eventId = verification.eventId ?? createHash("sha256").update(rawBody).digest("hex");
    const payloadEncrypted = await this.protector.protect(rawBody);
    const inserted = await this.eventStore.recordWebhookEvent({
      id: randomUUID(),
      providerId: this.providerId,
      providerEventId: eventId,
      signatureValid: true,
      payloadEncrypted,
      receivedAt: new Date(),
    });

    if (inserted) {
      await this.queue.enqueue("provider.webhook.received", {
        providerId: this.providerId,
        providerEventId: eventId,
      });
    }

    return { eventId, duplicate: !inserted };
  }
}

export interface MediaFetcher {
  fetch(sourceUrl: string, maxBytes: number): Promise<FetchedMedia>;
}

const extensionForMime = (mimeType: string): string => ({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
}[mimeType] ?? "bin");

export class AssetIngestService {
  constructor(
    private readonly fetcher: MediaFetcher,
    private readonly objectStore: ObjectStore,
    private readonly completionStore: AssetCompletionStore,
    private readonly maxBytes = 100 * 1024 * 1024,
  ) {}

  async ingest(input: {
    tenantId: string;
    subjectId: string;
    workspaceId: string;
    jobId: string;
    jobKind: "image" | "video";
    requestId: string;
    outputUrl: string;
  }): Promise<Asset> {
    const fetched = await this.fetcher.fetch(input.outputUrl, this.maxBytes);
    const detectedMime = detectMediaMime(fetched.body);
    if (!detectedMime) throw new DomainError("ASSET_REJECTED", "Provider output has an unsupported media signature");

    if (
      fetched.mimeType &&
      fetched.mimeType !== "application/octet-stream" &&
      fetched.mimeType !== detectedMime
    ) {
      throw new DomainError("ASSET_REJECTED", "Provider output MIME does not match its media signature");
    }

    if (input.jobKind === "image" && !detectedMime.startsWith("image/")) {
      throw new DomainError("ASSET_REJECTED", "Provider output media kind does not match the job");
    }
    if (input.jobKind === "video" && !detectedMime.startsWith("video/")) {
      throw new DomainError("ASSET_REJECTED", "Provider output media kind does not match the job");
    }

    const assetId = randomUUID();
    const sha256 = createHash("sha256").update(fetched.body).digest("hex");
    const key = [
      input.tenantId,
      input.workspaceId,
      input.jobId,
      `${assetId}.${extensionForMime(detectedMime)}`,
    ].map(part => encodeURIComponent(part)).join("/");

    const stored = await this.objectStore.putObject({
      key,
      body: fetched.body,
      contentType: detectedMime,
      sha256,
    });

    const now = new Date();
    const asset: Asset = {
      id: assetId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      sourceJobId: input.jobId,
      kind: input.jobKind === "image" ? "generated_image" : "generated_video",
      status: "ready",
      storageBucket: stored.bucket,
      storageKey: stored.key,
      sha256,
      mimeType: detectedMime,
      byteSize: fetched.body.byteLength,
      createdAt: now,
      updatedAt: now,
    };

    const audit: Audit = {
      id: randomUUID(),
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      workspaceId: input.workspaceId,
      action: "asset.ingested",
      targetType: "asset",
      targetId: asset.id,
      requestId: input.requestId,
      metadataRedacted: { jobId: input.jobId, mimeType: detectedMime, byteSize: asset.byteSize },
      createdAt: now,
    };
    const outbox: Outbox = {
      id: randomUUID(),
      aggregateType: "job",
      aggregateId: input.jobId,
      eventType: "job.completed",
      payload: { jobId: input.jobId, assetId: asset.id },
      availableAt: now,
      createdAt: now,
    };

    await this.completionStore.completeJobWithAsset(input.jobId, asset, audit, outbox);
    return asset;
  }
}
