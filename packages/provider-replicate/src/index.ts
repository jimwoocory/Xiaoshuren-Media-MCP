import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DomainError,
  ProviderAdapter,
  ProviderExecutionContext,
  ProviderStatusResult,
  ProviderSubmitResult,
} from "@xiaoshuren/contracts";
import { SecretProvider } from "@xiaoshuren/security";

type HttpFetch = typeof fetch;

type ReplicatePrediction = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
};

export type ReplicateProviderOptions = {
  apiBaseUrl?: string;
  tokenSecretName?: string;
  webhookSecretName?: string;
  cancelAfter?: string;
  webhookToleranceSeconds?: number;
  fetchImpl?: HttpFetch;
  now?: () => number;
};

const normalizeHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

const extractHttpsUrls = (value: unknown): string[] => {
  const urls: string[] = [];

  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      try {
        const url = new URL(candidate);
        if (url.protocol === "https:") urls.push(url.toString());
      } catch {
        // Non-URL outputs are intentionally ignored by the media adapter.
      }
      return;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }

    if (candidate && typeof candidate === "object") {
      for (const item of Object.values(candidate as Record<string, unknown>)) visit(item);
    }
  };

  visit(value);
  return [...new Set(urls)];
};

const toProviderStatus = (prediction: ReplicatePrediction): ProviderStatusResult => {
  switch (prediction.status) {
    case "starting":
      return { status: "queued" };
    case "processing":
      return { status: "running" };
    case "succeeded":
      return {
        status: "succeeded",
        outputs: extractHttpsUrls(prediction.output).map(url => ({ url })),
      };
    case "failed":
      return {
        status: "failed",
        error: {
          providerCode: "REPLICATE_FAILED",
          message: typeof prediction.error === "string" ? prediction.error : "Replicate prediction failed",
          retryable: false,
        },
      };
    case "canceled":
      return { status: "cancelled" };
    default:
      return { status: "unknown" };
  }
};

export class ReplicateProvider implements ProviderAdapter {
  private readonly apiBaseUrl: string;
  private readonly tokenSecretName: string;
  private readonly webhookSecretName: string;
  private readonly cancelAfter?: string;
  private readonly webhookToleranceSeconds: number;
  private readonly fetchImpl: HttpFetch;
  private readonly now: () => number;

  constructor(
    private readonly secrets: SecretProvider,
    options: ReplicateProviderOptions = {},
  ) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.replicate.com/v1").replace(/\/$/, "");
    this.tokenSecretName = options.tokenSecretName ?? "REPLICATE_API_TOKEN";
    this.webhookSecretName = options.webhookSecretName ?? "REPLICATE_WEBHOOK_SECRET";
    this.cancelAfter = options.cancelAfter;
    this.webhookToleranceSeconds = options.webhookToleranceSeconds ?? 300;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  private async token(): Promise<string> {
    return this.secrets.get(this.tokenSecretName);
  }

  private async authorizedHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.token()}`,
      "Content-Type": "application/json",
    };
  }

  private async parseJson(response: Response): Promise<ReplicatePrediction> {
    try {
      return await response.json() as ReplicatePrediction;
    } catch {
      throw new DomainError("PROVIDER_TEMPORARY_ERROR", "Replicate returned an unreadable response", true);
    }
  }

  async submit(ctx: ProviderExecutionContext, request: Record<string, unknown>): Promise<ProviderSubmitResult> {
    if (!ctx.providerModelId) {
      throw new DomainError("VALIDATION_ERROR", "Replicate provider model version is required");
    }

    const body: Record<string, unknown> = {
      version: ctx.providerModelId,
      input: request,
    };
    if (ctx.callbackUrl) {
      body.webhook = ctx.callbackUrl;
      body.webhook_events_filter = ["completed"];
    }

    let response: Response;
    try {
      const headers = await this.authorizedHeaders();
      if (this.cancelAfter) headers["Cancel-After"] = this.cancelAfter;
      response = await this.fetchImpl(`${this.apiBaseUrl}/predictions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new DomainError(
        "PROVIDER_SUBMISSION_UNKNOWN",
        error instanceof Error ? error.message : "Replicate submission outcome is unknown",
        true,
      );
    }

    if (response.status >= 500) {
      throw new DomainError("PROVIDER_SUBMISSION_UNKNOWN", `Replicate returned HTTP ${response.status}`, true);
    }
    if (response.status === 429) {
      throw new DomainError("PROVIDER_TEMPORARY_ERROR", "Replicate rate limited the submission", true);
    }
    if (!response.ok) {
      throw new DomainError("PROVIDER_REJECTED", `Replicate rejected the submission with HTTP ${response.status}`);
    }

    const prediction = await this.parseJson(response);
    if (!prediction.id) {
      throw new DomainError("PROVIDER_SUBMISSION_UNKNOWN", "Replicate accepted the request without a prediction id", true);
    }

    return {
      providerJobId: prediction.id,
      status: prediction.status === "processing" || prediction.status === "succeeded" ? "running" : "submitted",
    };
  }

  async getStatus(_ctx: ProviderExecutionContext, providerJobId: string): Promise<ProviderStatusResult> {
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/predictions/${encodeURIComponent(providerJobId)}`,
      { headers: { Authorization: `Bearer ${await this.token()}` } },
    );

    if (response.status === 404) return { status: "unknown" };
    if (response.status === 429 || response.status >= 500) {
      throw new DomainError("PROVIDER_TEMPORARY_ERROR", `Replicate status request failed with HTTP ${response.status}`, true);
    }
    if (!response.ok) {
      throw new DomainError("PROVIDER_ERROR", `Replicate status request failed with HTTP ${response.status}`);
    }

    return toProviderStatus(await this.parseJson(response));
  }

  async cancel(_ctx: ProviderExecutionContext, providerJobId: string): Promise<ProviderStatusResult> {
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/predictions/${encodeURIComponent(providerJobId)}/cancel`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.token()}` },
      },
    );

    if (response.status === 404) return { status: "unknown" };
    if (!response.ok) {
      throw new DomainError(
        response.status >= 500 || response.status === 429 ? "PROVIDER_TEMPORARY_ERROR" : "PROVIDER_ERROR",
        `Replicate cancel failed with HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }

    return toProviderStatus(await this.parseJson(response));
  }

  async verifyWebhook(headers: Record<string, string>, rawBody: Uint8Array): Promise<{ valid: boolean; eventId?: string }> {
    const normalized = normalizeHeaders(headers);
    const eventId = normalized["webhook-id"];
    const timestamp = normalized["webhook-timestamp"];
    const signatureHeader = normalized["webhook-signature"];

    if (!eventId || !timestamp || !signatureHeader) return { valid: false, eventId };

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) return { valid: false, eventId };
    const nowSeconds = Math.floor(this.now() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > this.webhookToleranceSeconds) {
      return { valid: false, eventId };
    }

    const secret = await this.secrets.get(this.webhookSecretName);
    if (!secret.startsWith("whsec_")) return { valid: false, eventId };

    let key: Buffer;
    try {
      key = Buffer.from(secret.slice("whsec_".length), "base64");
    } catch {
      return { valid: false, eventId };
    }
    if (key.byteLength === 0) return { valid: false, eventId };

    const signedContent = Buffer.concat([
      Buffer.from(`${eventId}.${timestamp}.`, "utf8"),
      Buffer.from(rawBody),
    ]);
    const expected = createHmac("sha256", key).update(signedContent).digest();

    const valid = signatureHeader
      .split(/\s+/)
      .filter(Boolean)
      .some(part => {
        const [version, signature] = part.split(",", 2);
        if (version !== "v1" || !signature) return false;
        try {
          const provided = Buffer.from(signature, "base64");
          return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
        } catch {
          return false;
        }
      });

    return { valid, eventId };
  }

  normalizeError(error: unknown) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message, retryable: error.retryable };
    }
    return {
      code: "PROVIDER_ERROR",
      message: error instanceof Error ? error.message : "Replicate provider error",
      retryable: false,
    };
  }
}
