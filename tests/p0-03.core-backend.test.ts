import { describe, expect, it } from "vitest";
import {
  GenerationService,
  IdempotencyService,
  InMemoryMediaStore,
  JobAccessService,
  JobService,
  ModelCatalogService,
  QuoteService,
} from "../packages/media-core/src/index.js";
import { CoreMediaMcpBackend } from "../apps/mcp-server/src/index.js";

const auth = {
  tenantId: "tenant-a",
  subjectId: "subject-a",
  clientId: "claude-client",
  scopes: [
    "media.models.read",
    "media.quotes.create",
    "media.generate.video",
    "media.jobs.read",
    "media.jobs.cancel",
  ],
  defaultWorkspaceId: "ws-a",
};

const model = {
  id: "model-seedance",
  publicModelId: "seedance2.0mini",
  version: "2.0",
  providerId: "dreamina-cli",
  providerModelId: "seedance-2.0-mini",
  capability: "video_generation" as const,
  inputSchema: { type: "object" },
  pricingRuleVersion: "pricing-v1",
  availability: "available" as const,
  limits: { max_duration_seconds: 15 },
  features: {
    supportsWebhook: false,
    supportsCancel: true,
    supportsProviderIdempotency: false,
  },
};

const createBackend = () => {
  const store = new InMemoryMediaStore();
  store.addWorkspace(
    { id: "ws-a", tenantId: "tenant-a", name: "A", status: "active" },
    ["subject-a"],
  );
  const catalog = new ModelCatalogService([model]);
  const quotes = new QuoteService(
    store,
    catalog,
    () => ({ currency: "USD", amountMinor: 25 }),
    { ttlMs: 60_000 },
  );
  const generation = new GenerationService(quotes, new JobService(store));
  const jobs = new JobAccessService(store);
  return {
    backend: new CoreMediaMcpBackend(auth, { catalog, quotes, generation, jobs, idempotency: new IdempotencyService(store) }),
    store,
  };
};

describe("P0-03 Core MCP backend", () => {
  it("runs models -> quote -> generate_video -> job_get -> job_cancel through real Core services", async () => {
    const { backend, store } = createBackend();

    const listed = await backend.call("models_list", {
      capability: "video_generation",
    });
    expect(listed.items).toHaveLength(1);

    const request = {
      prompt: "Eight-second vertical scene.",
      duration_seconds: 8,
      aspect_ratio: "9:16",
    };
    const quote = await backend.call("quote_create", {
      idempotency_key: "quote-key-123456",
      public_model_id: "seedance2.0mini",
      request,
    });

    expect(quote).toMatchObject({
      max_charge: { currency: "USD", amount_minor: 25 },
      spend_mode: "preauthorized_workspace_budget",
      confirmation_required: true,
    });

    const generated = await backend.call("generate_video", {
      idempotency_key: "generate-key-1234",
      quote_id: quote.quote_id,
      request_hash: quote.request_hash,
      confirm_quote: true,
      request,
    });

    expect(generated.status).toBe("queued");
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({
      quoteId: quote.quote_id,
      publicModelId: "seedance2.0mini",
      kind: "video",
    });
    expect(store.providerExecutions[0]).toMatchObject({
      providerId: "dreamina-cli",
      providerModelId: "seedance-2.0-mini",
    });

    const read = await backend.call("job_get", {
      job_id: generated.job_id,
    });
    expect(read).toMatchObject({
      job_id: generated.job_id,
      kind: "video_generation",
      status: "queued",
    });

    const cancelled = await backend.call("job_cancel", {
      idempotency_key: "cancel-key-123456",
      job_id: generated.job_id,
    });
    expect(cancelled).toEqual({
      job_id: generated.job_id,
      status: "cancel_requested",
    });

    const replay = await backend.call("job_cancel", {
      idempotency_key: "cancel-key-123456",
      job_id: generated.job_id,
    });
    expect(replay).toEqual(cancelled);

    store.jobs.push({
      ...store.jobs[0],
      id: "job-second",
      status: "queued",
      version: 1,
    });
    await expect(backend.call("job_cancel", {
      idempotency_key: "cancel-key-123456",
      job_id: "job-second",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects generation when the frozen Quote request is changed", async () => {
    const { backend } = createBackend();
    const request = { prompt: "Original", duration_seconds: 8 };

    const quote = await backend.call("quote_create", {
      idempotency_key: "quote-key-abcdef1",
      public_model_id: "seedance2.0mini",
      request,
    });

    await expect(backend.call("generate_video", {
      idempotency_key: "generate-key-abcd",
      quote_id: quote.quote_id,
      request_hash: quote.request_hash,
      confirm_quote: true,
      request: { prompt: "Changed", duration_seconds: 8 },
    })).rejects.toMatchObject({ code: "QUOTE_MISMATCH" });
  });

  it("does not disclose a Job from another subject", async () => {
    const { backend, store } = createBackend();
    store.jobs.push({
      id: "foreign-job",
      tenantId: "tenant-a",
      subjectId: "subject-other",
      workspaceId: "ws-a",
      kind: "video",
      publicModelId: "seedance2.0mini",
      requestHash: "hash",
      frozenRequest: {},
      status: "queued",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(backend.call("job_get", {
      job_id: "foreign-job",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
