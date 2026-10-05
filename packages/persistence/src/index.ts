import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, PoolClient } from "pg";
import { Asset, Audit, AuthContext, DomainError, IdempotencyRecord, Job, Outbox, ProviderExecution, UploadSession, Workspace } from "@xiaoshuren/contracts";
import { AssetCompletionStore, AssetUploadStore, JobStore, WebhookEventRecord, WebhookEventStore, transitionJob } from "@xiaoshuren/media-core";

export const migrate = async (pool: Pick<Pool, "query">): Promise<void> => {
  const migrationsDir = join(import.meta.dirname, "migrations");
  const files = (await readdir(migrationsDir))
    .filter(file => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    for (const statement of sql.split(";\n").map(s => s.trim()).filter(Boolean)) {
      await pool.query(statement);
    }
  }
};

export class PostgresJobRepository implements JobStore, WebhookEventStore, AssetCompletionStore, AssetUploadStore {
  constructor(private readonly pool: Pool, private readonly client?: PoolClient) {}

  private q(sql: string, values: unknown[] = []) { return (this.client ?? this.pool).query(sql, values); }

  async transaction<T>(fn: (store: JobStore) => T | Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    const transactionalStore = new PostgresJobRepository(this.pool, client);
    try {
      await client.query("BEGIN");
      const value = await fn(transactionalStore);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async authorize(auth: AuthContext, workspaceId?: string): Promise<Workspace> {
    const result = await this.q(
      "SELECT w.id, w.tenant_id, w.name, w.status FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE w.id=$1 AND w.tenant_id=$2 AND m.subject_id=$3 AND w.status='active'",
      [workspaceId ?? auth.defaultWorkspaceId, auth.tenantId, auth.subjectId],
    );
    if (!result.rowCount) throw new DomainError("NOT_FOUND", "Resource not found");
    const row = result.rows[0];
    return { id: row.id, tenantId: row.tenant_id, name: row.name, status: row.status };
  }

  async findIdempotency(auth: AuthContext, tool: string, key: string): Promise<IdempotencyRecord | undefined> {
    const result = await this.q(
      "SELECT id, tenant_id, subject_id, tool_name, idempotency_key, request_hash, response_snapshot_json, resource_type, resource_id, created_at FROM idempotency_records WHERE tenant_id=$1 AND subject_id=$2 AND tool_name=$3 AND idempotency_key=$4",
      [auth.tenantId, auth.subjectId, tool, key],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return { id: row.id, tenantId: row.tenant_id, subjectId: row.subject_id, toolName: row.tool_name, idempotencyKey: row.idempotency_key, requestHash: row.request_hash, responseSnapshot: row.response_snapshot_json, resourceType: row.resource_type, resourceId: row.resource_id, createdAt: row.created_at };
  }

  async persistCreatedJob(job: Job, execution: ProviderExecution, outbox: Outbox, audit: Audit, record: IdempotencyRecord): Promise<IdempotencyRecord | undefined> {
    await this.q("INSERT INTO idempotency_records(id,tenant_id,subject_id,tool_name,idempotency_key,request_hash,response_snapshot_json,resource_type,resource_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id,subject_id,tool_name,idempotency_key) DO NOTHING", [record.id, record.tenantId, record.subjectId, record.toolName, record.idempotencyKey, record.requestHash, record.responseSnapshot, record.resourceType, record.resourceId, record.createdAt]);
    const persistedRecord = await this.findIdempotency({ tenantId: record.tenantId, subjectId: record.subjectId, clientId: "internal", scopes: [] }, record.toolName, record.idempotencyKey);
    if (!persistedRecord) throw new DomainError("INTERNAL_ERROR", "Idempotency record could not be persisted");
    if (persistedRecord.id !== record.id) return persistedRecord;
    await this.q("INSERT INTO jobs(id,tenant_id,subject_id,workspace_id,quote_id,kind,public_model_id,request_hash,frozen_request_json,status,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [job.id, job.tenantId, job.subjectId, job.workspaceId, job.quoteId ?? null, job.kind, job.publicModelId, job.requestHash, job.frozenRequest, job.status, job.version, job.createdAt, job.updatedAt]);
    await this.q("INSERT INTO provider_executions(id,job_id,provider_id,provider_model_id,provider_request_key,provider_job_id,status,submission_attempts,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [execution.id, execution.jobId, execution.providerId, execution.providerModelId, execution.providerRequestKey, execution.providerJobId ?? null, execution.status, execution.submissionAttempts, execution.createdAt, execution.updatedAt]);
    await this.q("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload_json,available_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [outbox.id, outbox.aggregateType, outbox.aggregateId, outbox.eventType, outbox.payload, outbox.availableAt, outbox.createdAt]);
    await this.q("INSERT INTO audit_logs(id,tenant_id,subject_id,workspace_id,action,target_type,target_id,request_id,metadata_redacted_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [audit.id, audit.tenantId, audit.subjectId, audit.workspaceId, audit.action, audit.targetType, audit.targetId, audit.requestId, audit.metadataRedacted, audit.createdAt]);
    return undefined;
  }

  async findJob(id: string): Promise<Job | undefined> {
    const result = await this.q("SELECT id, tenant_id, subject_id, workspace_id, quote_id, kind, public_model_id, request_hash, frozen_request_json, status, version, created_at, updated_at FROM jobs WHERE id=$1", [id]);
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return { id: row.id, tenantId: row.tenant_id, subjectId: row.subject_id, workspaceId: row.workspace_id, quoteId: row.quote_id ?? undefined, kind: row.kind, publicModelId: row.public_model_id, requestHash: row.request_hash, frozenRequest: row.frozen_request_json, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async updateJob(job: Job): Promise<void> {
    const result = await this.q("UPDATE jobs SET status=$1, version=$2, updated_at=$3 WHERE id=$4", [job.status, job.version, job.updatedAt, job.id]);
    if (!result.rowCount) throw new DomainError("NOT_FOUND", "Resource not found");
  }

  async findProviderExecution(id: string): Promise<ProviderExecution | undefined> {
    const result = await this.q(
      "SELECT id,job_id,provider_id,provider_model_id,provider_request_key,provider_job_id,status,submission_attempts,created_at,updated_at FROM provider_executions WHERE id=$1",
      [id],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return {
      id: row.id,
      jobId: row.job_id,
      providerId: row.provider_id,
      providerModelId: row.provider_model_id,
      providerRequestKey: row.provider_request_key,
      providerJobId: row.provider_job_id ?? undefined,
      status: row.status,
      submissionAttempts: row.submission_attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async updateProviderExecution(execution: ProviderExecution): Promise<void> {
    const result = await this.q(
      "UPDATE provider_executions SET provider_job_id=$1,status=$2,submission_attempts=$3,updated_at=$4 WHERE id=$5",
      [execution.providerJobId ?? null, execution.status, execution.submissionAttempts, execution.updatedAt, execution.id],
    );
    if (!result.rowCount) throw new DomainError("NOT_FOUND", "Resource not found");
  }

  async recordWebhookEvent(event: WebhookEventRecord): Promise<boolean> {
    await this.q(
      "INSERT INTO webhook_events(id,provider_id,provider_event_id,signature_valid,payload_encrypted,received_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider_id,provider_event_id) DO NOTHING",
      [event.id, event.providerId, event.providerEventId, event.signatureValid, Buffer.from(event.payloadEncrypted), event.receivedAt],
    );
    const result = await this.q(
      "SELECT id FROM webhook_events WHERE provider_id=$1 AND provider_event_id=$2",
      [event.providerId, event.providerEventId],
    );
    return result.rows[0]?.id === event.id;
  }

  async completeJobWithAsset(jobId: string, asset: Asset, audit: Audit, outbox: Outbox): Promise<void> {
    await this.transaction(async store => {
      const repo = store as PostgresJobRepository;
      const job = await repo.findJob(jobId);
      if (!job) throw new DomainError("NOT_FOUND", "Resource not found");

      job.status = transitionJob(job.status, "succeeded");
      job.version += 1;
      job.updatedAt = new Date();

      await repo.q(
        "INSERT INTO assets(id,tenant_id,workspace_id,source_job_id,kind,status,storage_bucket,storage_key,sha256,mime_type,byte_size,metadata_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          asset.id,
          asset.tenantId,
          asset.workspaceId,
          asset.sourceJobId ?? jobId,
          asset.kind,
          asset.status,
          asset.storageBucket ?? null,
          asset.storageKey ?? null,
          asset.sha256 ?? null,
          asset.mimeType ?? null,
          asset.byteSize ?? null,
          {},
          asset.createdAt,
          asset.updatedAt,
        ],
      );
      await repo.updateJob(job);
      await repo.q(
        "INSERT INTO audit_logs(id,tenant_id,subject_id,workspace_id,action,target_type,target_id,request_id,metadata_redacted_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [audit.id, audit.tenantId, audit.subjectId, audit.workspaceId, audit.action, audit.targetType, audit.targetId, audit.requestId, audit.metadataRedacted, audit.createdAt],
      );
      await repo.q(
        "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload_json,available_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [outbox.id, outbox.aggregateType, outbox.aggregateId, outbox.eventType, outbox.payload, outbox.availableAt, outbox.createdAt],
      );
    });
  }

  async createUploadSession(auth: AuthContext, asset: Asset, session: UploadSession): Promise<void> {
    await this.transaction(async store => {
      const repo = store as PostgresJobRepository;
      await repo.authorize(auth, session.workspaceId);
      if (
        session.tenantId !== auth.tenantId ||
        session.subjectId !== auth.subjectId ||
        asset.tenantId !== auth.tenantId ||
        asset.workspaceId !== session.workspaceId ||
        asset.id !== session.assetId
      ) {
        throw new DomainError("NOT_FOUND", "Resource not found");
      }

      await repo.q(
        "INSERT INTO assets(id,tenant_id,workspace_id,source_job_id,kind,status,storage_bucket,storage_key,sha256,mime_type,byte_size,metadata_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          asset.id,
          asset.tenantId,
          asset.workspaceId,
          asset.sourceJobId ?? null,
          asset.kind,
          asset.status,
          asset.storageBucket ?? null,
          asset.storageKey ?? null,
          asset.sha256 ?? null,
          asset.mimeType ?? null,
          asset.byteSize ?? null,
          {},
          asset.createdAt,
          asset.updatedAt,
        ],
      );
      await repo.q(
        "INSERT INTO upload_sessions(id,tenant_id,subject_id,workspace_id,asset_id,storage_key,mime_type,expected_byte_size,status,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          session.id,
          session.tenantId,
          session.subjectId,
          session.workspaceId,
          session.assetId,
          session.storageKey,
          session.mimeType,
          session.expectedByteSize,
          session.status,
          session.expiresAt,
          session.createdAt,
        ],
      );
    });
  }

  async findUploadSession(auth: AuthContext, sessionId: string): Promise<UploadSession | undefined> {
    const result = await this.q(
      "SELECT s.id,s.tenant_id,s.subject_id,s.workspace_id,s.asset_id,s.storage_key,s.mime_type,s.expected_byte_size,s.status,s.expires_at,s.created_at,s.completed_at FROM upload_sessions s JOIN workspace_members m ON m.workspace_id=s.workspace_id WHERE s.id=$1 AND s.tenant_id=$2 AND s.subject_id=$3 AND m.subject_id=$3",
      [sessionId, auth.tenantId, auth.subjectId],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      subjectId: row.subject_id,
      workspaceId: row.workspace_id,
      assetId: row.asset_id,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      expectedByteSize: Number(row.expected_byte_size),
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
    };
  }

  async findAsset(auth: AuthContext, assetId: string): Promise<Asset | undefined> {
    const result = await this.q(
      "SELECT a.id,a.tenant_id,a.workspace_id,a.source_job_id,a.kind,a.status,a.storage_bucket,a.storage_key,a.sha256,a.mime_type,a.byte_size,a.created_at,a.updated_at FROM assets a JOIN workspace_members m ON m.workspace_id=a.workspace_id WHERE a.id=$1 AND a.tenant_id=$2 AND m.subject_id=$3",
      [assetId, auth.tenantId, auth.subjectId],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      sourceJobId: row.source_job_id ?? undefined,
      kind: row.kind,
      status: row.status,
      storageBucket: row.storage_bucket ?? undefined,
      storageKey: row.storage_key ?? undefined,
      sha256: row.sha256 ?? undefined,
      mimeType: row.mime_type ?? undefined,
      byteSize: row.byte_size == null ? undefined : Number(row.byte_size),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async completeUploadSession(
    auth: AuthContext,
    sessionId: string,
    observed: { byteSize: number; contentType: string; sha256?: string },
  ): Promise<Asset> {
    return this.transaction(async store => {
      const repo = store as PostgresJobRepository;
      const session = await repo.findUploadSession(auth, sessionId);
      if (!session) throw new DomainError("NOT_FOUND", "Resource not found");
      if (session.status !== "pending") throw new DomainError("ASSET_NOT_READY", "Upload session is not pending");

      const now = new Date();
      await repo.q(
        "UPDATE assets SET status='ready',byte_size=$1,mime_type=$2,sha256=$3,updated_at=$4 WHERE id=$5 AND tenant_id=$6 AND workspace_id=$7",
        [observed.byteSize, observed.contentType, observed.sha256 ?? null, now, session.assetId, auth.tenantId, session.workspaceId],
      );
      await repo.q(
        "UPDATE upload_sessions SET status='completed',completed_at=$1 WHERE id=$2",
        [now, session.id],
      );

      const result = await repo.q(
        "SELECT id,tenant_id,workspace_id,source_job_id,kind,status,storage_bucket,storage_key,sha256,mime_type,byte_size,created_at,updated_at FROM assets WHERE id=$1",
        [session.assetId],
      );
      if (!result.rowCount) throw new DomainError("NOT_FOUND", "Resource not found");
      const row = result.rows[0];
      return {
        id: row.id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        sourceJobId: row.source_job_id ?? undefined,
        kind: row.kind,
        status: row.status,
        storageBucket: row.storage_bucket ?? undefined,
        storageKey: row.storage_key ?? undefined,
        sha256: row.sha256 ?? undefined,
        mimeType: row.mime_type ?? undefined,
        byteSize: row.byte_size == null ? undefined : Number(row.byte_size),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async persistImportedAsset(auth: AuthContext, asset: Asset): Promise<void> {
    await this.transaction(async store => {
      const repo = store as PostgresJobRepository;
      await repo.authorize(auth, asset.workspaceId);
      if (asset.tenantId !== auth.tenantId) throw new DomainError("NOT_FOUND", "Resource not found");
      await repo.q(
        "INSERT INTO assets(id,tenant_id,workspace_id,source_job_id,kind,status,storage_bucket,storage_key,sha256,mime_type,byte_size,metadata_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          asset.id,
          asset.tenantId,
          asset.workspaceId,
          asset.sourceJobId ?? null,
          asset.kind,
          asset.status,
          asset.storageBucket ?? null,
          asset.storageKey ?? null,
          asset.sha256 ?? null,
          asset.mimeType ?? null,
          asset.byteSize ?? null,
          {},
          asset.createdAt,
          asset.updatedAt,
        ],
      );
    });
  }
}
