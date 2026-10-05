import { createHash } from "node:crypto";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { AssetUploadService, UrlImportService } from "../packages/asset-service/src/index.js";
import { PostgresJobRepository, migrate } from "../packages/persistence/src/index.js";
import { MemoryObjectStore } from "../packages/storage/src/index.js";

const auth = { tenantId: "tenant-a", subjectId: "subject-a", clientId: "test", scopes: [] };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const createDatabase = async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  await pool.query("INSERT INTO workspaces(id, tenant_id, name, status) VALUES ('ws-a','tenant-a','A','active')");
  await pool.query("INSERT INTO workspace_members(workspace_id, subject_id) VALUES ('ws-a','subject-a')");
  return pool;
};

describe("P0-02 upload sessions", () => {
  it("creates a presigned upload session and only confirms after object storage has the matching object", async () => {
    const pool = await createDatabase();
    const repo = new PostgresJobRepository(pool);
    const objectStore = new MemoryObjectStore();
    const service = new AssetUploadService(repo, objectStore);

    const created = await service.create(auth, {
      workspaceId: "ws-a",
      mimeType: "image/png",
      byteSize: png.byteLength,
    });

    expect(created.upload.method).toBe("PUT");
    expect(created.upload.url).toContain("https://memory.invalid/upload/");
    expect((await pool.query("SELECT status FROM assets WHERE id=$1", [created.assetId])).rows[0].status).toBe("pending_upload");
    expect((await pool.query("SELECT status FROM upload_sessions WHERE id=$1", [created.sessionId])).rows[0].status).toBe("pending");

    await expect(service.confirm(auth, created.sessionId)).rejects.toMatchObject({ code: "ASSET_NOT_READY" });

    const session = await repo.findUploadSession(auth, created.sessionId);
    expect(session).toBeDefined();
    const sha256 = createHash("sha256").update(png).digest("hex");
    await objectStore.putObject({
      key: session!.storageKey,
      body: png,
      contentType: "image/png",
      sha256,
    });

    const confirmed = await service.confirm(auth, created.sessionId);
    expect(confirmed).toMatchObject({
      id: created.assetId,
      status: "ready",
      mimeType: "image/png",
      byteSize: png.byteLength,
      sha256,
    });
    await expect(service.confirm(auth, created.sessionId)).resolves.toMatchObject({
      id: created.assetId,
      status: "ready",
    });
    expect((await pool.query("SELECT status FROM upload_sessions WHERE id=$1", [created.sessionId])).rows[0].status).toBe("completed");
  });

  it("rejects confirmation from another subject and rejects mismatched uploaded metadata", async () => {
    const pool = await createDatabase();
    await pool.query("INSERT INTO workspace_members(workspace_id, subject_id) VALUES ('ws-a','subject-b')");
    const repo = new PostgresJobRepository(pool);
    const objectStore = new MemoryObjectStore();
    const service = new AssetUploadService(repo, objectStore);
    const created = await service.create(auth, {
      workspaceId: "ws-a",
      mimeType: "image/png",
      byteSize: png.byteLength,
    });
    const session = await repo.findUploadSession(auth, created.sessionId);
    await objectStore.putObject({
      key: session!.storageKey,
      body: png,
      contentType: "video/mp4",
      sha256: "mismatch",
    });

    await expect(service.confirm({ ...auth, subjectId: "subject-b" }, created.sessionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.confirm(auth, created.sessionId)).rejects.toMatchObject({ code: "ASSET_REJECTED" });
  });
});

describe("P0-02 URL import service", () => {
  it("archives validated URL media into private storage and persists a ready input Asset", async () => {
    const pool = await createDatabase();
    const repo = new PostgresJobRepository(pool);
    const objectStore = new MemoryObjectStore();
    const service = new UrlImportService(
      repo,
      { async fetch() { return { sourceUrl: "https://cdn.example.com/input.png", body: png, mimeType: "image/png" }; } },
      objectStore,
    );

    const asset = await service.import(auth, {
      workspaceId: "ws-a",
      sourceUrl: "https://cdn.example.com/input.png",
    });

    expect(asset).toMatchObject({
      kind: "input",
      status: "ready",
      mimeType: "image/png",
      storageBucket: "memory",
    });
    expect(objectStore.objects.size).toBe(1);
    expect((await pool.query("SELECT status FROM assets WHERE id=$1", [asset.id])).rows[0].status).toBe("ready");
  });

  it("authorizes the workspace before performing an external URL fetch", async () => {
    const pool = await createDatabase();
    const repo = new PostgresJobRepository(pool);
    const objectStore = new MemoryObjectStore();
    let fetchCalls = 0;
    const service = new UrlImportService(
      repo,
      { async fetch() { fetchCalls += 1; return { sourceUrl: "https://cdn.example.com/input.png", body: png, mimeType: "image/png" }; } },
      objectStore,
    );

    await expect(service.import({ ...auth, subjectId: "subject-x" }, {
      workspaceId: "ws-a",
      sourceUrl: "https://cdn.example.com/input.png",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchCalls).toBe(0);
  });
});
