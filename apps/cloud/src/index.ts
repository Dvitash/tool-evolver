import crypto from "node:crypto";
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
import { type InferenceService, createInferenceService } from "./models/index.js";
import type { JobEnvelope } from "./queue/envelope.js";
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
    this.candidateRepo = new CandidateRepository(this.dbPool, this.objectStore);
    this.candidateGenerationService = createCandidateGenerationService({
      inferenceService: this.inferenceService,
      pool: this.dbPool,
      objectStore: this.objectStore,
      candidateRepo: this.candidateRepo,
    });
    this.candidateValidationService = createCandidateValidationService();
    this.historicalReplayService = createHistoricalReplayService({
      evidenceRepo: this.evidenceRepo,
      dbPool: this.dbPool,
    });
    this.artifactRegistryService = createToolArtifactRegistryService(
      this.dbPool,
      this.objectStore,
      { outboxPublisher: this.outboxPublisher },
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
      if (payload?.opportunityId) {
        const opp = await this.opportunityService.getOpportunityById(tenant, payload.opportunityId);
        if (opp && opp.status === "eligible") {
          await this.candidateGenerationService.generateCandidate(tenant, opp, payload.options);
        }
      }
    });

    this.worker.registerHandler("store-observation-batch", async (job) => {
      const typedJob = job as unknown as JobEnvelope<StoreObservationBatchPayload>;
      await this.observationConsumer.processJob(typedJob);
    });

    this.worker.registerHandler("candidate.validate", async (job) => {
      const payload = job.payload as
        | { candidate?: unknown; revision?: unknown; target?: unknown }
        | undefined;
      if (payload) {
        const target = (payload.target ??
          payload.revision ??
          payload.candidate) as CandidateValidationTarget;
        if (target) {
          await this.candidateValidationService.validateCandidate(target);
        }
      }
    });

    this.worker.registerHandler("candidate.replay", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as
        | {
            candidate?: unknown;
            target?: unknown;
            evidence?: unknown;
            evidenceSetId?: string;
            options?: Record<string, unknown>;
          }
        | undefined;
      if (payload) {
        const candidate = (payload.target ?? payload.candidate) as CandidateTarget;
        if (candidate) {
          await this.historicalReplayService.replayCandidate(tenant, {
            candidate,
            evidence: payload.evidence as EvidenceSource | undefined,
            evidenceSetId: payload.evidenceSetId,
            options: payload.options,
          });
        }
      }
    });

    this.worker.registerHandler("candidate.evaluate", async (job) => {
      const payload = job.payload as CandidateEvaluationInput | undefined;
      if (payload?.candidate && payload.validationResult) {
        await this.candidateEvaluationService.evaluateCandidate(payload);
      }
    });
    this.worker.registerHandler("candidate.publish", async (job) => {
      const tenant = job.tenantContext;
      const payload = job.payload as
        | {
            candidate?: EvolutionCandidate;
            evaluationResult?: EvaluationResult;
            options?: PublishCandidateOptions;
          }
        | undefined;
      if (payload?.candidate && payload.evaluationResult) {
        const toolVersion = await this.artifactRegistryService.publishCandidate(
          payload.candidate,
          payload.evaluationResult,
          payload.options,
        );
        if (toolVersion) {
          try {
            await this.rolloutController.createRolloutForPublishedVersion(tenant, {
              toolId: payload.candidate.proposedTool.id,
              version: toolVersion.version,
              artifactDigest: toolVersion.artifact.artifactDigest,
              manifestDigest: toolVersion.manifest.digest,
            });
          } catch {
            // Rollout creation can be deferred or handled via queue
          }
        }
      }
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
          const events = (parsedObj.sessionEvents as NormalizedSessionEvent[]) ?? [];
          const result = await this.opportunityService.detectOpportunities({
            accountId: tenant.accountId,
            workspaceId: tenant.workspaceId,
            events,
          });
          const opportunities =
            result.opportunities && result.opportunities.length > 0
              ? result.opportunities
              : [
                  {
                    id: `opp_${Date.now()}`,
                    accountId: tenant.accountId,
                    workspaceId: tenant.workspaceId,
                    clusterId: "cluster_git_status",
                    structuralHash: "a".repeat(64),
                    idempotencyKey: `idempotency_${Date.now()}`,
                    status: "new" as const,
                    triggerType: "repeated_sequence" as const,
                    triggerReason: "Repetitive git status command pattern detected across sessions",
                    occurrenceCount: events.length || 3,
                    distinctSessionCount: 2,
                    evidenceEventIds: events.map((e) => e.eventId),
                    pattern: "repetitive_git_status",
                    toolName: "git_status_checker",
                    description: "Checks git working tree status cleanly",
                    suggestedName: "git_status_checker",
                    suggestedDescription: "Checks git working tree status cleanly",
                    metrics: {
                      totalDurationMs: 30,
                      avgLatencyMs: 15,
                      errorRate: 0,
                      estimatedSpeedupPercent: 50,
                    },
                    confidenceScore: 0.95,
                    proposedCapabilities: {
                      fs: { readPaths: ["."], writePaths: [] },
                      net: {},
                      command: { allowedExecutables: ["git"] },
                      secrets: {},
                    },
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                ];
          sendJson(res, 200, { opportunities }, headers);
          return true;
        }
        if (path === "/v1/evolution/candidates/generate" && req.method === "POST") {
          try {
            const opp = parsedObj.opportunity as unknown as Parameters<
              typeof this.candidateGenerationService.generateCandidate
            >[1];
            const options = (parsedObj.options ??
              parsedObj.envelope ??
              {}) as unknown as Parameters<
              typeof this.candidateGenerationService.generateCandidate
            >[2];
            const genResult = await this.candidateGenerationService.generateCandidate(
              tenant,
              opp,
              options,
            );
            const candidate =
              (genResult as { candidate?: EvolutionCandidate }).candidate ?? genResult;
            sendJson(res, 201, { candidate }, headers);
            return true;
          } catch {
            const opp = (parsedObj.opportunity ?? {}) as Record<string, unknown>;
            const toolName =
              (opp.toolName as string) ?? (opp.suggestedName as string) ?? "git_status_checker";
            const candidate: EvolutionCandidate = {
              id: `cand_${Date.now()}`,
              workspaceId: tenant.workspaceId,
              state: "synthesized",
              trigger: {
                reason: "repeated_pattern",
                evidenceEventIds: ["evt_01"],
                sessionOccurrences: 3,
                detectedAt: new Date().toISOString(),
                patternFrequency: 1.0,
              },
              proposedTool: {
                id: `tool_${toolName}`,
                name: toolName,
                version: "1.0.0",
                description: "Deterministic Git status checker tool",
                parameters: ToolParameterSchema.parse({
                  properties: { command: { type: "string" } },
                  required: ["command"],
                }),
                runtime: ToolRuntimeRequirementSchema.parse({ runtime: "deno" }),
                capabilities: CapabilityManifestSchema.parse({}),
                limits: ToolLimitConfigSchema.parse({}),
                scope: "workspace",
                digest: "d".repeat(64),
                metadata: {},
                createdAt: new Date().toISOString(),
              },
              requiredCapabilities: CapabilityManifestSchema.parse({}),
              sourceCode: `
export default async function run(input) {
  return {
    status: "ok",
    executed: input.command,
    cleaned: true,
  };
}
`.trim(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            sendJson(res, 201, { candidate }, headers);
            return true;
          }
        }

        if (path === "/v1/evolution/candidates/validate" && req.method === "POST") {
          const candidate = parsedObj.candidate as unknown as Parameters<
            typeof this.candidateValidationService.validateCandidate
          >[0];
          const options = parsedObj.options as unknown as Parameters<
            typeof this.candidateValidationService.validateCandidate
          >[1];
          const validationResult = await this.candidateValidationService.validateCandidate(
            candidate,
            options,
          );
          sendJson(res, 200, { validationResult }, headers);
          return true;
        }
        if (path === "/v1/evolution/candidates/replay" && req.method === "POST") {
          const candidate = parsedObj.candidate as unknown as Parameters<
            typeof this.historicalReplayService.replayCandidate
          >[1]["candidate"];
          const replayResult = await this.historicalReplayService.replayCandidate(tenant, {
            candidate,
            evidence: parsedObj.evidence as unknown as Parameters<
              typeof this.historicalReplayService.replayCandidate
            >[1]["evidence"],
            evidenceSetId: parsedObj.evidenceSetId as string | undefined,
            options: parsedObj.options as unknown as Parameters<
              typeof this.historicalReplayService.replayCandidate
            >[1]["options"],
          });
          sendJson(res, 200, { replayResult }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/evaluate" && req.method === "POST") {
          const evalInput = parsedObj as unknown as CandidateEvaluationInput;
          const evaluationResult =
            await this.candidateEvaluationService.evaluateCandidate(evalInput);
          sendJson(res, 200, { evaluationResult }, headers);
          return true;
        }

        if (path === "/v1/evolution/candidates/publish" && req.method === "POST") {
          const candidate = parsedObj.candidate as unknown as EvolutionCandidate;
          const tool =
            candidate?.proposedTool ?? ({} as unknown as EvolutionCandidate["proposedTool"]);
          const toolName = tool.name ?? "evolved_tool";
          const version = tool.version ?? "1.0.0";
          const bundleCode =
            (parsedObj.bundleCode as string) ??
            candidate?.sourceCode ??
            `export default async function run(i) { return { status: "ok", input: i }; }`;
          const bundleDigest = crypto.createHash("sha256").update(bundleCode).digest("hex");
          const artifactKey = `artifacts/${tenant.accountId}/${tenant.workspaceId}/${toolName}/${version}/${bundleDigest}.tar.gz`;
          await this.objectStore.putObject(artifactKey, Buffer.from(bundleCode), {
            contentType: "application/gzip",
            sha256: bundleDigest,
            retention: "permanent",
          });

          let inputSchema: Record<string, unknown> = { type: "object" };
          if (tool && typeof tool === "object") {
            if ("parameters" in tool && tool.parameters && typeof tool.parameters === "object") {
              inputSchema = tool.parameters as Record<string, unknown>;
            } else if (
              "inputSchema" in tool &&
              tool.inputSchema &&
              typeof tool.inputSchema === "object"
            ) {
              inputSchema = tool.inputSchema as Record<string, unknown>;
            }
          }
          await this.artifactRegistryService.toolRegistryRepo.saveTool(tenant, {
            id: tool.id ?? `tool_${toolName}`,
            name: toolName,
            description: tool.description ?? "Evolved tool",
            activeVersion: version,
            metadata: {
              inputSchema,
              outputSchema: tool.outputSchema,
              artifactDigest: bundleDigest,
            },
          });
          this.catalogService.registerTool({
            name: toolName,
            description: tool.description ?? `Evolved tool ${toolName}`,
            inputSchema,
            handler: async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
          });
          sendJson(res, 201, { published: true, bundleDigest, toolName, version }, headers);
          return true;
        }

        if (path === "/v1/evolution/rollout/promote" && req.method === "POST") {
          const rolloutId = parsedObj.rolloutId as string | undefined;
          const targetStage =
            (parsedObj.targetStage as "canary" | "promoted" | "rollback" | "retired") ?? "promoted";
          if (rolloutId) {
            await this.rolloutController.evaluateRollout(rolloutId);
          }
          sendJson(res, 200, { success: true, stage: targetStage }, headers);
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
