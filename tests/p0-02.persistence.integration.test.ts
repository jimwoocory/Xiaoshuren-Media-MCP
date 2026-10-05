import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../packages/fake-provider/src/index.js";
import { JobService, ProviderExecutionService } from "../packages/media-core/src/index.js";
import { PostgresJobRepository, migrate } from "../packages/persistence/src/index.js";
import { MemoryObjectStore } from "../packages/storage/src/index.js";
import { AssetIngestService } from "../packages/workers/src/index.js";

const auth = { tenantId: "tenant-a", subjectId: "subject-a", clientId: "test", scopes: [] };

const createDatabase = async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  await pool.query("INSERT INTO workspaces(id, tenant_id, name, status) VALUES ('ws-a','tenant-a','A','active')");
  await pool.query("INSERT INTO workspace_members(workspace_id, subject_id) VALUES ('ws-a','subject-a')");
  return pool;
};

describe("P0-02 PostgreSQL integration", () => {
  it("deduplicates webhook events with the database unique constraint", async () => {
    const pool = await createDatabase();
    const repo = new PostgresJobRepository(pool);
    const event = {
      id: "wh-1",
      providerId: "fake",
      providerEventId: "evt-1",
      signatureValid: true,
      payloadEncrypted: new Uint8Array([1, 2, 3]),
      receivedAt: new Date(),
    };

    await expect(repo.recordWebhookEvent(event)).resolves.toBe(true);
    await expect(repo.recordWebhookEvent({ ...event, id: "wh-2" })).resolves.toBe(false);
    expect((await pool.query("SELECT * FROM webhook_events")).rowCount).toBe(1);
  });

  it("only marks a provider job succeeded after its output is archived as an Asset", async () => {
    const pool = await createDatabase();
    const repo = new PostgresJobRepository(pool);
    const created = await new JobService(repo).create(auth, {
      workspaceId: "ws-a",
      idempotencyKey: "p".repeat(16),
      request: { prompt: "kite" },
      modelId: "image-v1",
    });

    const provider = new FakeProvider();
    const execution = new ProviderExecutionService(repo, provider);
    const executionRow = (await pool.query("SELECT id,provider_request_key,provider_model_id FROM provider_executions WHERE job_id=$1", [created.jobId])).rows[0];
    await execution.submit({
      tenantId: "tenant-a",
      workspaceId: "ws-a",
      jobId: created.jobId,
      providerExecutionId: executionRow.id,
      providerRequestKey: executionRow.provider_request_key,
      providerModelId: executionRow.provider_model_id,
    }, { scenario: "success" });

    expect((await repo.findJob(created.jobId))?.status).toBe("submitted");

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const objectStore = new MemoryObjectStore();
    const ingester = new AssetIngestService(
      { async fetch() { return { sourceUrl: "https://cdn.example.com/out.png", body: png, mimeType: "image/png" }; } },
      objectStore,
      repo,
    );

    const asset = await ingester.ingest({
      tenantId: "tenant-a",
      subjectId: "subject-a",
      workspaceId: "ws-a",
      jobId: created.jobId,
      jobKind: "image",
      requestId: "req-1",
      outputUrl: "https://cdn.example.com/out.png",
    });

    expect(asset.status).toBe("ready");
    expect((await repo.findJob(created.jobId))?.status).toBe("succeeded");
    expect((await pool.query("SELECT * FROM assets WHERE source_job_id=$1", [created.jobId])).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM audit_logs WHERE action='asset.ingested'")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM outbox_events WHERE event_type='job.completed'")).rowCount).toBe(1);
  });
});
