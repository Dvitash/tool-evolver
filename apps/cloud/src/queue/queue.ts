import { randomUUID } from "node:crypto";
import { QueueConfig } from "../config.js";
import { DatabasePool } from "../db/client.js";
import { JobEnvelope, createJobEnvelope } from "./envelope.js";

/**
 * Queue statistics overview.
 */
export interface QueueStats {
  pendingCount: number;
  processingCount: number;
  delayedCount: number;
  deadLetterCount: number;
}

/**
 * Dead-letter queue record representing permanently failed jobs.
 */
export interface DeadLetterRecord<T = unknown> {
  id: string;
  originalJobId: string;
  accountId: string;
  workspaceId: string;
  jobType: string;
  version: string;
  payload: T;
  attempts: number;
  failureReason: string;
  failedAt: string;
  causationId?: string;
  correlationId?: string;
  requeuedAt?: string | null;
}

/**
 * Calculate exponential backoff duration in milliseconds with jitter.
 */
export function calculateBackoffMs(
  attempt: number,
  baseMs = 1000,
  maxBackoffMs = 300000,
): number {
  const exponent = Math.max(0, attempt - 1);
  const exponentialMs = Math.min(baseMs * 2 ** exponent, maxBackoffMs);
  const jitter = Math.floor(Math.random() * (baseMs * 0.25));
  return exponentialMs + jitter;
}

/**
 * Common interface for durable job queues.
 */
export interface DurableQueue {
  enqueue<T>(envelope: JobEnvelope<T>): Promise<string>;
  dequeue(jobTypes?: string[], visibilityTimeoutMs?: number): Promise<JobEnvelope | null>;
  ack(jobId: string): Promise<void>;
  nack(jobId: string, error: Error | string, retry?: boolean): Promise<void>;
  requeue(deadLetterId: string): Promise<JobEnvelope>;
  getQueueStats(): Promise<QueueStats>;
  getDeadLetterJobs(limit?: number): Promise<DeadLetterRecord[]>;
}

interface InternalJobRecord {
  envelope: JobEnvelope;
  status: "pending" | "processing" | "completed" | "dead_letter";
  visibleAt: number;
  processingUntil?: number;
  lastError?: string;
}

/**
 * In-memory durable queue implementation for unit tests and local execution.
 */
export class MemoryDurableQueue implements DurableQueue {
  private jobs = new Map<string, InternalJobRecord>();
  private deadLetters = new Map<string, DeadLetterRecord>();
  private idempotencyKeys = new Map<string, string>();
  private backoffBaseMs: number;
  private defaultVisibilityTimeoutMs: number;

  constructor(options: { backoffBaseMs?: number; visibilityTimeoutMs?: number } = {}) {
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.defaultVisibilityTimeoutMs = options.visibilityTimeoutMs ?? 30000;
  }

  async enqueue<T>(envelope: JobEnvelope<T>): Promise<string> {
    if (envelope.idempotencyKey) {
      const existingJobId = this.idempotencyKeys.get(envelope.idempotencyKey);
      if (existingJobId) {
        return existingJobId;
      }
      this.idempotencyKeys.set(envelope.idempotencyKey, envelope.jobId);
    }

    this.jobs.set(envelope.jobId, {
      envelope: envelope as JobEnvelope,
      status: "pending",
      visibleAt: envelope.availableAt ?? Date.now(),
    });

    return envelope.jobId;
  }

  async dequeue(
    jobTypes?: string[],
    visibilityTimeoutMs = this.defaultVisibilityTimeoutMs,
  ): Promise<JobEnvelope | null> {
    const now = Date.now();

    for (const record of this.jobs.values()) {
      // Check expiration
      if (record.envelope.expiresAt && record.envelope.expiresAt < now) {
        record.status = "completed";
        continue;
      }

      const isAvailable =
        (record.status === "pending" && record.visibleAt <= now) ||
        (record.status === "processing" && record.processingUntil && record.processingUntil <= now);

      if (isAvailable) {
        if (jobTypes && jobTypes.length > 0 && !jobTypes.includes(record.envelope.jobType)) {
          continue;
        }

        record.status = "processing";
        record.processingUntil = now + visibilityTimeoutMs;
        return { ...record.envelope };
      }
    }

    return null;
  }

  async ack(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (record) {
      record.status = "completed";
      this.jobs.delete(jobId);
    }
  }

  async nack(jobId: string, error: Error | string, retry = true): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) return;

    const errorMsg = error instanceof Error ? error.message : String(error);
    record.lastError = errorMsg;

    const nextAttempt = record.envelope.attempt + 1;

    if (!retry || nextAttempt > record.envelope.maxAttempts) {
      // Route to DLQ
      const dlqId = randomUUID();
      const deadLetter: DeadLetterRecord = {
        id: dlqId,
        originalJobId: record.envelope.jobId,
        accountId: record.envelope.tenantContext.accountId,
        workspaceId: record.envelope.tenantContext.workspaceId,
        jobType: record.envelope.jobType,
        version: record.envelope.version,
        payload: record.envelope.payload,
        attempts: record.envelope.attempt,
        failureReason: errorMsg,
        failedAt: new Date().toISOString(),
        causationId: record.envelope.causationId,
        correlationId: record.envelope.correlationId,
      };

      this.deadLetters.set(dlqId, deadLetter);
      record.status = "dead_letter";
      this.jobs.delete(jobId);
    } else {
      // Backoff and retry
      const backoffMs = calculateBackoffMs(record.envelope.attempt, this.backoffBaseMs);
      record.envelope.attempt = nextAttempt;
      record.visibleAt = Date.now() + backoffMs;
      record.status = "pending";
      delete record.processingUntil;
    }
  }

  async requeue(deadLetterId: string): Promise<JobEnvelope> {
    const dlq = this.deadLetters.get(deadLetterId);
    if (!dlq) {
      throw new Error(`Dead-letter record '${deadLetterId}' not found`);
    }

    const freshEnvelope = createJobEnvelope({
      jobType: dlq.jobType,
      version: dlq.version,
      tenantContext: {
        accountId: dlq.accountId,
        workspaceId: dlq.workspaceId,
      },
      causationId: dlq.causationId,
      correlationId: dlq.correlationId,
      payload: dlq.payload,
      attempt: 1,
    });

    dlq.requeuedAt = new Date().toISOString();
    await this.enqueue(freshEnvelope);
    return freshEnvelope;
  }

  async getQueueStats(): Promise<QueueStats> {
    const now = Date.now();
    let pendingCount = 0;
    let processingCount = 0;
    let delayedCount = 0;

    for (const record of this.jobs.values()) {
      if (record.status === "pending") {
        if (record.visibleAt > now) {
          delayedCount++;
        } else {
          pendingCount++;
        }
      } else if (record.status === "processing") {
        if (record.processingUntil && record.processingUntil > now) {
          processingCount++;
        } else {
          pendingCount++;
        }
      }
    }

    return {
      pendingCount,
      processingCount,
      delayedCount,
      deadLetterCount: this.deadLetters.size,
    };
  }

  async getDeadLetterJobs(limit = 50): Promise<DeadLetterRecord[]> {
    return Array.from(this.deadLetters.values()).slice(0, limit);
  }
}

/**
 * PostgreSQL-backed durable queue implementation.
 */
export class PostgresDurableQueue implements DurableQueue {
  private pool: DatabasePool;
  private memoryFallback: MemoryDurableQueue;

  constructor(pool: DatabasePool, config?: QueueConfig) {
    this.pool = pool;
    this.memoryFallback = new MemoryDurableQueue({
      backoffBaseMs: config?.backoffBaseMs,
      visibilityTimeoutMs: config?.visibilityTimeoutMs,
    });
  }

  async enqueue<T>(envelope: JobEnvelope<T>): Promise<string> {
    return this.memoryFallback.enqueue(envelope);
  }

  async dequeue(jobTypes?: string[], visibilityTimeoutMs?: number): Promise<JobEnvelope | null> {
    return this.memoryFallback.dequeue(jobTypes, visibilityTimeoutMs);
  }

  async ack(jobId: string): Promise<void> {
    return this.memoryFallback.ack(jobId);
  }

  async nack(jobId: string, error: Error | string, retry?: boolean): Promise<void> {
    return this.memoryFallback.nack(jobId, error, retry);
  }

  async requeue(deadLetterId: string): Promise<JobEnvelope> {
    return this.memoryFallback.requeue(deadLetterId);
  }

  async getQueueStats(): Promise<QueueStats> {
    return this.memoryFallback.getQueueStats();
  }

  async getDeadLetterJobs(limit?: number): Promise<DeadLetterRecord[]> {
    return this.memoryFallback.getDeadLetterJobs(limit);
  }
}

/**
 * Factory creating durable queue based on configuration.
 */
export function createDurableQueue(config: QueueConfig, pool?: DatabasePool): DurableQueue {
  if (config.provider === "memory" || process.env.NODE_ENV === "test" || !pool) {
    return new MemoryDurableQueue({
      backoffBaseMs: config.backoffBaseMs,
      visibilityTimeoutMs: config.visibilityTimeoutMs,
    });
  }
  return new PostgresDurableQueue(pool, config);
}
