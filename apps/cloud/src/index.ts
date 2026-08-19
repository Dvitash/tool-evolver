/**
 * @tool-evolver/cloud
 *
 * Cloud service platform, persistence, queue, storage, and worker runtime.
 */

import {
  CapabilityManifestSchema,
  type EvaluationResult,
  type EvolutionCandidate,
  type NormalizedSessionEvent,
  ToolLimitConfigSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@tool-evolver/contracts";
import {
  type AnalyticsService,
  type CalculateEfficiencyParams,
  type CalibrateEvaluationParams,
  type MaterializeRolloutWindowParams,
  type MetricsRepository,
  createAnalyticsService,
  createMetricsRepository,
} from "./analytics/index.js";
import { type AuthService, createAuthService } from "./auth/index.js";
import { type CloudConfig, type RawCloudConfig, loadConfig } from "./config.js";
import { type DatabasePool, createDatabasePool } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import { OutboxPublisher } from "./db/outbox.js";
import {
  type PublishCandidateOptions,
  type ToolArtifactRegistryService,
  createToolArtifactRegistryService,
} from "./evolution/artifacts/index.js";
import {
  type CandidateEvaluationInput,
  type CandidateEvaluationService,
  createCandidateEvaluationService,
} from "./evolution/evaluation/index.js";
import {
  type CandidateGenerationService,
  CandidateRepository,
  createCandidateGenerationService,
} from "./evolution/generator/index.js";
import { CandidateLifecycleOrchestrator } from "./evolution/lifecycle/index.js";
import {
  type OpportunityDetectionService,
  createOpportunityDetectionService,
} from "./evolution/opportunity/index.js";
import {
  type CandidateTarget,
  type EvidenceSource,
  type HistoricalReplayService,
  createHistoricalReplayService,
} from "./evolution/replay/index.js";
import {
  type CreateRolloutParams,
  RolloutAssignmentRouter,
  RolloutController,
  RolloutEvaluator,
  type RolloutOverrideRecord,
  RolloutPolicyRegistry,
  RolloutRepository,
  type RolloutTelemetryEvent,
} from "./evolution/rollout/index.js";
import {
  type CandidateValidationService,
  type CandidateValidationTarget,
  createCandidateValidationService,
} from "./evolution/testing/index.js";
import {
  type ObservationIngestionService,
  createObservationIngestionService,
} from "./ingestion/index.js";
import {
  type CloudCatalogService,
  type CloudMcpServer,
  createCloudCatalogService,
  createCloudMcpServer,
} from "./mcp/index.js";
import {
  type InferenceService,
  OpenAiCompatibleProvider,
  createInferenceService,
} from "./models/index.js";
import { type JobEnvelope, createJobEnvelope } from "./queue/envelope.js";
import { type DurableQueue, createDurableQueue } from "./queue/queue.js";
import { JobScheduler } from "./queue/scheduler.js";
import { WorkerRuntime } from "./queue/worker.js";
import { CloudServer, createCloudServer } from "./server/api.js";
import {
  EvidenceRepository,
  ExportService,
  ObservationRepository,
  RetentionRepository,
  RetentionService,
  SessionRepository,
  StoreObservationBatchConsumer,
} from "./storage/index.js";
import type { StoreObservationBatchPayload } from "./storage/index.js";
import { type ObjectStore, createObjectStore } from "./storage/object-store.js";

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

// Evolution Opportunity Detection Engine
// Evolution Artifact Registry & Immutable Version Catalog
export * from "./evolution/artifacts/index.js";

export * from "./evolution/opportunity/index.js";

// Evolution Candidate Planning, Code Generation & Repair Engine
export * from "./evolution/generator/index.js";

// Evolution Candidate Test Synthesis & Static Validation
export * from "./evolution/testing/index.js";

// Evolution Historical Session Replay Engine
export * from "./evolution/replay/index.js";

// Evolution Candidate Scoring, Evaluation & Eligibility Decisions

// Cloud MCP Subsystem & Catalog
export * from "./mcp/index.js";
export * from "./evolution/evaluation/index.js";
export * from "./evolution/artifacts/index.js";
export * from "./evolution/rollout/index.js";
export * from "./evolution/lifecycle/index.js";
export * from "./analytics/index.js";
export * from "./models/index.js";

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
  readonly opportunityService: OpportunityDetectionService;
  readonly candidateRepo: CandidateRepository;
  readonly inferenceService: InferenceService;
  readonly candidateGenerationService: CandidateGenerationService;
  readonly candidateValidationService: CandidateValidationService;
  readonly candidateLifecycleOrchestrator: CandidateLifecycleOrchestrator;

  readonly historicalReplayService: HistoricalReplayService;
  readonly candidateEvaluationService: CandidateEvaluationService;
  readonly artifactRegistryService: ToolArtifactRegistryService;
  readonly catalogService: CloudCatalogService;
  readonly mcpServer: CloudMcpServer;
  readonly rolloutRepo: RolloutRepository;
  readonly rolloutPolicyRegistry: RolloutPolicyRegistry;
  readonly rolloutAssignmentRouter: RolloutAssignmentRouter;
  readonly rolloutEvaluator: RolloutEvaluator;
  readonly rolloutController: RolloutController;
  readonly metricsRepo: MetricsRepository;
  readonly analyticsService: AnalyticsService;
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
    this.opportunityService = createOpportunityDetectionService({ pool: this.dbPool });
    this.inferenceService = createInferenceService();
    if (this.config.models.provider === "openai-compatible") {
      if (!this.config.models.baseUrl) {
        throw new Error("MODEL_BASE_URL is required for the openai-compatible provider");
      }
      this.inferenceService.router.registerProvider(
        new OpenAiCompatibleProvider({
          id: this.config.models.providerId,
          name: `OpenAI-compatible (${this.config.models.providerId})`,
          baseUrl: this.config.models.baseUrl,
          apiKey: this.config.models.apiKey,
          organizationId: this.config.models.organizationId,
          defaultModel: this.config.models.model,
          timeoutMs: this.config.models.timeoutMs,
        }),
      );
    }
    this.candidateRepo = new CandidateRepository(this.dbPool, this.objectStore);
    this.candidateGenerationService = createCandidateGenerationService({
      inferenceService: this.inferenceService,
      pool: this.dbPool,
      objectStore: this.objectStore,
      candidateRepo: this.candidateRepo,
      allowDeterministicFallback: this.config.models.allowDeterministicFallback,
    });
    this.candidateValidationService = createCandidateValidationService();
    this.historicalReplayService = createHistoricalReplayService({
      evidenceRepo: this.evidenceRepo,
      dbPool: this.dbPool,
    });
    this.artifactRegistryService = createToolArtifactRegistryService(
      this.dbPool,
      this.objectStore,
      {
        outboxPublisher: this.outboxPublisher,
        allowEphemeralSigningKey:
          this.config.environment === "development" || this.config.environment === "test",
      },
    );
    this.metricsRepo = createMetricsRepository(this.dbPool);
    this.analyticsService = createAnalyticsService(this.dbPool, {
      repository: this.metricsRepo,
    });
    this.catalogService = createCloudCatalogService({
      dbPool: this.dbPool,
      toolRegistryRepo: this.artifactRegistryService.toolRegistryRepo,
    });
    this.mcpServer = createCloudMcpServer({
      catalogService: this.catalogService,
    });
    this.rolloutRepo = new RolloutRepository(this.dbPool);
    this.rolloutPolicyRegistry = new RolloutPolicyRegistry();
    this.rolloutEvaluator = new RolloutEvaluator();
    this.rolloutAssignmentRouter = new RolloutAssignmentRouter(this.rolloutRepo);
    this.rolloutController = new RolloutController(this.dbPool, {
      rolloutRepo: this.rolloutRepo,
      policyRegistry: this.rolloutPolicyRegistry,
      evaluator: this.rolloutEvaluator,
      assignmentRouter: this.rolloutAssignmentRouter,
      toolRegistryRepo: this.artifactRegistryService.toolRegistryRepo,
      outboxPublisher: this.outboxPublisher,
      catalogService: this.catalogService,
    });
    this.candidateEvaluationService = createCandidateEvaluationService();
    this.candidateLifecycleOrchestrator = new CandidateLifecycleOrchestrator(this.dbPool, {
      validationService: this.candidateValidationService,
      replayService: this.historicalReplayService,
      evaluationService: this.candidateEvaluationService,
      artifactService: this.artifactRegistryService,
      catalogService: this.catalogService,
      candidateRepo: this.candidateRepo,
      outboxPublisher: this.outboxPublisher,
      queue: this.queue,
      objectStore: this.objectStore,
      observationRepo: this.observationRepo,
      requirePersistedReplayEvidence: true,
      replayEvidenceWaitMs: 5_000,
      replayEvidencePollMs: 25,
    });
    this.worker.registerHandler("opportunity.detect", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as { sessionIds?: string[] } | undefined;
      if (payload?.sessionIds && payload.sessionIds.length > 0) {
        for (const sessId of payload.sessionIds) {
          const queryResult = await this.observationRepo.queryEvents({
            accountId: tenant.accountId,
            workspaceId: tenant.workspaceId,
            sessionId: sessId,
            limit: 500,
          });
          if (queryResult.events.length > 0) {
            const sessionEvents: NormalizedSessionEvent[] = queryResult.events.map(
              (entity) =>
                ({
                  eventId: entity.id,
                  sessionId: entity.sessionId,
                  timestamp: entity.timestamp,
                  type: entity.eventType as NormalizedSessionEvent["type"],
                  schemaVersion: entity.schemaVersion,
                  causalRef: {
                    causalSequence: entity.causalSequence,
                    parentId: entity.parentId ?? undefined,
                    rootId: entity.rootId ?? undefined,
                    turnIndex: entity.turnIndex ?? undefined,
                    stepIndex: entity.stepIndex ?? undefined,
                  },
                  redaction: entity.redaction ?? { isRedacted: false, rulesApplied: [] },
                  ...entity.payload,
                }) as unknown as NormalizedSessionEvent,
            );
            await this.opportunityService.processSessionEvents(tenant, sessionEvents);
          }
        }
      }
    });

    this.worker.registerHandler("candidate.generate", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as
        | { opportunityId?: string; options?: Record<string, unknown> }
        | undefined;
      if (!payload?.opportunityId) {
        throw new Error("candidate.generate requires opportunityId");
      }
      const opportunity = await this.opportunityService.getOpportunityById(
        tenant,
        payload.opportunityId,
      );
      if (!opportunity || opportunity.status !== "eligible") {
        throw new Error(`Eligible opportunity '${payload.opportunityId}' was not found`);
      }
      const generated = await this.candidateGenerationService.generateCandidate(
        tenant,
        opportunity,
        payload.options,
      );
      await this.candidateLifecycleOrchestrator.startLifecycle(
        tenant,
        generated.candidate,
        generated.activeRevision,
      );
    });

    this.worker.registerHandler("store-observation-batch", async (job) => {
      const typedJob = job as unknown as JobEnvelope<StoreObservationBatchPayload>;
      await this.observationConsumer.processJob(typedJob);
    });

    // Transactional outbox records are durable intent, not completed work. Bridge every
    // record into the durable queue before the publisher marks it published. The outbox
    // record ID is the queue idempotency key, so retries cannot fork downstream work.
    this.outboxPublisher.subscribe("*", async (record) => {
      await this.queue.enqueue(
        createJobEnvelope({
          jobType: record.eventType,
          version: "1.0.0",
          tenantContext: {
            accountId: record.accountId,
            workspaceId: record.workspaceId,
            traceId: record.headers.traceId,
            correlationId: record.headers.correlationId,
            roles: ["system"],
            metadata: { source: "transactional-outbox" },
          },
          causationId: record.aggregateId,
          correlationId: record.headers.correlationId,
          idempotencyKey: `outbox:${record.id}`,
          payload: record.payload,
          traceContext: record.headers,
        }),
      );
    });

    this.worker.registerHandler("candidate.validate", async (job) => {
      const payload = job.payload as { candidateId?: string } | undefined;
      if (!payload?.candidateId) throw new Error("candidate.validate requires candidateId");
      await this.candidateLifecycleOrchestrator.stepValidate(
        job.tenantContext,
        payload.candidateId,
      );
    });

    this.worker.registerHandler("candidate.replay", async (job) => {
      const payload = job.payload as { candidateId?: string } | undefined;
      if (!payload?.candidateId) throw new Error("candidate.replay requires candidateId");
      await this.candidateLifecycleOrchestrator.stepReplay(job.tenantContext, payload.candidateId);
    });

    this.worker.registerHandler("candidate.evaluate", async (job) => {
      const payload = job.payload as { candidateId?: string } | undefined;
      if (!payload?.candidateId) throw new Error("candidate.evaluate requires candidateId");
      await this.candidateLifecycleOrchestrator.stepEvaluate(
        job.tenantContext,
        payload.candidateId,
      );
    });

    this.worker.registerHandler("candidate.publish", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as { candidateId?: string } | undefined;
      if (!payload?.candidateId) throw new Error("candidate.publish requires candidateId");
      const { toolVersion } = await this.candidateLifecycleOrchestrator.stepPublish(
        tenant,
        payload.candidateId,
      );
      await this.rolloutController.createRolloutForPublishedVersion(tenant, {
        toolId: toolVersion.toolId,
        version: toolVersion.version,
        artifactDigest: toolVersion.artifactDigest,
        manifestDigest: toolVersion.manifestDigest,
      });
    });

    this.worker.registerHandler("rollout.create", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as CreateRolloutParams | undefined;
      if (payload) {
        await this.rolloutController.createRolloutForPublishedVersion(tenant, payload);
      }
    });

    this.worker.registerHandler("rollout.evaluate", async (job) => {
      const payload = job.payload as { rolloutId?: string } | undefined;
      if (payload?.rolloutId) {
        await this.rolloutController.evaluateRollout(payload.rolloutId);
      }
    });

    this.worker.registerHandler("rollout.telemetry", async (job) => {
      const payload = job.payload as { event?: RolloutTelemetryEvent } | undefined;
      if (payload?.event) {
        await this.rolloutController.recordTelemetry(payload.event);
      }
    });

    this.worker.registerHandler("analytics.materialize", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as MaterializeRolloutWindowParams | undefined;
      if (payload) {
        await this.analyticsService.materializeRolloutWindow(tenant, payload);
      }
    });

    this.worker.registerHandler("analytics.efficiency", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as CalculateEfficiencyParams | undefined;
      if (payload) {
        await this.analyticsService.calculateEfficiency(tenant, payload);
      }
    });

    this.worker.registerHandler("analytics.calibrate", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as CalibrateEvaluationParams | undefined;
      if (payload) {
        await this.analyticsService.calibrateEvaluation(tenant, payload);
      }
    });

    this.worker.registerHandler("rollout.rollback", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as { rolloutId?: string; reason?: string } | undefined;
      if (payload?.rolloutId) {
        await this.rolloutController.executeManualRollback(
          tenant,
          payload.rolloutId,
          payload.reason ?? "Worker triggered rollback",
        );
      }
    });
    this.server = new CloudServer({
      config: this.config,
      dbPool: this.dbPool,
      authService: this.authService,
      ingestionService: this.ingestionService,
      objectStore: this.objectStore,
      outboxPublisher: this.outboxPublisher,
      catalogService: this.catalogService,
      mcpServer: this.mcpServer,
      analyticsService: this.analyticsService,
      customRouteHandler: async (req, res, path, tenant, body, sendJson, headers) => {
        const parsedObj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

        if (path === "/v1/evolution/opportunity/detect" && req.method === "POST") {
          const events = (parsedObj.events as NormalizedSessionEvent[] | undefined) ?? [];
          const opportunities = await this.opportunityService.processSessionEvents(tenant, events);
          sendJson(res, 200, { opportunities }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/generate" && req.method === "POST") {
          const submittedOpportunity = parsedObj.opportunity as { id?: string } | undefined;
          const opportunityId =
            (parsedObj.opportunityId as string | undefined) ?? submittedOpportunity?.id;
          if (!opportunityId) {
            sendJson(res, 400, { error: "opportunityId is required" }, headers);
            return true;
          }
          const opportunity = await this.opportunityService.getOpportunityById(
            tenant,
            opportunityId,
          );
          if (!opportunity) {
            sendJson(res, 404, { error: "Opportunity not found" }, headers);
            return true;
          }
          if (opportunity.status !== "eligible") {
            sendJson(res, 409, { error: `Opportunity is ${opportunity.status}` }, headers);
            return true;
          }
          const generated = await this.candidateGenerationService.generateCandidate(
            tenant,
            opportunity,
            parsedObj.options as Record<string, unknown> | undefined,
          );
          const lifecycle = await this.candidateLifecycleOrchestrator.startLifecycle(
            tenant,
            generated.candidate,
            generated.activeRevision,
          );
          sendJson(
            res,
            202,
            { candidate: generated.candidate, candidateId: generated.candidate.id, lifecycle },
            headers,
          );
          return true;
        }

        if (path === "/v1/evolution/candidates/validate" && req.method === "POST") {
          const candidateId =
            (parsedObj.candidateId as string | undefined) ??
            (parsedObj.candidate as { id?: string } | undefined)?.id;
          if (!candidateId) {
            sendJson(res, 400, { error: "candidateId is required" }, headers);
            return true;
          }
          const lifecycle = await this.candidateLifecycleOrchestrator.stepValidate(
            tenant,
            candidateId,
          );
          sendJson(res, 200, { lifecycle }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/replay" && req.method === "POST") {
          const candidateId =
            (parsedObj.candidateId as string | undefined) ??
            (parsedObj.candidate as { id?: string } | undefined)?.id;
          if (!candidateId) {
            sendJson(res, 400, { error: "candidateId is required" }, headers);
            return true;
          }
          const lifecycle = await this.candidateLifecycleOrchestrator.stepReplay(
            tenant,
            candidateId,
          );
          sendJson(res, 200, { lifecycle }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/evaluate" && req.method === "POST") {
          const candidateId =
            (parsedObj.candidateId as string | undefined) ??
            (parsedObj.candidate as { id?: string } | undefined)?.id;
          if (!candidateId) {
            sendJson(res, 400, { error: "candidateId is required" }, headers);
            return true;
          }
          const lifecycle = await this.candidateLifecycleOrchestrator.stepEvaluate(
            tenant,
            candidateId,
          );
          sendJson(res, 200, { lifecycle }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/publish" && req.method === "POST") {
          const candidateId =
            (parsedObj.candidateId as string | undefined) ??
            (parsedObj.candidate as { id?: string } | undefined)?.id;
          if (!candidateId) {
            sendJson(res, 400, { error: "candidateId is required" }, headers);
            return true;
          }
          const candidate = await this.candidateRepo.getCandidateById(tenant, candidateId);
          if (!candidate) {
            sendJson(res, 404, { error: "Candidate not found" }, headers);
            return true;
          }
          const revision = await this.candidateRepo.getActiveRevision(tenant, candidateId);
          const { record, toolVersion } =
            await this.candidateLifecycleOrchestrator.driveToCompletion(
              tenant,
              candidate,
              revision,
            );
          const rollout = await this.rolloutController.createRolloutForPublishedVersion(tenant, {
            toolId: toolVersion.toolId,
            version: toolVersion.version,
            artifactDigest: toolVersion.artifactDigest,
            manifestDigest: toolVersion.manifestDigest,
          });
          sendJson(
            res,
            202,
            {
              published: true,
              candidateId,
              bundleDigest: toolVersion.artifactDigest,
              toolName: toolVersion.manifest.name,
              version: toolVersion.version,
              lifecycle: record,
              rolloutId: rollout.id,
              state: rollout.state,
            },
            headers,
          );
          return true;
        }

        if (path === "/v1/evolution/rollout/promote" && req.method === "POST") {
          const rolloutId = parsedObj.rolloutId as string | undefined;
          if (!rolloutId) {
            sendJson(res, 400, { error: "rolloutId is required" }, headers);
            return true;
          }
          const result = await this.rolloutController.executeManualPromotion(
            tenant,
            rolloutId,
            (parsedObj.reason as string | undefined) ?? "Manual promotion",
          );
          sendJson(res, 200, { result }, headers);
          return true;
        }

        if (path === "/v1/evolution/rollout/rollback" && req.method === "POST") {
          const rolloutId = parsedObj.rolloutId as string;
          const reason = (parsedObj.reason as string) ?? "Manual rollback";
          const result = await this.rolloutController.executeManualRollback(
            tenant,
            rolloutId,
            reason,
          );
          sendJson(res, 200, { result, rolledBack: true }, headers);
          return true;
        }
        if (path === "/v1/evolution/catalog" && req.method === "GET") {
          const catalog = this.catalogService.getSnapshot(tenant.workspaceId);
          sendJson(res, 200, { catalog }, headers);
          return true;
        }
        return false;
      },
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
export function createCloudService(
  options: { config?: Partial<RawCloudConfig> } = {},
): CloudService {
  return new CloudService(options);
}

export * from "./staging/index.js";
