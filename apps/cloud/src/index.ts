/**
 * @tool-evolver/cloud
 *
 * Cloud service platform, persistence, queue, storage, and worker runtime.
 */

import { CloudConfig, RawCloudConfig, loadConfig } from "./config.js";
import { DatabasePool, createDatabasePool } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import { OutboxPublisher } from "./db/outbox.js";
import { DurableQueue, createDurableQueue } from "./queue/queue.js";
import { WorkerRuntime } from "./queue/worker.js";
import { JobScheduler } from "./queue/scheduler.js";
import { ObjectStore, createObjectStore } from "./storage/object-store.js";
import { CloudServer, createCloudServer } from "./server/api.js";
import { AuthService, createAuthService } from "./auth/index.js";

// Configuration & Validation
export * from "./config.js";

// Tenant Context & Deny-by-Default Guard
export * from "./tenant.js";

// Database Layer (Pool, Client, Migrations, Outbox)
export * from "./db/index.js";

// Content-Addressed Storage
export * from "./storage/index.js";

// Durable Queue, Envelope, Worker Runtime & Scheduler
export * from "./queue/index.js";
// Model Gateway & Structured Inference
export * from "./models/index.js";
// Identity & Authentication
export * from "./auth/index.js";

// HTTP API Server
export * from "./server/index.js";

/**
 * Unified Cloud Service container aggregating persistence, storage,
 * queue, server, and background workers.
 */
export class CloudService {
  readonly config: CloudConfig;
  readonly dbPool: DatabasePool;
  readonly objectStore: ObjectStore;
  readonly queue: DurableQueue;
  readonly outboxPublisher: OutboxPublisher;
  readonly authService: AuthService;
  readonly worker: WorkerRuntime;
  readonly scheduler: JobScheduler;
  readonly server: CloudServer;

  private isInitialized = false;

  constructor(options: { config?: Partial<RawCloudConfig> } = {}) {
    this.config = loadConfig(options.config);
    this.dbPool = createDatabasePool(this.config.database);
    this.objectStore = createObjectStore(this.config.storage);
    this.queue = createDurableQueue(this.config.queue, this.dbPool);
    this.outboxPublisher = new OutboxPublisher(this.dbPool);
    this.authService = createAuthService({
      config: this.config.auth,
    });
    this.worker = new WorkerRuntime(this.queue, {
      concurrency: this.config.queue.concurrency,
      pollIntervalMs: this.config.queue.pollIntervalMs,
      jobTimeoutMs: this.config.queue.visibilityTimeoutMs,
    });
    this.scheduler = new JobScheduler();
    this.server = createCloudServer({
      config: this.config,
      dbPool: this.dbPool,
      objectStore: this.objectStore,
      queue: this.queue,
      outboxPublisher: this.outboxPublisher,
      authService: this.authService,
    });
  }

  /**
   * Initialize cloud service, run database migrations, and start background workers.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Run database migrations
    await runMigrations(this.dbPool);

    // Initialize worker runtime
    await this.worker.start();

    this.isInitialized = true;
  }

  /**
   * Start the HTTP API server.
   */
  async start(port?: number, host?: string): Promise<number> {
    await this.initialize();
    return this.server.start(port, host);
  }

  /**
   * Graceful teardown of server, worker runtime, and persistence pools.
   */
  async stop(): Promise<void> {
    await this.server.stop();
    await this.worker.stop();
    await this.scheduler.stop();
    await this.dbPool.end();
    this.isInitialized = false;
  }
  /**
   * Alias for stop().
   */
  async shutdown(): Promise<void> {
    await this.stop();
  }
}

/**
 * Factory function creating a CloudService instance.
 */
export function createCloudService(options: { config?: Partial<RawCloudConfig> } = {}): CloudService {
  return new CloudService(options);
}
