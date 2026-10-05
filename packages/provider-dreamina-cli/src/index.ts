import { spawn } from "node:child_process";
import {
  DomainError,
  ProviderAdapter,
  ProviderExecutionContext,
  ProviderStatusResult,
  ProviderSubmitResult,
} from "@xiaoshuren/contracts";

export type DreaminaVideoMode =
  | "text2video"
  | "image2video"
  | "multimodal2video"
  | "multiframe2video"
  | "frames2video";

export type DreaminaCliRequest = {
  mode?: DreaminaVideoMode;
  prompt?: string;
  duration?: number;
  ratio?: string;
  video_resolution?: string;
  session?: number;
  image?: string | string[];
  video?: string | string[];
  audio?: string | string[];
  first_frame?: string;
  last_frame?: string;
  transition_prompt?: string | string[];
  transition_duration?: string | number | Array<string | number>;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export interface CommandRunner {
  run(executable: string, args: string[], options: { timeoutMs: number }): Promise<CommandResult>;
}

export class SpawnCommandRunner implements CommandRunner {
  async run(executable: string, args: string[], options: { timeoutMs: number }): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", exitCode => finish({ exitCode, stdout, stderr, timedOut: false }));

      const timer = setTimeout(() => {
        child.kill();
        finish({ exitCode: null, stdout, stderr, timedOut: true });
      }, options.timeoutMs);
    });
  }
}

type DreaminaTask = {
  submit_id?: string;
  gen_task_type?: string;
  gen_status?: string;
  fail_reason?: string;
  [key: string]: unknown;
};

const parseJson = (text: string): DreaminaTask => {
  try {
    return JSON.parse(text) as DreaminaTask;
  } catch {
    throw new DomainError("PROVIDER_TEMPORARY_ERROR", "Dreamina CLI returned unreadable JSON", true);
  }
};

const collectHttpsUrls = (value: unknown): string[] => {
  const urls: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      try {
        const url = new URL(candidate);
        if (url.protocol === "https:") urls.push(url.toString());
      } catch {
        // Ignore plain text, ids, local paths and non-URL fields.
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

const mapTask = (task: DreaminaTask): ProviderStatusResult => {
  switch ((task.gen_status ?? "").toLowerCase()) {
    case "wait":
    case "waiting":
    case "queued":
    case "pending":
    case "submit":
    case "submitted":
      return { status: "queued" };
    case "generating":
    case "processing":
    case "running":
      return { status: "running" };
    case "success":
    case "succeeded":
    case "completed":
      return {
        status: "succeeded",
        outputs: collectHttpsUrls(task).map(url => ({ url })),
      };
    case "fail":
    case "failed":
    case "error":
      return {
        status: "failed",
        error: {
          providerCode: "DREAMINA_FAILED",
          message: task.fail_reason || "Dreamina generation failed",
          retryable: false,
        },
      };
    case "cancel":
    case "cancelled":
    case "canceled":
      return { status: "cancelled" };
    default:
      return { status: "unknown" };
  }
};

const ensureStringArray = (value: string | string[] | undefined): string[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const pushRepeated = (args: string[], flag: string, values: string[]): void => {
  for (const value of values) {
    if (!value) throw new DomainError("VALIDATION_ERROR", `${flag} cannot be empty`);
    args.push(flag, value);
  }
};

export type DreaminaCliProviderOptions = {
  executable?: string;
  commandRunner?: CommandRunner;
  submitTimeoutMs?: number;
  queryTimeoutMs?: number;
};

export class DreaminaCliProvider implements ProviderAdapter {
  private readonly executable: string;
  private readonly runner: CommandRunner;
  private readonly submitTimeoutMs: number;
  private readonly queryTimeoutMs: number;

  constructor(options: DreaminaCliProviderOptions = {}) {
    this.executable = options.executable ?? "dreamina";
    this.runner = options.commandRunner ?? new SpawnCommandRunner();
    this.submitTimeoutMs = options.submitTimeoutMs ?? 30_000;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 30_000;
  }

  private buildSubmitArgs(ctx: ProviderExecutionContext, request: Record<string, unknown>): string[] {
    const input = request as DreaminaCliRequest;
    const mode = input.mode ?? "text2video";
    const model = ctx.providerModelId;
    if (mode !== "multiframe2video" && !model) {
      throw new DomainError("VALIDATION_ERROR", "Dreamina model version is required");
    }
    if (!input.video_resolution) {
      throw new DomainError("VALIDATION_ERROR", "Dreamina video_resolution is required");
    }

    const args: string[] = [mode];

    if (input.prompt != null) args.push("--prompt", input.prompt);
    if (mode !== "multiframe2video") args.push("--model_version", model!);
    args.push("--video_resolution", input.video_resolution);
    if (input.duration != null) args.push("--duration", String(input.duration));
    if (input.ratio != null) args.push("--ratio", input.ratio);
    if (input.session != null) args.push("--session", String(input.session));
    args.push("--poll", "0");

    switch (mode) {
      case "text2video":
        if (!input.prompt) throw new DomainError("VALIDATION_ERROR", "Dreamina text2video prompt is required");
        break;
      case "image2video": {
        const images = ensureStringArray(input.image);
        if (images.length !== 1) throw new DomainError("VALIDATION_ERROR", "Dreamina image2video requires exactly one image");
        pushRepeated(args, "--image", images);
        if (!input.prompt) throw new DomainError("VALIDATION_ERROR", "Dreamina image2video prompt is required");
        break;
      }
      case "multimodal2video":
        pushRepeated(args, "--image", ensureStringArray(input.image));
        pushRepeated(args, "--video", ensureStringArray(input.video));
        pushRepeated(args, "--audio", ensureStringArray(input.audio));
        if (
          ensureStringArray(input.image).length === 0 &&
          ensureStringArray(input.video).length === 0 &&
          ensureStringArray(input.audio).length === 0
        ) {
          throw new DomainError("VALIDATION_ERROR", "Dreamina multimodal2video requires at least one reference input");
        }
        break;
      case "multiframe2video":
        {
          const images = ensureStringArray(input.image);
          if (images.length < 2 || images.length > 20) {
            throw new DomainError("VALIDATION_ERROR", "Dreamina multiframe2video requires 2..20 images");
          }
          args.push("--images", images.join(","));
          const transitionPrompts = ensureStringArray(input.transition_prompt as string | string[] | undefined);
          pushRepeated(args, "--transition-prompt", transitionPrompts);
          const rawDurations = input.transition_duration == null
            ? []
            : Array.isArray(input.transition_duration)
              ? input.transition_duration
              : [input.transition_duration];
          pushRepeated(args, "--transition-duration", rawDurations.map(String));
        }
        break;
      case "frames2video":
        if (!input.first_frame || !input.last_frame) {
          throw new DomainError("VALIDATION_ERROR", "Dreamina frames2video requires first_frame and last_frame");
        }
        args.push("--first", input.first_frame, "--last", input.last_frame);
        break;
      default:
        throw new DomainError("VALIDATION_ERROR", "Unsupported Dreamina video mode");
    }

    return args;
  }

  async submit(ctx: ProviderExecutionContext, request: Record<string, unknown>): Promise<ProviderSubmitResult> {
    const args = this.buildSubmitArgs(ctx, request);
    let result: CommandResult;
    try {
      result = await this.runner.run(this.executable, args, { timeoutMs: this.submitTimeoutMs });
    } catch (error) {
      throw new DomainError(
        "PROVIDER_SUBMISSION_UNKNOWN",
        error instanceof Error ? error.message : "Dreamina CLI submission outcome is unknown",
        true,
      );
    }

    if (result.timedOut) {
      throw new DomainError("PROVIDER_SUBMISSION_UNKNOWN", "Dreamina CLI submission timed out", true);
    }
    if (result.exitCode !== 0) {
      const message = (result.stderr || result.stdout || "Dreamina CLI submission failed").trim();
      const deterministic =
        /invalid param|validation|required|not logged|login|credit|compliance/i.test(message);
      throw new DomainError(
        deterministic ? "PROVIDER_REJECTED" : "PROVIDER_SUBMISSION_UNKNOWN",
        message,
        !deterministic,
      );
    }

    const task = parseJson(result.stdout);
    if (!task.submit_id) {
      throw new DomainError("PROVIDER_SUBMISSION_UNKNOWN", "Dreamina CLI returned no submit_id", true);
    }

    return { providerJobId: task.submit_id, status: "submitted" };
  }

  async getStatus(_ctx: ProviderExecutionContext, providerJobId: string): Promise<ProviderStatusResult> {
    const result = await this.runner.run(
      this.executable,
      ["query_result", "--submit_id", providerJobId],
      { timeoutMs: this.queryTimeoutMs },
    );

    if (result.timedOut) {
      throw new DomainError("PROVIDER_TEMPORARY_ERROR", "Dreamina CLI query timed out", true);
    }
    if (result.exitCode !== 0) {
      const message = (result.stderr || result.stdout || "Dreamina CLI query failed").trim();
      if (/not found/i.test(message)) return { status: "unknown" };
      throw new DomainError("PROVIDER_TEMPORARY_ERROR", message, true);
    }

    return mapTask(parseJson(result.stdout));
  }

  normalizeError(error: unknown) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message, retryable: error.retryable };
    }
    return {
      code: "PROVIDER_ERROR",
      message: error instanceof Error ? error.message : "Dreamina CLI provider error",
      retryable: false,
    };
  }
}
