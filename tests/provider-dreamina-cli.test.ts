import { describe, expect, it } from "vitest";
import {
  DreaminaCliProvider,
  type CommandResult,
  type CommandRunner,
} from "../packages/provider-dreamina-cli/src/index.js";

class StubRunner implements CommandRunner {
  calls: Array<{ executable: string; args: string[]; timeoutMs: number }> = [];
  private readonly results: CommandResult[];

  constructor(...results: CommandResult[]) {
    this.results = [...results];
  }

  async run(executable: string, args: string[], options: { timeoutMs: number }): Promise<CommandResult> {
    this.calls.push({ executable, args, timeoutMs: options.timeoutMs });
    const result = this.results.shift();
    if (!result) throw new Error("no stubbed command result");
    return result;
  }
}

const ctx = {
  tenantId: "tenant-a",
  workspaceId: "ws-a",
  jobId: "job-a",
  providerExecutionId: "pe-a",
  providerRequestKey: "req-a",
  providerModelId: "seedance2.0mini",
};

describe("DreaminaCliProvider", () => {
  it("submits text2video as argv without shell interpolation and returns submit_id", async () => {
    const runner = new StubRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        submit_id: "submit-123",
        gen_task_type: "text2video",
        gen_status: "pending",
      }),
      stderr: "",
      timedOut: false,
    });
    const provider = new DreaminaCliProvider({
      executable: "C:\\Users\\Administrator\\bin\\dreamina.exe",
      commandRunner: runner,
    });

    await expect(provider.submit(ctx, {
      mode: "text2video",
      prompt: "cinematic shot && echo SHOULD_NOT_RUN",
      duration: 5,
      ratio: "9:16",
      video_resolution: "720p",
    })).resolves.toEqual({
      providerJobId: "submit-123",
      status: "submitted",
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].executable).toContain("dreamina.exe");
    expect(runner.calls[0].args).toEqual([
      "text2video",
      "--prompt", "cinematic shot && echo SHOULD_NOT_RUN",
      "--model_version", "seedance2.0mini",
      "--video_resolution", "720p",
      "--duration", "5",
      "--ratio", "9:16",
      "--poll", "0",
    ]);
  });

  it("uses the real frames2video --first/--last CLI flags", async () => {
    const runner = new StubRunner({
      exitCode: 0,
      stdout: JSON.stringify({ submit_id: "frames-1", gen_status: "pending" }),
      stderr: "",
      timedOut: false,
    });
    const provider = new DreaminaCliProvider({ commandRunner: runner });

    await provider.submit(ctx, {
      mode: "frames2video",
      first_frame: "C:\\tmp\\first.png",
      last_frame: "C:\\tmp\\last.png",
      prompt: "season changes",
      duration: 5,
      video_resolution: "720p",
    });

    expect(runner.calls[0].args).toEqual([
      "frames2video",
      "--prompt", "season changes",
      "--model_version", "seedance2.0mini",
      "--video_resolution", "720p",
      "--duration", "5",
      "--poll", "0",
      "--first", "C:\\tmp\\first.png",
      "--last", "C:\\tmp\\last.png",
    ]);
  });

  it("uses multiframe2video fixed model semantics and comma-separated --images", async () => {
    const runner = new StubRunner({
      exitCode: 0,
      stdout: JSON.stringify({ submit_id: "multi-1", gen_status: "pending" }),
      stderr: "",
      timedOut: false,
    });
    const provider = new DreaminaCliProvider({ commandRunner: runner });

    await provider.submit({ ...ctx, providerModelId: undefined }, {
      mode: "multiframe2video",
      image: ["C:\\tmp\\a.png", "C:\\tmp\\b.png", "C:\\tmp\\c.png"],
      transition_prompt: ["A to B", "B to C"],
      transition_duration: [3, 4],
      video_resolution: "1080p",
    });

    expect(runner.calls[0].args).toEqual([
      "multiframe2video",
      "--video_resolution", "1080p",
      "--poll", "0",
      "--images", "C:\\tmp\\a.png,C:\\tmp\\b.png,C:\\tmp\\c.png",
      "--transition-prompt", "A to B",
      "--transition-prompt", "B to C",
      "--transition-duration", "3",
      "--transition-duration", "4",
    ]);
    expect(runner.calls[0].args).not.toContain("--model_version");
  });

  it("maps submit timeout to unknown so the caller reconciles instead of blind retry", async () => {
    const runner = new StubRunner({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const provider = new DreaminaCliProvider({ commandRunner: runner, submitTimeoutMs: 50 });

    await expect(provider.submit(ctx, {
      mode: "text2video",
      prompt: "test",
      video_resolution: "720p",
    })).rejects.toMatchObject({
      code: "PROVIDER_SUBMISSION_UNKNOWN",
      retryable: true,
    });
  });

  it("maps query_result success URLs and deterministic failure fields", async () => {
    const runner = new StubRunner(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          submit_id: "task-success",
          gen_status: "success",
          result: {
            video_url: "https://cdn.example.com/video.mp4",
            cover_url: "https://cdn.example.com/cover.jpg",
          },
        }),
        stderr: "",
        timedOut: false,
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          submit_id: "task-fail",
          gen_status: "fail",
          fail_reason: "invalid param:version",
        }),
        stderr: "",
        timedOut: false,
      },
    );
    const provider = new DreaminaCliProvider({ commandRunner: runner });

    await expect(provider.getStatus(ctx, "task-success")).resolves.toEqual({
      status: "succeeded",
      outputs: [
        { url: "https://cdn.example.com/video.mp4" },
        { url: "https://cdn.example.com/cover.jpg" },
      ],
    });
    await expect(provider.getStatus(ctx, "task-fail")).resolves.toEqual({
      status: "failed",
      error: {
        providerCode: "DREAMINA_FAILED",
        message: "invalid param:version",
        retryable: false,
      },
    });
  });

  it("maps an unknown local submit_id to provider status unknown", async () => {
    const runner = new StubRunner({
      exitCode: 1,
      stdout: "",
      stderr: 'task "missing" not found',
      timedOut: false,
    });
    const provider = new DreaminaCliProvider({ commandRunner: runner });

    await expect(provider.getStatus(ctx, "missing")).resolves.toEqual({ status: "unknown" });
  });
});
