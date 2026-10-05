import { describe, expect, it } from "vitest";
import { AwsSecretsManagerProvider } from "../packages/security/src/index.js";

describe("AwsSecretsManagerProvider", () => {
  it("maps logical secret names, extracts JSON keys, and caches values", async () => {
    let calls = 0;
    let now = 1_000;
    const client = {
      async send(command: any) {
        calls += 1;
        expect(command.input.SecretId).toBe("prod/media/provider-secrets");
        return { SecretString: JSON.stringify({ replicateToken: "server-only-token" }) };
      },
    };
    const provider = new AwsSecretsManagerProvider(
      client as any,
      {
        REPLICATE_API_TOKEN: {
          secretId: "prod/media/provider-secrets",
          jsonKey: "replicateToken",
        },
      },
      100,
      () => now,
    );

    await expect(provider.get("REPLICATE_API_TOKEN")).resolves.toBe("server-only-token");
    await expect(provider.get("REPLICATE_API_TOKEN")).resolves.toBe("server-only-token");
    expect(calls).toBe(1);

    now += 101;
    await expect(provider.get("REPLICATE_API_TOKEN")).resolves.toBe("server-only-token");
    expect(calls).toBe(2);

    provider.clearCache();
    await expect(provider.get("REPLICATE_API_TOKEN")).resolves.toBe("server-only-token");
    expect(calls).toBe(3);
  });

  it("rejects unmapped or malformed mapped secrets without exposing secret values", async () => {
    const client = {
      async send() {
        return { SecretString: "not-json" };
      },
    };
    const provider = new AwsSecretsManagerProvider(
      client as any,
      {
        REPLICATE_API_TOKEN: {
          secretId: "prod/media/provider-secrets",
          jsonKey: "replicateToken",
        },
      },
    );

    await expect(provider.get("UNKNOWN_SECRET")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(provider.get("REPLICATE_API_TOKEN")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
