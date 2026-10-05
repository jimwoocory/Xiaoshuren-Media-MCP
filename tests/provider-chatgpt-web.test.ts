import { describe, expect, it } from "vitest";
import {
  ChatGPTWebImageProvider,
  type BridgeCommandResult,
  type ChatGPTBridgeRunner,
} from "../packages/provider-chatgpt-web/src/index.js";

class StubBridge implements ChatGPTBridgeRunner {
  calls: Array<{ command: string; payload: Record<string, unknown>; timeoutMs: number }> = [];
  private results: BridgeCommandResult[];

  constructor(...results: BridgeCommandResult[]) {
    this.results = [...results];
  }

  async run(command: "probe" | "submit" | "status", payload: Record<string, unknown>, timeoutMs: number): Promise<BridgeCommandResult> {
    this.calls.push({ command, payload, timeoutMs });
    const result = this.results.shift();
    if (!result) throw new Error("missing bridge result");
    return result;
  }
}

const ctx = {
  tenantId: "tenant-a",
  workspaceId: "ws-a",
  jobId: "job-a",
  providerExecutionId: "pe-a",
  providerRequestKey: "request-a",
};

describe("ChatGPTWebImageProvider", () => {
  it("submits one image request through the bridge and uses providerRequestKey as durable job id", async () => {
    const bridge = new StubBridge({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        provider_job_id: "request-a",
        conversation_url: "https://chatgpt.com/c/test",
        status: "submitted",
      }),
      stderr: "",
      timedOut: false,
    });
    const provider = new ChatGPTWebImageProvider({ runner: bridge });

    await expect(provider.submit(ctx, { prompt: "a red apple on white background" })).resolves.toEqual({
      providerJobId: "request-a",
      status: "submitted",
    });

    expect(bridge.calls[0]).toMatchObject({
      command: "submit",
      payload: {
        request_id: "request-a",
      },
    });
    expect(String(bridge.calls[0].payload.prompt)).toContain("a red apple on white background");
  });

  it("maps bridge timeout to unknown instead of blind resubmit", async () => {
    const bridge = new StubBridge({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const provider = new ChatGPTWebImageProvider({ runner: bridge });

    await expect(provider.submit(ctx, { prompt: "test" })).resolves.toEqual({
      providerJobId: "request-a",
      status: "unknown",
    });
  });

  it("treats missing logged-in Chrome ChatGPT session as deterministic auth error", async () => {
    const bridge = new StubBridge({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: "No logged-in ChatGPT tab was found in Google Chrome",
      }),
      stderr: "",
      timedOut: false,
    });
    const provider = new ChatGPTWebImageProvider({ runner: bridge });

    await expect(provider.submit(ctx, { prompt: "test" })).rejects.toMatchObject({
      code: "PROVIDER_AUTH_ERROR",
      retryable: false,
    });
  });

  it("returns downloaded ChatGPT image as a trusted local file URL", async () => {
    const bridge = new StubBridge({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        status: "succeeded",
        local_path: "C:\\Users\\Administrator\\Downloads\\Xiaoshuren-Media-MCP\\image.png",
        mime_type: "image/png",
      }),
      stderr: "",
      timedOut: false,
    });
    const provider = new ChatGPTWebImageProvider({ runner: bridge });

    const result = await provider.getStatus(ctx, "request-a");
    expect(result.status).toBe("succeeded");
    expect(result.outputs?.[0].url).toMatch(/^file:\/\/\//);
    expect(result.outputs?.[0].url).toContain("image.png");
    expect(result.outputs?.[0].mimeType).toBe("image/png");
  });

  it("keeps image generation running until the browser bridge has downloaded the image", async () => {
    const bridge = new StubBridge({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        status: "running",
        image_detected: true,
        filename: "generated.png",
      }),
      stderr: "",
      timedOut: false,
    });
    const provider = new ChatGPTWebImageProvider({ runner: bridge });

    await expect(provider.getStatus(ctx, "request-a")).resolves.toEqual({ status: "running" });
  });
});
