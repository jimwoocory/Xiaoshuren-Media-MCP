import { randomUUID } from "node:crypto";
import {
  type AuthContext,
  DomainError,
  type IdempotencyRecord,
  type Job,
  type ModelCatalogEntry,
  type Quote,
  stableHash,
} from "@xiaoshuren/contracts";
import type {
  CreateJobInput,
  CreateJobResult,
  IdempotencyStore,
  JobStore,
  QuoteStore,
} from "./index.js";

export type ModelCatalogReader = {
  list(input?: {
    capability?: "image_generation" | "video_generation";
    limit?: number;
  }): ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>;
  get(publicModelId: string): ModelCatalogEntry | Promise<ModelCatalogEntry>;
};

export class ModelCatalogService implements ModelCatalogReader {
  constructor(private readonly entries: readonly ModelCatalogEntry[]) {}

  list(input: {
    capability?: "image_generation" | "video_generation";
    limit?: number;
  } = {}): ModelCatalogEntry[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    return this.entries
      .filter(entry => entry.capability !== "audio_generation")
      .filter(entry => !input.capability || entry.capability === input.capability)
      .slice(0, limit)
      .map(entry => structuredClone(entry));
  }

  get(publicModelId: string): ModelCatalogEntry {
    const entry = this.entries.find(candidate => candidate.publicModelId === publicModelId);
    if (!entry || entry.capability === "audio_generation") {
      throw new DomainError("NOT_FOUND", "Resource not found");
    }
    return structuredClone(entry);
  }
}

export type QuotePrice = {
  currency: string;
  amountMinor: number;
};

export type QuotePricing = (
  model: ModelCatalogEntry,
  request: Record<string, unknown>,
) => QuotePrice;

export type QuoteCreateResult = {
  quoteId: string;
  requestHash: string;
  maxCharge: QuotePrice;
  expiresAt: Date;
  pricingRuleVersion: string;
  spendMode: "preauthorized_workspace_budget";
  confirmationRequired: true;
};

const restoreQuoteCreateResult = (snapshot: Record<string, unknown>): QuoteCreateResult => {
  const raw = snapshot as unknown as QuoteCreateResult & { expiresAt: Date | string };
  return {
    ...raw,
    expiresAt: raw.expiresAt instanceof Date ? raw.expiresAt : new Date(raw.expiresAt),
  };
};

export class QuoteService {
  constructor(
    private readonly store: QuoteStore,
    private readonly catalog: ModelCatalogReader,
    private readonly pricing: QuotePricing,
    private readonly options: {
      ttlMs?: number;
      now?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async create(auth: AuthContext, input: {
    workspaceId?: string;
    idempotencyKey: string;
    publicModelId: string;
    request: Record<string, unknown>;
  }): Promise<QuoteCreateResult> {
    if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) {
      throw new DomainError("VALIDATION_ERROR", "idempotency key must be 16..128 characters");
    }

    return this.store.transaction(async store => {
      const workspace = await store.authorize(auth, input.workspaceId);
      const model = await this.catalog.get(input.publicModelId);
      if (model.availability !== "available") {
        throw new DomainError("MODEL_UNAVAILABLE", "Requested model is not available");
      }

      const normalizedRequest = structuredClone(input.request);
      const requestHash = stableHash({
        workspaceId: workspace.id,
        modelId: model.publicModelId,
        request: normalizedRequest,
      });
      const existing = await store.findIdempotency(auth, "quote_create", input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for another request");
        }
        return restoreQuoteCreateResult(existing.responseSnapshot);
      }

      const price = this.pricing(model, normalizedRequest);
      if (
        !price.currency ||
        !Number.isSafeInteger(price.amountMinor) ||
        price.amountMinor < 0
      ) {
        throw new DomainError("PRICING_ERROR", "Pricing rule returned an invalid maximum charge");
      }

      const now = this.now();
      const quoteId = randomUUID();
      const expiresAt = new Date(now.getTime() + (this.options.ttlMs ?? 5 * 60_000));
      const result: QuoteCreateResult = {
        quoteId,
        requestHash,
        maxCharge: price,
        expiresAt,
        pricingRuleVersion: model.pricingRuleVersion,
        spendMode: "preauthorized_workspace_budget",
        confirmationRequired: true,
      };
      const quote: Quote = {
        id: quoteId,
        tenantId: auth.tenantId,
        subjectId: auth.subjectId,
        workspaceId: workspace.id,
        publicModelId: model.publicModelId,
        requestHash,
        normalizedRequest,
        pricingRuleVersion: model.pricingRuleVersion,
        maxChargeCurrency: price.currency,
        maxChargeAmountMinor: price.amountMinor,
        status: "reserved",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      };
      const record: IdempotencyRecord = {
        id: randomUUID(),
        tenantId: auth.tenantId,
        subjectId: auth.subjectId,
        toolName: "quote_create",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        responseSnapshot: result,
        resourceType: "quote",
        resourceId: quoteId,
        createdAt: now,
      };

      const concurrent = await store.persistQuote(quote, record);
      if (concurrent) {
        if (concurrent.requestHash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for another request");
        }
        return restoreQuoteCreateResult(concurrent.responseSnapshot);
      }
      return result;
    });
  }

  async validateForGeneration(auth: AuthContext, input: {
    quoteId: string;
    workspaceId?: string;
    requestHash: string;
    request: Record<string, unknown>;
  }): Promise<{ quote: Quote; model: ModelCatalogEntry }> {
    const quote = await this.store.findQuote(auth, input.quoteId);
    if (!quote) throw new DomainError("NOT_FOUND", "Resource not found");

    const workspace = await this.store.authorize(auth, input.workspaceId ?? quote.workspaceId);
    if (
      quote.tenantId !== auth.tenantId ||
      quote.subjectId !== auth.subjectId ||
      quote.workspaceId !== workspace.id
    ) {
      throw new DomainError("NOT_FOUND", "Resource not found");
    }
    if (quote.status !== "reserved" && quote.status !== "confirmed") {
      throw new DomainError("QUOTE_INVALID", "Quote is no longer usable");
    }
    if (quote.expiresAt.getTime() <= this.now().getTime()) {
      throw new DomainError("QUOTE_EXPIRED", "Quote has expired");
    }

    const recomputed = stableHash({
      workspaceId: quote.workspaceId,
      modelId: quote.publicModelId,
      request: input.request,
    });
    if (input.requestHash !== quote.requestHash || recomputed !== quote.requestHash) {
      throw new DomainError("QUOTE_MISMATCH", "Generation request does not match the frozen Quote");
    }

    return { quote, model: await this.catalog.get(quote.publicModelId) };
  }

  async confirm(auth: AuthContext, quoteId: string): Promise<void> {
    const quote = await this.store.findQuote(auth, quoteId);
    if (!quote) throw new DomainError("NOT_FOUND", "Resource not found");
    if (quote.status === "confirmed") return;
    if (quote.status !== "reserved") throw new DomainError("QUOTE_INVALID", "Quote cannot be confirmed");
    quote.status = "confirmed";
    quote.updatedAt = this.now();
    await this.store.updateQuote(quote);
  }
}

export interface JobCreator {
  create(auth: AuthContext, input: CreateJobInput): Promise<CreateJobResult>;
}

export class GenerationService {
  constructor(
    private readonly quotes: QuoteService,
    private readonly jobs: JobCreator,
  ) {}

  async create(auth: AuthContext, input: {
    toolName: "generate_image" | "generate_video";
    workspaceId?: string;
    idempotencyKey: string;
    quoteId: string;
    requestHash: string;
    confirmQuote: true;
    request: Record<string, unknown>;
  }): Promise<CreateJobResult & { quoteId: string; requestHash: string }> {
    if (input.confirmQuote !== true) {
      throw new DomainError("QUOTE_CONFIRMATION_REQUIRED", "confirm_quote must be true");
    }

    const kind = input.toolName === "generate_image" ? "image" : "video";
    const quote = await this.quotes.validateForGeneration(auth, {
      quoteId: input.quoteId,
      workspaceId: input.workspaceId,
      requestHash: input.requestHash,
      request: input.request,
    });

    const expectedCapability = kind === "image" ? "image_generation" : "video_generation";
    if (quote.model.capability !== expectedCapability) {
      throw new DomainError("MODEL_CAPABILITY_MISMATCH", "Quote model does not support the requested generation tool");
    }

    const created = await this.jobs.create(auth, {
      workspaceId: quote.quote.workspaceId,
      idempotencyKey: input.idempotencyKey,
      idempotencyToolName: input.toolName,
      request: input.request,
      modelId: quote.model.publicModelId,
      quoteId: quote.quote.id,
      kind,
      providerId: quote.model.providerId,
      providerModelId: quote.model.providerModelId,
    });
    await this.quotes.confirm(auth, quote.quote.id);
    return {
      ...created,
      quoteId: quote.quote.id,
      requestHash: quote.quote.requestHash,
    };
  }
}

export class JobAccessService {
  constructor(private readonly store: JobStore) {}

  async get(auth: AuthContext, input: {
    workspaceId?: string;
    jobId: string;
  }): Promise<Job> {
    const job = await this.store.findJob(input.jobId);
    if (!job) throw new DomainError("NOT_FOUND", "Resource not found");
    const workspace = await this.store.authorize(auth, input.workspaceId ?? job.workspaceId);
    if (
      job.tenantId !== auth.tenantId ||
      job.subjectId !== auth.subjectId ||
      job.workspaceId !== workspace.id
    ) {
      throw new DomainError("NOT_FOUND", "Resource not found");
    }
    return structuredClone(job);
  }

  async cancel(auth: AuthContext, input: {
    workspaceId?: string;
    jobId: string;
  }): Promise<Job> {
    const job = await this.get(auth, input);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }
    if (job.status !== "cancel_requested") {
      const mutable = await this.store.findJob(job.id);
      if (!mutable) throw new DomainError("NOT_FOUND", "Resource not found");
      mutable.status = "cancel_requested";
      mutable.updatedAt = new Date();
      mutable.version += 1;
      await this.store.updateJob(mutable);
      return structuredClone(mutable);
    }
    return job;
  }
}

const IDEMPOTENCY_PENDING = "__pending__";

export class IdempotencyService {
  constructor(private readonly store: IdempotencyStore) {}

  async run<T extends Record<string, unknown>>(auth: AuthContext, input: {
    toolName: string;
    idempotencyKey: string;
    semanticRequest: unknown;
    resourceType: string;
    execute: () => Promise<{ response: T; resourceId: string }>;
  }): Promise<T> {
    if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) {
      throw new DomainError("VALIDATION_ERROR", "idempotency key must be 16..128 characters");
    }
    const requestHash = stableHash(input.semanticRequest);
    const existing = await this.store.findIdempotency(auth, input.toolName, input.idempotencyKey);
    if (existing) return this.replay<T>(existing, requestHash);

    const record: IdempotencyRecord = {
      id: randomUUID(),
      tenantId: auth.tenantId,
      subjectId: auth.subjectId,
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      responseSnapshot: { state: IDEMPOTENCY_PENDING },
      resourceType: IDEMPOTENCY_PENDING,
      resourceId: IDEMPOTENCY_PENDING,
      createdAt: new Date(),
    };
    const reserved = await this.store.reserveIdempotency(record);
    if (reserved.id !== record.id) return this.replay<T>(reserved, requestHash);

    try {
      const result = await input.execute();
      await this.store.completeIdempotency(record.id, result.response, input.resourceType, result.resourceId);
      return result.response;
    } catch (error) {
      await this.store.deleteIdempotency(record.id).catch(() => undefined);
      throw error;
    }
  }

  private replay<T extends Record<string, unknown>>(record: IdempotencyRecord, requestHash: string): T {
    if (record.requestHash !== requestHash) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for another request");
    }
    if (record.resourceType === IDEMPOTENCY_PENDING || record.resourceId === IDEMPOTENCY_PENDING) {
      throw new DomainError("IDEMPOTENCY_IN_PROGRESS", "An equivalent request is already in progress", true);
    }
    return structuredClone(record.responseSnapshot) as T;
  }
}
