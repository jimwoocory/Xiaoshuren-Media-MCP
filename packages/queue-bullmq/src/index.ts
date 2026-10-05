import { Job, Queue, Worker, type JobsOptions, type QueueOptions, type WorkerOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import type { QueuePort } from "@xiaoshuren/workers";

export type QueueEnvelope = {
  topic: string;
  payload: Record<string, unknown>;
};

export type QueueMetrics = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

type QueueLike = {
  add(name: string, data: QueueEnvelope, options?: JobsOptions): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  close(): Promise<void>;
};

export type BullMqQueuePortOptions = {
  attempts?: number;
  backoffMs?: number;
  removeOnComplete?: number;
  removeOnFail?: boolean | number;
};

export class BullMqQueuePort implements QueuePort {
  constructor(
    private readonly queue: QueueLike,
    private readonly defaults: BullMqQueuePortOptions = {},
  ) {}

  async enqueue(
    topic: string,
    payload: Record<string, unknown>,
    options?: { delayMs?: number; attempts?: number; backoffMs?: number },
  ): Promise<void> {
    const attempts = options?.attempts ?? this.defaults.attempts ?? 8;
    const backoffMs = options?.backoffMs ?? this.defaults.backoffMs ?? 5_000;

    await this.queue.add(topic, { topic, payload }, {
      delay: options?.delayMs,
      attempts,
      backoff: attempts > 1 ? { type: "exponential", delay: backoffMs } : undefined,
      removeOnComplete: this.defaults.removeOnComplete ?? 1_000,
      removeOnFail: this.defaults.removeOnFail ?? false,
    });
  }

  async metrics(): Promise<QueueMetrics> {
    const counts = await this.queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
    };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export type QueueHandler = (payload: Record<string, unknown>, job: Job<QueueEnvelope>) => Promise<void>;

export class BullMqWorkerHost {
  private worker?: Worker<QueueEnvelope>;

  constructor(
    private readonly queueName: string,
    private readonly connection: Redis,
    private readonly handlers: Record<string, QueueHandler>,
    private readonly concurrency = 8,
  ) {}

  start(): void {
    if (this.worker) return;

    const options: WorkerOptions = {
      connection: this.connection,
      concurrency: this.concurrency,
    };

    this.worker = new Worker<QueueEnvelope>(
      this.queueName,
      async job => {
        const handler = this.handlers[job.data.topic];
        if (!handler) throw new Error(`No queue handler registered for topic ${job.data.topic}`);
        await handler(job.data.payload, job);
      },
      options,
    );
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = undefined;
    }
  }
}

export type BullMqRuntime = {
  queue: BullMqQueuePort;
  worker: BullMqWorkerHost;
  redis: Redis;
};

export const createBullMqRuntime = (
  redisUrl: string,
  queueName: string,
  handlers: Record<string, QueueHandler>,
  options?: {
    concurrency?: number;
    queue?: BullMqQueuePortOptions;
    redis?: RedisOptions;
  },
): BullMqRuntime => {
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...options?.redis,
  });
  const queueOptions: QueueOptions = { connection: redis };
  const queue = new Queue<QueueEnvelope>(queueName, queueOptions);

  return {
    queue: new BullMqQueuePort(queue, options?.queue),
    worker: new BullMqWorkerHost(queueName, redis, handlers, options?.concurrency ?? 8),
    redis,
  };
};
