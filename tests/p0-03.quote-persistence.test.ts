import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import {
  GenerationService,
  JobService,
  QuoteService,
} from "../packages/media-core/src/index.js";
import {
  PostgresJobRepository,
  PostgresModelCatalogRepository,
  PostgresQuoteRepository,
  migrate,
} from "../packages/persistence/src/index.js";

const auth = {
  tenantId: "tenant-a",
  subjectId: "subject-a",
  clientId: "claude-client",
  scopes: [],
  defaultWorkspaceId: "ws-a",
};

const createDatabase = async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  await pool.query("INSERT INTO workspaces(id,tenant_id,name,status) VALUES ('ws-a','tenant-a','A','active')");
  await pool.query("INSERT INTO workspace_members(workspace_id,subject_id) VALUES ('ws-a','subject-a')");
  await pool.query(
    "INSERT INTO model_catalog(id,public_model_id,version,provider_id,provider_model_id,capability,input_schema_json,pricing_rule_version,availability,features_json,limits_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      "model-1",
      "seedance2.0mini",
      "2.0",
      "dreamina-cli",
      "seedance-2.0-mini",
      "video_generation",
      { type: "object" },
      "pricing-v1",
      "available",
      { supportsWebhook: false, supportsCancel: true, supportsProviderIdempotency: false },
      { max_duration_seconds: 15 },
    ],
  );
  return pool;
};

describe("P0-03 PostgreSQL Quote + Generate", () => {
  it("persists and replays Quote, creates Job from frozen request, and confirms Quote", async () => {
    const pool = await createDatabase();
    const catalog = new PostgresModelCatalogRepository(pool);
    const quotes = new QuoteService(
      new PostgresQuoteRepository(pool),
      catalog,
      () => ({ currency: "USD", amountMinor: 25 }),
      { ttlMs: 60_000 },
    );
    const request = {
      prompt: "Eight-second vertical scene.",
      duration_seconds: 8,
    };

    const first = await quotes.create(auth, {
      idempotencyKey: "quote-db-key-1234",
      publicModelId: "seedance2.0mini",
      request,
    });
    const replay = await quotes.create(auth, {
      idempotencyKey: "quote-db-key-1234",
      publicModelId: "seedance2.0mini",
      request,
    });

    expect(replay.quoteId).toBe(first.quoteId);
    expect(replay.expiresAt).toBeInstanceOf(Date);
    expect((await pool.query("SELECT count(*)::int AS count FROM quotes")).rows[0].count).toBe(1);

    const generation = new GenerationService(
      quotes,
      new JobService(new PostgresJobRepository(pool)),
    );
    const created = await generation.create(auth, {
      toolName: "generate_video",
      idempotencyKey: "generate-db-key-1",
      quoteId: first.quoteId,
      requestHash: first.requestHash,
      confirmQuote: true,
      request,
    });

    expect(created.status).toBe("queued");
    const job = (await pool.query("SELECT quote_id,public_model_id,kind,status FROM jobs WHERE id=$1", [created.jobId])).rows[0];
    expect(job).toMatchObject({
      quote_id: first.quoteId,
      public_model_id: "seedance2.0mini",
      kind: "video",
      status: "queued",
    });
    expect((await pool.query("SELECT status FROM quotes WHERE id=$1", [first.quoteId])).rows[0].status).toBe("confirmed");
  });

  it("rejects idempotency reuse with a different Quote request", async () => {
    const pool = await createDatabase();
    const catalog = new PostgresModelCatalogRepository(pool);
    const quotes = new QuoteService(
      new PostgresQuoteRepository(pool),
      catalog,
      () => ({ currency: "USD", amountMinor: 25 }),
    );

    await quotes.create(auth, {
      idempotencyKey: "quote-db-conflict",
      publicModelId: "seedance2.0mini",
      request: { prompt: "A", duration_seconds: 8 },
    });

    await expect(quotes.create(auth, {
      idempotencyKey: "quote-db-conflict",
      publicModelId: "seedance2.0mini",
      request: { prompt: "B", duration_seconds: 8 },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
