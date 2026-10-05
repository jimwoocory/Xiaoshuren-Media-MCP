import { randomUUID } from "node:crypto";
import { Asset, Audit, AuthContext, DomainError, IdempotencyRecord, Job, JobStatus, Outbox, ProviderAdapter, ProviderExecution, ProviderExecutionContext, ProviderStatusResult, UploadSession, Workspace, stableHash } from "@xiaoshuren/contracts";
export { DomainError } from "@xiaoshuren/contracts";

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["submitting", "cancel_requested"], submitting: ["submitted", "running", "unknown", "failed", "cancel_requested"], submitted: ["running", "succeeded", "failed", "cancel_requested"], running: ["succeeded", "failed", "cancel_requested"], unknown: ["reconciling", "cancel_requested"], reconciling: ["submitted", "running", "succeeded", "failed", "cancel_requested"], cancel_requested: ["cancelled", "succeeded", "failed"], succeeded: [], failed: [], cancelled: []
};
export const transitionJob = (from: JobStatus, to: JobStatus): JobStatus => { if (!transitions[from].includes(to)) throw new DomainError("INVALID_JOB_TRANSITION", `Cannot transition job from ${from} to ${to}`); return to; };

export type CreateJobInput = { workspaceId?: string; idempotencyKey: string; request: Record<string, unknown>; modelId: string; quoteId?: string; kind?: "image" | "video"; providerId?: string; providerModelId?: string; requestId?: string };
export type CreateJobResult = { jobId: string; status: "queued" };
export type JobStore = {
  transaction<T>(fn: (store: JobStore) => T | Promise<T>): Promise<T>;
  authorize(auth: AuthContext, workspaceId?: string): Promise<Workspace>;
  findIdempotency(auth: AuthContext, tool: string, key: string): Promise<IdempotencyRecord | undefined>;
  persistCreatedJob(job: Job, execution: ProviderExecution, outbox: Outbox, audit: Audit, record: IdempotencyRecord): Promise<IdempotencyRecord | undefined>;
  findJob(id: string): Promise<Job | undefined>;
  updateJob(job: Job): Promise<void>;
  findProviderExecution(id: string): Promise<ProviderExecution | undefined>;
  updateProviderExecution(execution: ProviderExecution): Promise<void>;
};

export type WebhookEventRecord = {
  id: string;
  providerId: string;
  providerEventId: string;
  signatureValid: boolean;
  payloadEncrypted: Uint8Array;
  receivedAt: Date;
};

export type WebhookEventStore = {
  recordWebhookEvent(event: WebhookEventRecord): Promise<boolean>;
};

export type AssetCompletionStore = {
  completeJobWithAsset(jobId: string, asset: Asset, audit: Audit, outbox: Outbox): Promise<void>;
};

export type AssetUploadStore = {
  authorize(auth: AuthContext, workspaceId?: string): Promise<Workspace>;
  createUploadSession(auth: AuthContext, asset: Asset, session: UploadSession): Promise<void>;
  findUploadSession(auth: AuthContext, sessionId: string): Promise<UploadSession | undefined>;
  findAsset(auth: AuthContext, assetId: string): Promise<Asset | undefined>;
  completeUploadSession(auth: AuthContext, sessionId: string, observed: { byteSize: number; contentType: string; sha256?: string }): Promise<Asset>;
  persistImportedAsset(auth: AuthContext, asset: Asset): Promise<void>;
};

export class InMemoryMediaStore implements JobStore {
  workspaces: Workspace[] = []; jobs: Job[] = []; providerExecutions: ProviderExecution[] = []; outbox: Outbox[] = []; audits: Audit[] = []; idempotency: IdempotencyRecord[] = []; private members = new Map<string, Set<string>>();
  addWorkspace(workspace: Workspace, subjects: string[]) { this.workspaces.push(workspace); this.members.set(workspace.id, new Set(subjects)); }
  async transaction<T>(fn: (store: JobStore) => T | Promise<T>): Promise<T> { const snapshot = structuredClone({ jobs: this.jobs, providerExecutions: this.providerExecutions, outbox: this.outbox, audits: this.audits, idempotency: this.idempotency }); try { return await fn(this); } catch (error) { this.jobs = snapshot.jobs; this.providerExecutions = snapshot.providerExecutions; this.outbox = snapshot.outbox; this.audits = snapshot.audits; this.idempotency = snapshot.idempotency; throw error; } }
  async authorize(auth: AuthContext, workspaceId?: string): Promise<Workspace> { const id = workspaceId ?? auth.defaultWorkspaceId; const workspace = this.workspaces.find(w => w.id === id && w.tenantId === auth.tenantId && w.status === "active" && this.members.get(w.id)?.has(auth.subjectId)); if (!workspace) throw new DomainError("NOT_FOUND", "Resource not found"); return workspace; }
  async findIdempotency(auth: AuthContext, tool: string, key: string): Promise<IdempotencyRecord | undefined> { return this.idempotency.find(r => r.tenantId === auth.tenantId && r.subjectId === auth.subjectId && r.toolName === tool && r.idempotencyKey === key); }
  async persistCreatedJob(job: Job, execution: ProviderExecution, outbox: Outbox, audit: Audit, record: IdempotencyRecord): Promise<IdempotencyRecord | undefined> { const existing = this.idempotency.find(candidate => candidate.tenantId === record.tenantId && candidate.subjectId === record.subjectId && candidate.toolName === record.toolName && candidate.idempotencyKey === record.idempotencyKey); if (existing) return existing; this.jobs.push(job); this.providerExecutions.push(execution); this.outbox.push(outbox); this.audits.push(audit); this.idempotency.push(record); return undefined; }
  async findJob(id: string): Promise<Job | undefined> { return this.jobs.find(j => j.id === id); } async updateJob(job: Job): Promise<void> { const i = this.jobs.findIndex(j => j.id === job.id); if (i < 0) throw new DomainError("NOT_FOUND", "Resource not found"); this.jobs[i] = job; }
  async findProviderExecution(id: string): Promise<ProviderExecution | undefined> { return this.providerExecutions.find(execution => execution.id === id); }
  async updateProviderExecution(execution: ProviderExecution): Promise<void> { const i = this.providerExecutions.findIndex(candidate => candidate.id === execution.id); if (i < 0) throw new DomainError("NOT_FOUND", "Resource not found"); this.providerExecutions[i] = execution; }
}

export class JobService {
  constructor(private readonly store: JobStore) {}
  async create(auth: AuthContext, input: CreateJobInput): Promise<CreateJobResult> { return this.store.transaction(async store => { if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) throw new DomainError("VALIDATION_ERROR", "idempotency key must be 16..128 characters"); const workspace = await store.authorize(auth, input.workspaceId); const requestHash = stableHash({ workspaceId: workspace.id, modelId: input.modelId, request: input.request }); const existing = await store.findIdempotency(auth, "generate", input.idempotencyKey); if (existing) { if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for another request"); return existing.responseSnapshot as CreateJobResult; } const now = new Date(); const jobId = randomUUID(); const result: CreateJobResult = { jobId, status: "queued" }; const job: Job = { id: jobId, tenantId: auth.tenantId, subjectId: auth.subjectId, workspaceId: workspace.id, quoteId: input.quoteId, kind: input.kind ?? "image", publicModelId: input.modelId, requestHash, frozenRequest: input.request, status: "queued", version: 1, createdAt: now, updatedAt: now }; const execution: ProviderExecution = { id: randomUUID(), jobId, providerId: input.providerId ?? "fake", providerModelId: input.providerModelId ?? input.modelId, providerRequestKey: randomUUID(), status: "queued", submissionAttempts: 0, createdAt: now, updatedAt: now }; const outbox: Outbox = { id: randomUUID(), aggregateType: "job", aggregateId: jobId, eventType: "job.submit.requested", payload: { jobId, providerExecutionId: execution.id }, availableAt: now, createdAt: now }; const audit: Audit = { id: randomUUID(), tenantId: auth.tenantId, subjectId: auth.subjectId, workspaceId: workspace.id, action: "job.created", targetType: "job", targetId: jobId, requestId: input.requestId ?? randomUUID(), metadataRedacted: { kind: job.kind, publicModelId: job.publicModelId }, createdAt: now }; const record: IdempotencyRecord = { id: randomUUID(), tenantId: auth.tenantId, subjectId: auth.subjectId, toolName: "generate", idempotencyKey: input.idempotencyKey, requestHash, responseSnapshot: result, resourceType: "job", resourceId: jobId, createdAt: now }; const concurrentRecord = await store.persistCreatedJob(job, execution, outbox, audit, record); if (concurrentRecord) { if (concurrentRecord.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for another request"); return concurrentRecord.responseSnapshot as CreateJobResult; } return result; }); }
}

export class ProviderExecutionService {
  constructor(private readonly store: JobStore, private readonly provider: ProviderAdapter) {}

  async submit(ctx: ProviderExecutionContext, request: Record<string, unknown>): Promise<void> {
    const job = await this.store.findJob(ctx.jobId);
    if (!job) throw new DomainError("NOT_FOUND", "Resource not found");
    const execution = await this.store.findProviderExecution(ctx.providerExecutionId);
    if (!execution || execution.jobId !== ctx.jobId) throw new DomainError("NOT_FOUND", "Resource not found");
    if (job.status === "unknown" || job.status === "reconciling") {
      throw new DomainError("PROVIDER_SUBMISSION_UNKNOWN", "Unknown provider submission must be reconciled, not re-submitted");
    }

    job.status = transitionJob(job.status, "submitting");
    await this.store.updateJob(job);
    execution.submissionAttempts += 1;
    execution.updatedAt = new Date();
    await this.store.updateProviderExecution(execution);

    try {
      const result = await this.provider.submit(ctx, request);
      execution.providerJobId = result.providerJobId;
      execution.status = result.status === "submitted" ? "queued" : result.status;
      execution.updatedAt = new Date();
      await this.store.updateProviderExecution(execution);
      job.status = result.status === "unknown"
        ? transitionJob(transitionJob(job.status, "unknown"), "reconciling")
        : transitionJob(job.status, result.status);
      await this.store.updateJob(job);
    } catch (error) {
      const normalized = this.provider.normalizeError(error);
      if (normalized.code === "PROVIDER_SUBMISSION_UNKNOWN") {
        execution.status = "unknown";
        execution.updatedAt = new Date();
        await this.store.updateProviderExecution(execution);
        job.status = transitionJob(transitionJob(job.status, "unknown"), "reconciling");
        await this.store.updateJob(job);
        throw new DomainError("PROVIDER_SUBMISSION_UNKNOWN", normalized.message, true);
      }
      execution.status = "failed";
      execution.updatedAt = new Date();
      await this.store.updateProviderExecution(execution);
      job.status = transitionJob(job.status, "failed");
      job.updatedAt = new Date();
      job.version += 1;
      await this.store.updateJob(job);
      throw new DomainError(normalized.code, normalized.message, normalized.retryable);
    }
  }

  async reconcile(ctx: ProviderExecutionContext, providerJobId: string): Promise<ProviderStatusResult> {
    const job = await this.store.findJob(ctx.jobId);
    if (!job || job.status !== "reconciling") {
      throw new DomainError("INVALID_JOB_TRANSITION", "Only reconciling jobs can be reconciled");
    }
    return this.observe(ctx, providerJobId);
  }

  async observe(ctx: ProviderExecutionContext, providerJobId: string): Promise<ProviderStatusResult> {
    const job = await this.store.findJob(ctx.jobId);
    if (!job) throw new DomainError("NOT_FOUND", "Resource not found");

    const observation = await this.provider.getStatus(ctx, providerJobId);
    const execution = await this.store.findProviderExecution(ctx.providerExecutionId);
    if (execution && execution.jobId === ctx.jobId) {
      execution.providerJobId = providerJobId;
      execution.status = observation.status;
      execution.updatedAt = new Date();
      await this.store.updateProviderExecution(execution);
    }
    let target = job.status;

    if (observation.status === "queued") {
      if (job.status === "reconciling") target = "submitted";
    } else if (observation.status === "running" || observation.status === "succeeded") {
      if (job.status === "submitted" || job.status === "reconciling") target = "running";
    } else if (observation.status === "failed") {
      target = "failed";
    } else if (observation.status === "cancelled") {
      target = job.status === "cancel_requested" ? "cancelled" : "failed";
    }

    if (target !== job.status) {
      job.status = transitionJob(job.status, target);
      job.updatedAt = new Date();
      job.version += 1;
      await this.store.updateJob(job);
    }

    return observation;
  }
}
