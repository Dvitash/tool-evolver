import { EventEmitter } from "node:events";
import type { RawHarnessRecord } from "@tool-evolver/harness-contracts";

/**
 * Classification reasons for routing a raw record to the Dead Letter Queue.
 */
export type DeadLetterReason =
  | "MALFORMED_RECORD"
  | "PAYLOAD_TOO_LARGE"
  | "PROCESSING_TIMEOUT"
  | "RETRY_EXHAUSTED"
  | "CORRUPT_JSON"
  | "UNHANDLED_ERROR";

/**
 * Structure of a record routed to the Dead Letter Queue.
 */
export interface DeadLetterRecord {
  record: RawHarnessRecord;
  reason: DeadLetterReason;
  error?: string;
  failedAt: string;
  retryAttempts: number;
}

/**
 * Metrics describing the state of a BoundedRecordQueue.
 */
export interface QueueMetrics {
  sessionId: string;
  size: number;
  capacity: number;
  highWatermark: number;
  lowWatermark: number;
  isBackpressured: boolean;
  isPaused: boolean;
  enqueuedTotal: number;
  dequeuedTotal: number;
  ackedTotal: number;
  nackedTotal: number;
  deadLetterCount: number;
  droppedTotal: number;
}

/**
 * Options for configuring BoundedRecordQueue.
 */
export interface BoundedRecordQueueOptions {
  sessionId: string;
  /**
   * Maximum number of raw records allowed in queue before dropping or blocking.
   * Defaults to 1000.
   */
  capacity?: number;
  /**
   * High watermark ratio or absolute count to trigger backpressure pause.
   * Defaults to 0.8 (80% of capacity).
   */
  highWatermarkRatio?: number;
  /**
   * Low watermark ratio or absolute count to trigger backpressure resume.
   * Defaults to 0.2 (20% of capacity).
   */
  lowWatermarkRatio?: number;
  /**
   * Maximum retry attempts before routing a nack'd record to DLQ.
   * Defaults to 3.
   */
  maxRetries?: number;
  /**
   * Drop policy when capacity is strictly exceeded: "reject" | "drop_oldest".
   * Defaults to "reject".
   */
  dropPolicy?: "reject" | "drop_oldest";
}

/**
 * Per-source bounded raw-record queue with backpressure, pause/resume signaling,
 * retry tracking, and dead-letter classification.
 */
export class BoundedRecordQueue extends EventEmitter {
  readonly sessionId: string;
  readonly capacity: number;
  readonly highWatermark: number;
  readonly lowWatermark: number;
  readonly maxRetries: number;
  readonly dropPolicy: "reject" | "drop_oldest";

  private queue: RawHarnessRecord[] = [];
  private inFlight = new Map<string, RawHarnessRecord>();
  private attemptCounts = new Map<string, number>();
  private deadLetters: DeadLetterRecord[] = [];

  private _isBackpressured = false;
  private _isPaused = false;

  private enqueuedTotal = 0;
  private dequeuedTotal = 0;
  private ackedTotal = 0;
  private nackedTotal = 0;
  private droppedTotal = 0;

  constructor(options: BoundedRecordQueueOptions) {
    super();
    this.sessionId = options.sessionId;
    this.capacity = options.capacity ?? 1000;
    this.highWatermark = Math.max(
      1,
      Math.floor(this.capacity * (options.highWatermarkRatio ?? 0.8)),
    );
    this.lowWatermark = Math.max(
      0,
      Math.floor(this.capacity * (options.lowWatermarkRatio ?? 0.2)),
    );
    this.maxRetries = options.maxRetries ?? 3;
    this.dropPolicy = options.dropPolicy ?? "reject";
  }

  /**
   * Current number of queued (pending) records.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Whether the queue is currently in a backpressured state.
   */
  get isBackpressured(): boolean {
    return this._isBackpressured;
  }

  /**
   * Whether the upstream source should be paused.
   */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Enqueues a single record. Returns true if accepted, false if rejected due to full capacity.
   */
  enqueue(record: RawHarnessRecord): boolean {
    if (this.queue.length >= this.capacity) {
      if (this.dropPolicy === "drop_oldest") {
        this.queue.shift();
        this.droppedTotal++;
      } else {
        this.droppedTotal++;
        return false;
      }
    }

    this.queue.push(record);
    this.enqueuedTotal++;

    this.checkWatermarks();
    return true;
  }

  /**
   * Enqueues a batch of records. Returns count of accepted vs rejected records.
   */
  enqueueBatch(records: RawHarnessRecord[]): {
    accepted: number;
    rejected: number;
    backpressured: boolean;
  } {
    let accepted = 0;
    let rejected = 0;

    for (const record of records) {
      if (this.enqueue(record)) {
        accepted++;
      } else {
        rejected++;
      }
    }

    return {
      accepted,
      rejected,
      backpressured: this._isBackpressured,
    };
  }

  /**
   * Dequeues up to maxBatchSize records for downstream processing and tracks them as in-flight.
   */
  dequeue(maxBatchSize = 100): RawHarnessRecord[] {
    const batch = this.queue.splice(0, maxBatchSize);
    for (const record of batch) {
      this.inFlight.set(record.recordId, record);
      this.dequeuedTotal++;
    }

    this.checkWatermarks();
    return batch;
  }

  /**
   * Peeks at the next records in queue without removing or marking in-flight.
   */
  peek(maxBatchSize = 100): RawHarnessRecord[] {
    return this.queue.slice(0, maxBatchSize);
  }

  /**
   * Acknowledges successful downstream processing of records.
   */
  ack(recordIds: string | string[]): void {
    const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
    for (const id of ids) {
      this.inFlight.delete(id);
      this.attemptCounts.delete(id);
      this.ackedTotal++;
    }
  }

  /**
   * Rejects a record. Increments retry attempts; if maxRetries is exceeded,
   * routes to Dead Letter Queue. Otherwise re-queues at head of queue.
   */
  nack(
    recordId: string,
    error?: Error | string,
    forcedReason?: DeadLetterReason,
  ): void {
    this.nackedTotal++;
    const record = this.inFlight.get(recordId);
    this.inFlight.delete(recordId);

    const attempts = (this.attemptCounts.get(recordId) ?? 0) + 1;
    this.attemptCounts.set(recordId, attempts);

    const errorMessage = error instanceof Error ? error.message : (error ?? "Unknown processing error");

    if (!record) {
      return;
    }

    if (forcedReason || attempts >= this.maxRetries) {
      // Route to Dead Letter Queue
      const reason: DeadLetterReason =
        forcedReason ?? (attempts >= this.maxRetries ? "RETRY_EXHAUSTED" : "UNHANDLED_ERROR");

      const deadLetter: DeadLetterRecord = {
        record,
        reason,
        error: errorMessage,
        failedAt: new Date().toISOString(),
        retryAttempts: attempts,
      };

      this.deadLetters.push(deadLetter);
      this.attemptCounts.delete(recordId);
      this.emit("deadLetter", deadLetter);
    } else {
      // Re-queue at the front for immediate retry
      this.queue.unshift(record);
      this.checkWatermarks();
    }
  }

  /**
   * Inspects and triggers watermark events (pause / resume).
   */
  private checkWatermarks(): void {
    if (!this._isBackpressured && this.queue.length >= this.highWatermark) {
      this._isBackpressured = true;
      this._isPaused = true;
      this.emit("pause", {
        sessionId: this.sessionId,
        queueSize: this.queue.length,
        highWatermark: this.highWatermark,
      });
    } else if (this._isBackpressured && this.queue.length <= this.lowWatermark) {
      this._isBackpressured = false;
      this._isPaused = false;
      this.emit("resume", {
        sessionId: this.sessionId,
        queueSize: this.queue.length,
        lowWatermark: this.lowWatermark,
      });
    }
  }

  /**
   * Manually pause upstream reading.
   */
  pause(): void {
    this._isPaused = true;
    this.emit("pause", { sessionId: this.sessionId, queueSize: this.queue.length, manual: true });
  }

  /**
   * Manually resume upstream reading (if watermark allows).
   */
  resume(): void {
    if (this.queue.length < this.highWatermark) {
      this._isPaused = false;
      this._isBackpressured = false;
      this.emit("resume", { sessionId: this.sessionId, queueSize: this.queue.length, manual: true });
    }
  }

  /**
   * Returns copy of all dead-letter records.
   */
  getDeadLetters(): DeadLetterRecord[] {
    return [...this.deadLetters];
  }

  /**
   * Retries a dead-letter record by re-inserting it into queue and clearing its DLQ entry.
   */
  retryDeadLetter(recordId: string): boolean {
    const index = this.deadLetters.findIndex((dl) => dl.record.recordId === recordId);
    if (index === -1) return false;

    const [dl] = this.deadLetters.splice(index, 1);
    this.attemptCounts.delete(recordId);
    this.queue.push(dl.record);
    this.checkWatermarks();
    return true;
  }

  /**
   * Clears the dead-letter records.
   */
  clearDeadLetters(): void {
    this.deadLetters.length = 0;
  }

  /**
   * Clears all queued, in-flight, and dead-letter records.
   */
  clear(): void {
    this.queue.length = 0;
    this.inFlight.clear();
    this.attemptCounts.clear();
    this.deadLetters.length = 0;
    this._isBackpressured = false;
    this._isPaused = false;
  }

  /**
   * Returns current queue diagnostics and telemetry metrics.
   */
  getMetrics(): QueueMetrics {
    return {
      sessionId: this.sessionId,
      size: this.queue.length,
      capacity: this.capacity,
      highWatermark: this.highWatermark,
      lowWatermark: this.lowWatermark,
      isBackpressured: this._isBackpressured,
      isPaused: this._isPaused,
      enqueuedTotal: this.enqueuedTotal,
      dequeuedTotal: this.dequeuedTotal,
      ackedTotal: this.ackedTotal,
      nackedTotal: this.nackedTotal,
      deadLetterCount: this.deadLetters.length,
      droppedTotal: this.droppedTotal,
    };
  }
}
