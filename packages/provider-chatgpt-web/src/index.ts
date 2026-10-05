import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DomainError,
  ProviderAdapter,
  ProviderExecutionContext,
  ProviderStatusResult,
  ProviderSubmitResult,
} from "@xiaoshuren/contracts";

export type ChatGPTBridgeResponse = {
  ok: boolean;
  status?: "submitted" | "running" | "succeeded" | "failed" | "unknown";
  provider_job_id?: string;
  conversation_url?: string;
  local_path?: string;
  mime_type?: string;
  filename?: string;
  image_detected?: boolean;
  error?: string;
  error_type?: string;
};

export type BridgeCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export interface ChatGPTBridgeRunner {
  run(
    command: "probe" | "submit" | "status",
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<BridgeCommandResult>;
}

export type PythonChatGPTBridgeRunnerOptions = {
  pythonExecutable?: string;
  bridgeScript?: string;
};

export class PythonChatGPTBridgeRunner implements ChatGPTBridgeRunner {
  private readonly pythonExecutable: string;
  private readonly bridgeScript: string;

  constructor(options: PythonChatGPTBridgeRunnerOptions = {}) {
    this.pythonExecutable = options.pythonExecutable ?? "python";
    this.bridgeScript = options.bridgeScript ?? resolve(process.cwd(), "scripts", "chatgpt_web_bridge.py");
  }

  async run(
    command: "probe" | "submit" | "status",
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<BridgeCommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.pythonExecutable, ["-X", "faulthandler", this.bridgeScript, command], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: BridgeCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", exitCode => finish({ exitCode, stdout, stderr, timedOut: false }));
      child.stdin.end(JSON.stringify(payload));

      const timer = setTimeout(() => {
        child.kill();
        finish({ exitCode: null, stdout, stderr, timedOut: true });
      }, timeoutMs);
    });
  }
}

const parseResponse = (result: BridgeCommandResult): ChatGPTBridgeResponse => {
  const line = result.stdout
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    return {
      ok: false,
      error: result.stderr.trim() || "ChatGPT web bridge returned no response",
    };
  }

  try {
    return JSON.parse(line) as ChatGPTBridgeResponse;
  } catch {
    return {
      ok: false,
      error: "ChatGPT web bridge returned unreadable JSON",
    };
  }
};

export type ChatGPTWebImageProviderOptions = {
  runner?: ChatGPTBridgeRunner;
  submitTimeoutMs?: number;
  statusTimeoutMs?: number;
  downloadDir?: string;
};

export class ChatGPTWebImageProvider implements ProviderAdapter {
  private readonly runner: ChatGPTBridgeRunner;
  private readonly submitTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly downloadDir?: string;

  constructor(options: ChatGPTWebImageProviderOptions = {}) {
    this.runner = options.runner ?? new PythonChatGPTBridgeRunner();
    this.submitTimeoutMs = options.submitTimeoutMs ?? 45_000;
    this.statusTimeoutMs = options.statusTimeoutMs ?? 45_000;
    this.downloadDir = options.downloadDir;
  }

  async submit(
    ctx: ProviderExecutionContext,
    request: Record<string, unknown>,
  ): Promise<ProviderSubmitResult> {
    const prompt = String(request.prompt ?? "").trim();
    if (!prompt) throw new DomainError("VALIDATION_ERROR", "ChatGPT web image prompt is required");

    const instruction = [
      "Generate one image using ChatGPT image generation.",
      prompt,
      "Return one image only.",
    ].join("\n");

    const result = await this.runner.run("submit", {
      request_id: ctx.providerRequestKey,
      prompt: instruction,
    }, this.submitTimeoutMs);

    if (result.timedOut) {
      return { providerJobId: ctx.providerRequestKey, status: "unknown" };
    }

    const response = parseResponse(result);
    if (response.ok && response.provider_job_id) {
      return {
        providerJobId: response.provider_job_id,
        status: response.status === "running" ? "running" : "submitted",
      };
    }

    const message = response.error || result.stderr.trim() || "ChatGPT web bridge submission failed";
    if (/No logged-in ChatGPT tab|message input did not become available/i.test(message)) {
      throw new DomainError("PROVIDER_AUTH_ERROR", message, false);
    }

    // The bridge journals request_id before interacting with Chrome. If a submit
    // fails after the click boundary, the safe recovery path is reconciliation,
    // never a blind second image request.
    return { providerJobId: ctx.providerRequestKey, status: "unknown" };
  }

  async getStatus(
    _ctx: ProviderExecutionContext,
    providerJobId: string,
  ): Promise<ProviderStatusResult> {
    const result = await this.runner.run("status", {
      provider_job_id: providerJobId,
      download_dir: this.downloadDir,
    }, this.statusTimeoutMs);

    if (result.timedOut) {
      throw new DomainError("PROVIDER_TEMPORARY_ERROR", "ChatGPT web status check timed out", true);
    }

    const response = parseResponse(result);
    if (!response.ok) {
      throw new DomainError(
        "PROVIDER_TEMPORARY_ERROR",
        response.error || result.stderr.trim() || "ChatGPT web bridge status failed",
        true,
      );
    }

    switch (response.status) {
      case "succeeded":
        if (!response.local_path) return { status: "running" };
        return {
          status: "succeeded",
          outputs: [{
            url: pathToFileURL(response.local_path).toString(),
            mimeType: response.mime_type,
          }],
        };
      case "failed":
        return {
          status: "failed",
          error: {
            providerCode: "CHATGPT_WEB_IMAGE_FAILED",
            message: response.error || "ChatGPT web image generation failed",
            retryable: false,
          },
        };
      case "unknown":
        return { status: "unknown" };
      case "submitted":
      case "running":
      default:
        return { status: "running" };
    }
  }

  normalizeError(error: unknown) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message, retryable: error.retryable };
    }
    return {
      code: "PROVIDER_ERROR",
      message: error instanceof Error ? error.message : "ChatGPT web image provider error",
      retryable: false,
    };
  }
}
