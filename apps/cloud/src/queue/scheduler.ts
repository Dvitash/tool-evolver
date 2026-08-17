/**
 * Information about a scheduled recurring job.
 */
export interface ScheduledJobInfo {
  name: string;
  intervalMs: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  runCount: number;
  errorCount: number;
  isRunning: boolean;
}

/**
 * Task handler signature for scheduled jobs.
 */
export type ScheduledJobHandler = () => Promise<void>;

interface InternalScheduledJob {
  name: string;
  intervalMs: number;
  handler: ScheduledJobHandler;
  timer: NodeJS.Timeout | null;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  runCount: number;
  errorCount: number;
  isRunning: boolean;
}

/**
 * Periodic background job scheduler.
 */
export class JobScheduler {
  private jobs = new Map<string, InternalScheduledJob>();
  private isStarted = false;

  /**
   * Register a periodic job.
   */
  registerJob(name: string, intervalMs: number, handler: ScheduledJobHandler): void {
    if (this.jobs.has(name)) {
      this.unregisterJob(name);
    }

    const job: InternalScheduledJob = {
      name,
      intervalMs,
      handler,
      timer: null,
      runCount: 0,
      errorCount: 0,
      isRunning: false,
    };

    this.jobs.set(name, job);

    if (this.isStarted) {
      this.scheduleJob(job);
    }
  }

  /**
   * Unregister a scheduled job.
   */
  unregisterJob(name: string): void {
    const job = this.jobs.get(name);
    if (job) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      this.jobs.delete(name);
    }
  }

  /**
   * Start the scheduler and all registered jobs.
   */
  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;

    for (const job of this.jobs.values()) {
      this.scheduleJob(job);
    }
  }

  private scheduleJob(job: InternalScheduledJob): void {
    if (!this.isStarted) return;

    job.timer = setTimeout(async () => {
      await this.runJob(job);
      if (this.isStarted && this.jobs.has(job.name)) {
        this.scheduleJob(job);
      }
    }, job.intervalMs);
  }

  private async runJob(job: InternalScheduledJob): Promise<void> {
    if (job.isRunning) return; // Prevent overlapping runs of same job

    job.isRunning = true;
    job.lastRunAt = new Date().toISOString();
    job.runCount++;

    try {
      await job.handler();
      job.lastSuccessAt = new Date().toISOString();
      job.lastError = undefined;
    } catch (error) {
      job.errorCount++;
      job.lastErrorAt = new Date().toISOString();
      job.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      job.isRunning = false;
    }
  }

  /**
   * Manually trigger a scheduled job immediately.
   */
  async trigger(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) {
      throw new Error(`Scheduled job '${name}' not found`);
    }
    await this.runJob(job);
  }

  /**
   * Stop the scheduler and cancel all pending timers.
   */
  stop(): void {
    this.isStarted = false;
    for (const job of this.jobs.values()) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }
  }

  /**
   * Get metadata and execution status for all scheduled jobs.
   */
  getScheduledJobs(): ScheduledJobInfo[] {
    return Array.from(this.jobs.values()).map((job) => ({
      name: job.name,
      intervalMs: job.intervalMs,
      lastRunAt: job.lastRunAt,
      lastSuccessAt: job.lastSuccessAt,
      lastErrorAt: job.lastErrorAt,
      lastError: job.lastError,
      runCount: job.runCount,
      errorCount: job.errorCount,
      isRunning: job.isRunning,
    }));
  }
}
