import { createHash } from "node:crypto";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import {
  AssetReadService,
  AssetUploadService,
  InlineAssetService,
  UrlImportService,
} from "../packages/asset-service/src/index.js";
import {
  GenerationService,
  IdempotencyService,
  InMemoryMediaStore,
  JobAccessService,
  JobService,
  ModelCatalogService,
  QuoteService,
} from "../packages/media-core/src/index.js";
import { PostgresJobRepository, migrate } from "../packages/persistence/src/index.js";
import { MemoryObjectStore } from "../packages/storage/src/index.js";
import { CoreMediaMcpBackend } from "../apps/mcp-server/src/index.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const auth = {
  tenantId: "tenant-a",
  subjectId: "subject-a",
  clientId: "claude-client",
  scopes: ["media.assets.read", "media.assets.write"],
  defaultWorkspaceId: "ws-a",
};

const createAssetRepo = async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  await pool.query("INSERT INTO workspaces(id, tenant_id, name, status) VALUES ('ws-a','tenant-a','A','active')");
  await pool.query("INSERT INTO workspace_members(workspace_id, subject_id) VALUES ('ws-a','subject-a')");
  return { pool, repo: new PostgresJobRepository(pool) };
};

const dummyCore = () => {
  const store = new InMemoryMediaStore();
  store.addWorkspace({ id: "ws-a", tenantId: "tenant-a", name: "A", status: "active" }, ["subject-a"]);
  const catalog = new ModelCatalogService([]);
  const quotes = new QuoteService(store, catalog, () => ({ currency: "USD", amountMinor: 0 }));
  return {
    catalog,
    quotes,
    generation: new GenerationService(quotes, new JobService(store)),
    jobs: new JobAccessService(store),
  };
};

describe("P0-03 Asset MCP backend", () => {
  it("creates an upload session, confirms by asset_id, and returns a short-lived read URL", async () => {
    const { pool, repo } = await createAssetRepo();
    const objectStore = new MemoryObjectStore();
    const upload = new AssetUploadService(repo, objectStore);
    const urlImport = new UrlImportService(
      repo,
      { async fetch(sourceUrl) { return { sourceUrl, body: png, mimeType: "image/png" }; } },
      objectStore,
    );
    const inline = new InlineAssetService(repo, objectStore);
    const read = new AssetReadService(repo, objectStore);
    const backend = new CoreMediaMcpBackend(auth, {
      ...dummyCore(),
      idempotency: new IdempotencyService(repo),
      assets: { upload, urlImport, inline, read },
    });

    const created = await backend.call("asset_create_upload", {
      idempotency_key: "asset-create-1234",
      source: {
        kind: "upload_session",
        filename: "input.png",
        mime_type: "image/png",
        byte_size: png.byteLength,
      },
    });
    expect(created.status).toBe("pending_upload");
    expect(String((created.upload as Record<string, unknown>).put_url)).toContain("memory.invalid/upload");

    const replay = await backend.call("asset_create_upload", {
      idempotency_key: "asset-create-1234",
      source: {
        kind: "upload_session",
        filename: "input.png",
        mime_type: "image/png",
        byte_size: png.byteLength,
      },
    });
    expect(replay).toEqual(created);
    expect((await pool.query("SELECT count(*)::int AS count FROM upload_sessions")).rows[0].count).toBe(1);

    await expect(backend.call("asset_create_upload", {
      idempotency_key: "asset-create-1234",
      source: {
        kind: "upload_session",
        filename: "input.png",
        mime_type: "image/png",
        byte_size: png.byteLength + 1,
      },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const session = await repo.findUploadSessionByAsset(auth, String(created.asset_id));
    expect(session).toBeDefined();
    await objectStore.putObject({
      key: session!.storageKey,
      body: png,
      contentType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
    });

    const confirmed = await backend.call("asset_confirm", {
      idempotency_key: "asset-confirm-123",
      asset_id: created.asset_id,
    });
    expect(confirmed).toEqual({
      asset_id: created.asset_id,
      status: "ready",
    });

    const confirmReplay = await backend.call("asset_confirm", {
      idempotency_key: "asset-confirm-123",
      asset_id: created.asset_id,
    });
    expect(confirmReplay).toEqual(confirmed);

    const fetched = await backend.call("asset_get", {
      asset_id: created.asset_id,
      include_access_url: true,
    });
    expect(fetched).toMatchObject({
      asset_id: created.asset_id,
      kind: "input",
      status: "ready",
      mime_type: "image/png",
      byte_size: png.byteLength,
    });
    expect(String(fetched.access_url)).toContain("memory.invalid/read");
  });

  it("ingests inline base64 through signature validation and private storage", async () => {
    const { repo } = await createAssetRepo();
    const objectStore = new MemoryObjectStore();
    const upload = new AssetUploadService(repo, objectStore);
    const urlImport = new UrlImportService(
      repo,
      { async fetch(sourceUrl) { return { sourceUrl, body: png, mimeType: "image/png" }; } },
      objectStore,
    );
    const inline = new InlineAssetService(repo, objectStore);
    const read = new AssetReadService(repo, objectStore);
    const backend = new CoreMediaMcpBackend(auth, {
      ...dummyCore(),
      idempotency: new IdempotencyService(repo),
      assets: { upload, urlImport, inline, read },
    });

    const created = await backend.call("asset_create_upload", {
      idempotency_key: "asset-inline-1234",
      source: {
        kind: "inline_base64",
        filename: "inline.png",
        mime_type: "image/png",
        base64: Buffer.from(png).toString("base64"),
      },
    });
    expect(created.status).toBe("processing");

    const fetched = await backend.call("asset_get", {
      asset_id: created.asset_id,
    });
    expect(fetched).toMatchObject({
      asset_id: created.asset_id,
      status: "ready",
      mime_type: "image/png",
    });
  });

  it("keeps unauthorized assets invisible", async () => {
    const { pool, repo } = await createAssetRepo();
    const objectStore = new MemoryObjectStore();
    const inline = new InlineAssetService(repo, objectStore);
    const asset = await inline.create(auth, {
      workspaceId: "ws-a",
      filename: "secret.png",
      mimeType: "image/png",
      base64: Buffer.from(png).toString("base64"),
    });

    const upload = new AssetUploadService(repo, objectStore);
    const urlImport = new UrlImportService(
      repo,
      { async fetch(sourceUrl) { return { sourceUrl, body: png, mimeType: "image/png" }; } },
      objectStore,
    );
    const read = new AssetReadService(repo, objectStore);
    const backend = new CoreMediaMcpBackend(
      { ...auth, subjectId: "subject-x" },
      {
        ...dummyCore(),
        idempotency: new IdempotencyService(repo),
        assets: { upload, urlImport, inline, read },
      },
    );

    await expect(backend.call("asset_get", {
      asset_id: asset.id,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns generated output Asset ids from job_get", async () => {
    const { pool, repo } = await createAssetRepo();
    const now = new Date();
    await pool.query(
      "INSERT INTO jobs(id,tenant_id,subject_id,workspace_id,quote_id,kind,public_model_id,request_hash,frozen_request_json,status,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      ["job-output", "tenant-a", "subject-a", "ws-a", null, "video", "seedance2.0mini", "hash", {}, "succeeded", 1, now, now],
    );
    await pool.query(
      "INSERT INTO assets(id,tenant_id,workspace_id,source_job_id,kind,status,storage_bucket,storage_key,sha256,mime_type,byte_size,metadata_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      ["asset-output", "tenant-a", "ws-a", "job-output", "generated_video", "ready", "memory", "outputs/video.mp4", "sha", "video/mp4", 123, {}, now, now],
    );

    const objectStore = new MemoryObjectStore();
    const upload = new AssetUploadService(repo, objectStore);
    const urlImport = new UrlImportService(
      repo,
      { async fetch(sourceUrl) { return { sourceUrl, body: png, mimeType: "image/png" }; } },
      objectStore,
    );
    const inline = new InlineAssetService(repo, objectStore);
    const read = new AssetReadService(repo, objectStore);
    const backend = new CoreMediaMcpBackend(auth, {
      ...dummyCore(),
      jobs: new JobAccessService(repo),
      idempotency: new IdempotencyService(repo),
      assets: { upload, urlImport, inline, read },
    });

    const result = await backend.call("job_get", { job_id: "job-output" });
    expect(result.output_asset_ids).toEqual(["asset-output"]);
  });
});
