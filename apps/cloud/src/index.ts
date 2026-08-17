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
import type { JobEnvelope } from "./queue/envelope.js";
import { ObjectStore, createObjectStore } from "./storage/object-store.js";
import {
  ObservationRepository,
  SessionRepository,
  EvidenceRepository,
  RetentionRepository,
  StoreObservationBatchConsumer,
  RetentionService,
  ExportService,
} from "./storage/index.js";
import type { StoreObservationBatchPayload } from "./storage/index.js";
import { CloudServer, createCloudServer } from "./server/api.js";
import {
  ObservationIngestionService,
  createObservationIngestionService,
} from "./ingestion/index.js";
import { AuthService, createAuthService } from "./auth/index.js";

// Configuration & Validation
export * from "./config.js";

// Tenant Context & Deny-by-Default Guard
export * from "./tenant.js";

// Database Layer (Pool, Client, Migrations, Outbox)
export * from "./db/index.js";

// Content-Addressed Storage, Observations, Sessions & Evidence
export * from "./storage/index.js";

// Durable Queue, Envelope, Worker Runtime & Scheduler
export * from "./queue/index.js";
// Model Gateway & Structured Inference
export * from "./models/index.js";
// Identity & Authentication
export * from "./auth/index.js";

// Normalized Observation Ingestion & Deduplication
export * from "./ingestion/index.js";

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
  readonly ingestionService: ObservationIngestionService;
  readonly observationRepo: ObservationRepository;
  readonly sessionRepo: SessionRepository;
  readonly evidenceRepo: EvidenceRepository;
  readonly retentionRepo: RetentionRepository;
  readonly observationConsumer: StoreObservationBatchConsumer;
  readonly retentionService: RetentionService;
  readonly exportService: ExportService;

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
    this.ingestionService = createObservationIngestionService({
      dbPool: this.dbPool,
      consentManager: this.authService.consentManager,
    });

    this.observationRepo = new ObservationRepository(this.dbPool);
    this.sessionRepo = new SessionRepository(this.dbPool);
    this.evidenceRepo = new EvidenceRepository(this.dbPool);
    this.retentionRepo = new RetentionRepository(this.dbPool);
    this.observationConsumer = new StoreObservationBatchConsumer(this.dbPool, {
      obsRepo: this.observationRepo,
      sessionRepo: this.sessionRepo,
    });
    this.retentionService = new RetentionService(this.dbPool, {
      retentionRepo: this.retentionRepo,
    });
    this.exportService = new ExportService(this.dbPool, this.objectStore, {
      obsRepo: this.observationRepo,
      sessionRepo: this.sessionRepo,
      evidenceRepo: this.evidenceRepo,
      retentionRepo: this.retentionRepo,
    });

    this.worker.registerHandler("store-observation-batch", async (job) => {
      const typedJob = job as unknown as JobEnvelope<StoreObservationBatchPayload>;
      await this.observationConsumer.processJob(typedJob);
    });

    this.server = createCloudServer({
      config: this.config,
      dbPool: this.dbPool,
      authService: this.authService,
      ingestionService: this.ingestionService,
      objectStore: this.objectStore,
      queue: this.queue,
      outboxPublisher: this.outboxPublisher,
    });
  }

  /**
   * Initialize cloud service, run database migrations, and start background workers.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Run database migrations
    await runMigrations(this.dbPool);

    // Start workers and publishers
    this.outboxPublisher.start(100);
    this.worker.start();
    this.scheduler.start();

    this.isInitialized = true;
  }

  /**
   * Start HTTP API server and underlying worker processes.
   */
  async start(port?: number): Promise<number> {
    await this.initialize();
    return this.server.start(port);
  }

  /**
   * Graceful teardown of server, worker runtime, and persistence pools.
   */
  async stop(): Promise<void> {
    await this.server.stop();
    this.outboxPublisher.stop();
    await this.worker.stop();
    await this.scheduler.stop();
    await this.dbPool.end();
    this.isInitialized = false;
  }

  /**
   * Alias for stop().
   */
  async close(): Promise<void> {
    await this.stop();
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
