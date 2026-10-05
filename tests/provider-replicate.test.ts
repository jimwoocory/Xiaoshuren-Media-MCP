import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ReplicateProvider } from "../packages/provider-replicate/src/index.js";

const secretBytes = Buffer.from("replicate-test-signing-key-32bytes!!").subarray(0, 32);
const webhookSecret = `whsec_${secretBytes.toString("base64")}`;
const secrets = {
  async get(name: string) {
    if (name === "REPLICATE_API_TOKEN") return "test-token";
    if (name === "REPLICATE_WEBHOOK_SECRET") return webhookSecret;
    throw new Error("missing secret");
  },
};

const ctx = {
  tenantId: "tenant-a",
  workspaceId: "ws-a",
  jobId: "job-a",
  providerExecutionId: "pe-a",
  providerRequestKey: "req-a",
  providerModelId: "version-123",
  callbackUrl: "https://example.com/webhooks/replicate",
};

describe("ReplicateProvider", () => {
  it("creates an asynchronous prediction with the provider model version and completed webhook", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        version: "version-123",
        input: { prompt: "a kite" },
        webhook: "https://example.com/webhooks/replicate",
        webhook_events_filter: ["completed"],
      });
      return new Response(JSON.stringify({ id: "pred-1", status: "starting" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new ReplicateProvider(secrets, { fetchImpl: fetchImpl as typeof fetch });
    await expect(provider.submit(ctx, { prompt: "a kite" })).resolves.toEqual({
      providerJobId: "pred-1",
      status: "submitted",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats network and 5xx submit outcomes as unknown to prevent blind retries", async () => {
    const networkProvider = new ReplicateProvider(secrets, {
      fetchImpl: (async () => { throw new Error("socket reset"); }) as typeof fetch,
    });
    await expect(networkProvider.submit(ctx, { prompt: "x" })).rejects.toMatchObject({
      code: "PROVIDER_SUBMISSION_UNKNOWN",
      retryable: true,
    });

    const serverProvider = new ReplicateProvider(secrets, {
      fetchImpl: (async () => new Response("oops", { status: 503 })) as typeof fetch,
    });
    await expect(serverProvider.submit(ctx, { prompt: "x" })).rejects.toMatchObject({
      code: "PROVIDER_SUBMISSION_UNKNOWN",
      retryable: true,
    });
  });

  it("maps completed prediction output URLs for Asset ingest", async () => {
    const provider = new ReplicateProvider(secrets, {
      fetchImpl: (async () => new Response(JSON.stringify({
        id: "pred-2",
        status: "succeeded",
        output: [
          "https://cdn.example.com/a.png",
          { nested: "https://cdn.example.com/b.png" },
          "not-a-url",
          "http://insecure.example.com/c.png",
        ],
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    });

    await expect(provider.getStatus(ctx, "pred-2")).resolves.toEqual({
      status: "succeeded",
      outputs: [
        { url: "https://cdn.example.com/a.png" },
        { url: "https://cdn.example.com/b.png" },
      ],
    });
  });

  it("verifies Replicate webhook HMAC and rejects stale timestamps", async () => {
    const now = 1_800_000_000_000;
    const timestamp = String(Math.floor(now / 1000));
    const eventId = "msg-1";
    const body = new TextEncoder().encode('{"id":"pred-3","status":"succeeded"}');
    const signedContent = Buffer.concat([
      Buffer.from(`${eventId}.${timestamp}.`, "utf8"),
      Buffer.from(body),
    ]);
    const signature = createHmac("sha256", secretBytes).update(signedContent).digest("base64");
    const provider = new ReplicateProvider(secrets, { now: () => now });

    await expect(provider.verifyWebhook({
      "webhook-id": eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    }, body)).resolves.toEqual({ valid: true, eventId });

    await expect(provider.verifyWebhook({
      "webhook-id": eventId,
      "webhook-timestamp": String(Number(timestamp) - 301),
      "webhook-signature": `v1,${signature}`,
    }, body)).resolves.toEqual({ valid: false, eventId });
  });
});
