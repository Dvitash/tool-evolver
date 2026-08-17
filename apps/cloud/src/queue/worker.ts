import { JobEnvelope } from "./envelope.js";
import { DurableQueue } from "./queue.js";

/**
 * Handler function signature for processing a job.
 */
export type JobHandler<T = unknown> = (
  job: JobEnvelope<T>,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Options for configuring the WorkerRuntime.
 */
export interface WorkerRuntimeOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  jobTimeoutMs?: number;
  jobTypes?: string[];
}

/**
 * Worker runtime that processes queued jobs with concurrency management,
 * timeout enforcement, and graceful shutdown.
 */
export class WorkerRuntime {
  private queue: DurableQueue;
  private handlers = new Map<string, JobHandler>();
  private concurrency: number;
  private pollIntervalMs: number;
  private jobTimeoutMs: number;
  private jobTypes?: string[];

  private activeJobs = new Set<string>();
  private activeControllers = new Map<string, AbortController>();
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(queue: DurableQueue, options: WorkerRuntimeOptions = {}) {
    this.queue = queue;
    this.concurrency = options.concurrency ?? 10;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 30000;
    this.jobTypes = options.jobTypes;
  }

  /**
   * Register a handler function for a specific job type.
   */
  registerHandler<T = unknown>(jobType: string, handler: JobHandler<T>): void {
    this.handlers.set(jobType, handler as JobHandler);
  }

  /**
   * Start the worker processing loop.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.scheduleNextPoll(0);
  }

  private scheduleNextPoll(delayMs = this.pollIntervalMs): void {
    if (!this.isRunning) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);

    this.pollTimer = setTimeout(async () => {
      await this.poll();
      if (this.isRunning) {
        this.scheduleNextPoll();
      }
    }, delayMs);
  }

  private async poll(): Promise<void> {
    while (this.isRunning && this.activeJobs.size < this.concurrency) {
      try {
        const job = await this.queue.dequeue(this.jobTypes, this.jobTimeoutMs);
        if (!job) {
          break; // No jobs available right now
        }

        this.processJob(job);
      } catch {
        break;
      }
    }
  }

  private async processJob(job: JobEnvelope): Promise<void> {
    this.activeJobs.add(job.jobId);
    const controller = new AbortController();
    this.activeControllers.set(job.jobId, controller);

    const timeoutTimer = setTimeout(() => {
      controller.abort(new Error(`Job '${job.jobId}' (${job.jobType}) timed out after ${this.jobTimeoutMs}ms`));
    }, this.jobTimeoutMs);

    try {
      const handler = this.handlers.get(job.jobType);
      if (!handler) {
        throw new Error(`No registered handler for job type '${job.jobType}'`);
      }

      await handler(job, controller.signal);
      await this.queue.ack(job.jobId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.queue.nack(job.jobId, err);
    } finally {
      clearTimeout(timeoutTimer);
      this.activeControllers.delete(job.jobId);
      this.activeJobs.delete(job.jobId);

      // Try dequeueing more if we have slots
      if (this.isRunning && this.activeJobs.size < this.concurrency) {
        this.scheduleNextPoll(0);
      }
    }
  }

  /**
   * Stop the worker runtime gracefully, allowing active jobs to drain.
   */
  async stop(drainTimeoutMs = 10000): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.activeJobs.size === 0) {
      return;
    }

    const start = Date.now();
    while (this.activeJobs.size > 0 && Date.now() - start < drainTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Force abort remaining jobs if drain timed out
    for (const controller of this.activeControllers.values()) {
      controller.abort(new Error("Worker is shutting down (forced timeout)"));
    }
  }

  /**
   * Return number of currently active jobs.
   */
  getActiveJobCount(): number {
    return this.activeJobs.size;
  }
}
