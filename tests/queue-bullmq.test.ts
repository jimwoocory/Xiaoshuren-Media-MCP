import { describe, expect, it } from "vitest";
import { BullMqQueuePort } from "../packages/queue-bullmq/src/index.js";

describe("BullMqQueuePort", () => {
  it("configures delayed at-least-once delivery with exponential retry and retained failures", async () => {
    const calls: Array<{ name: string; data: unknown; options: any }> = [];
    const fakeQueue = {
      async add(name: string, data: unknown, options: any) {
        calls.push({ name, data, options });
      },
      async getJobCounts() {
        return { waiting: 2, active: 1, delayed: 3, failed: 4, completed: 5 };
      },
      async close() {},
    };
    const queue = new BullMqQueuePort(fakeQueue, {
      attempts: 8,
      backoffMs: 5_000,
      removeOnComplete: 500,
      removeOnFail: false,
    });

    await queue.enqueue("provider.poll.requested", { jobId: "job-a" }, { delayMs: 15_000 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "provider.poll.requested",
      data: { topic: "provider.poll.requested", payload: { jobId: "job-a" } },
      options: {
        delay: 15_000,
        attempts: 8,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 500,
        removeOnFail: false,
      },
    });
    await expect(queue.metrics()).resolves.toEqual({
      waiting: 2,
      active: 1,
      delayed: 3,
      failed: 4,
      completed: 5,
    });
  });

  it("can disable retries per message without adding a backoff policy", async () => {
    let options: any;
    const fakeQueue = {
      async add(_name: string, _data: unknown, value: any) { options = value; },
      async getJobCounts() { return {}; },
      async close() {},
    };
    const queue = new BullMqQueuePort(fakeQueue);
    await queue.enqueue("provider.webhook.received", { eventId: "evt-1" }, { attempts: 1 });
    expect(options.attempts).toBe(1);
    expect(options.backoff).toBeUndefined();
  });
});
