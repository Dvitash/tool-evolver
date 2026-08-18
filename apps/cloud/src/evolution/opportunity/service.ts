import {
  type CapabilityEnvelope,
  type NormalizedSessionEvent,
  type ToolManifest,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import { type DatabasePool, MemoryDatabasePool, type Queryable } from "../../db/client.js";
import { runMigrations } from "../../db/migrations.js";
import type { InferenceService } from "../../models/service.js";
import { type TenantContext, TenantGuard } from "../../tenant.js";
import { OpportunityClassifier } from "./classifier.js";
import { StructuralClusterer } from "./clustering.js";
import { CoverageEngine } from "./coverage.js";
import { EpisodeSegmenter } from "./episode.js";
import { OpportunityRepository } from "./repositories/opportunity-repository.js";
import { SuppressionEngine } from "./suppression.js";
import { TriggerEvaluator } from "./triggers.js";
import type {
  ClustererOptions,
  DetectOpportunitiesParams,
  OpportunityDetection,
  OpportunityDetectionResult,
  OpportunityDetectionStatus,
  OpportunityFilter,
  SegmenterOptions,
  SuppressionOptions,
  TriggerOptions,
} from "./types.js";

/**
 * Configuration options for OpportunityDetectionService.
 */
export interface OpportunityDetectionServiceOptions {
  pool?: DatabasePool;
  repository?: OpportunityRepository;
  segmenter?: SegmenterOptions;
  clusterer?: ClustererOptions;
  triggers?: TriggerOptions;
  suppression?: SuppressionOptions;
  inferenceService?: InferenceService;
}

/**
 * Orchestrates opportunity detection from normalized session history with PostgreSQL persistence,
 * deterministic idempotency, and transactional outbox job publishing.
 */
export class OpportunityDetectionService {
  private readonly repository: OpportunityRepository;
  private readonly pool: DatabasePool;
  private readonly segmenter: EpisodeSegmenter;
  private readonly clusterer: StructuralClusterer;
  private readonly triggerEvaluator: TriggerEvaluator;
  private readonly coverageEngine: CoverageEngine;
  private readonly suppressionEngine: SuppressionEngine;
  private readonly classifier: OpportunityClassifier;
  private initialized = false;

  constructor(options: OpportunityDetectionServiceOptions = {}) {
    this.pool = options.pool ?? new MemoryDatabasePool();
    this.repository = options.repository ?? new OpportunityRepository(this.pool);
    this.segmenter = new EpisodeSegmenter(options.segmenter);
    this.clusterer = new StructuralClusterer(options.clusterer);
    this.triggerEvaluator = new TriggerEvaluator(options.triggers);
    this.coverageEngine = new CoverageEngine();
    this.suppressionEngine = new SuppressionEngine(options.suppression);
    this.classifier = new OpportunityClassifier(options.inferenceService);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.pool instanceof MemoryDatabasePool) {
      await runMigrations(this.pool);
    }
    this.initialized = true;
  }

  /**
   * Returns the underlying repository instance.
   */
  getRepository(): OpportunityRepository {
    return this.repository;
  }

  /**
   * Runs the complete opportunity detection pipeline over a stream of normalized session events.
   * Persists all detected opportunities transactionally with outbox job publication for eligible candidates.
   */
  async detectOpportunities(
    params: DetectOpportunitiesParams,
  ): Promise<OpportunityDetectionResult> {
    await this.ensureInitialized();

    const { accountId, workspaceId, events, existingTools = [], envelope } = params;
    const tenant: TenantContext = { accountId, workspaceId };
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );

    const now = params.now ?? Date.now();
    const timestamp = new Date(now).toISOString();

    // 1. Episode Segmentation
    const episodes = this.segmenter.segmentEvents(events);

    // 2. Structural Clustering
    const clusters = this.clusterer.clusterEpisodes(episodes);

    // 3. Query PostgreSQL for recent opportunity hashes within cooldown window
    const cooldownMs = this.suppressionEngine.getCooldownMs();
    const since = new Date(now - cooldownMs).toISOString();
    const recentOpportunityHashes =
      params.recentOpportunityHashes ??
      (await this.repository.getRecentOpportunityHashes(tenant, since, params.db));

    // 4. Process Each Cluster
    const opportunities: OpportunityDetection[] = [];
    let eligibleCount = 0;
    let suppressedCount = 0;
    let coveredCount = 0;
    let duplicateCount = 0;

    for (const cluster of clusters) {
      // 5. Trigger Rule Evaluation
      const triggerResult = this.triggerEvaluator.evaluateCluster(cluster);
      if (!triggerResult.triggered || triggerResult.triggerType === "none") {
        continue;
      }

      // 6. Tool Coverage Check
      const coverageResult = this.coverageEngine.evaluateCoverage(cluster, existingTools);

      // 7. Suppression Evaluation (cooldown, destructiveness, out-of-envelope, unobservable)
      const suppressionResult = this.suppressionEngine.evaluateSuppression(cluster, {
        envelope,
        recentOpportunityHashes,
        now,
      });

      // 8. Determine Status
      let status: OpportunityDetectionStatus;
      if (coverageResult.status === "duplicate") {
        status = "duplicate";
      } else if (coverageResult.status === "covered") {
        status = "covered";
      } else if (suppressionResult.suppressed) {
        status = "suppressed";
      } else {
        status = "eligible";
      }

      // 9. Derive deterministic idempotency key and opportunityId
      const idempotencyKey = `opp_ik_${hashCanonicalContent(
        {
          workspaceId,
          structuralHash: cluster.structuralHash,
          triggerType: triggerResult.triggerType,
          triggerReason: triggerResult.reason,
          evidenceEventIds: [...cluster.evidenceEventIds].sort(),
        },
        { prefix: false },
      )}`;

      const opportunityId = `opp_${hashCanonicalContent(
        {
          workspaceId,
          structuralHash: cluster.structuralHash,
          triggerReason: triggerResult.reason,
          idempotencyKey,
        },
        { prefix: false },
      ).slice(0, 32)}`;

      // 10. Intent Classification & Summarization (LLM + Heuristic Fallback)
      const classification = await this.classifier.classifyOpportunity(
        accountId,
        cluster,
        triggerResult.reason,
      );
      // Models may summarize intent, but cannot rewrite the deterministic operation class
      // or the exact command profiles that define the candidate's capability boundary.
      const primaryToolClass = cluster.representativeSignature.toolClasses[0];
      if (primaryToolClass) classification.taskClass = primaryToolClass;
      classification.commandProfiles = [...cluster.representativeSignature.commandPatterns];
      if (classification.commandProfiles.length > 0 && primaryToolClass === "vcs") {
        classification.pattern = `vcs_${classification.commandProfiles[0]!.replace(
          /[^a-z0-9]+/gi,
          "_",
        ).replace(/^_+|_+$/g, "")}`;
      }

      // 11. Construct OpportunityDetection domain entity
      // Invariant: Deterministic values (id, accountId, workspaceId, clusterId, structuralHash,
      // idempotencyKey, occurrenceCount, distinctSessionCount, evidenceEventIds, metrics, triggerReason)
      // are strictly preserved and cannot be overwritten by LLM.
      const opportunity: OpportunityDetection = {
        id: opportunityId,
        accountId,
        workspaceId,
        clusterId: cluster.clusterId,
        structuralHash: cluster.structuralHash,
        idempotencyKey,
        status,
        triggerType: triggerResult.triggerType,
        triggerReason: triggerResult.reason,
        occurrenceCount: cluster.episodeCount,
        distinctSessionCount: cluster.distinctSessionIds.length,
        evidenceEventIds: cluster.evidenceEventIds,
        coverage: coverageResult,
        suppression: suppressionResult,
        classification,
        metrics: {
          totalDurationMs: cluster.metrics.totalDurationMs,
          avgDurationMs: cluster.metrics.avgDurationMs,
          totalTokens: cluster.metrics.totalTokens,
          totalRetries: cluster.metrics.totalRetries,
          totalCostUsd: cluster.metrics.totalCostUsd,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      // 12. Save transactionally to PostgreSQL with outbox enqueue
      const saved = await this.repository.saveOpportunity(tenant, opportunity, params.db);

      if (saved.status === "eligible") {
        eligibleCount++;
      } else if (saved.status === "suppressed") {
        suppressedCount++;
      } else if (saved.status === "covered") {
        coveredCount++;
      } else if (saved.status === "duplicate") {
        duplicateCount++;
      }

      opportunities.push(saved);
    }

    return {
      episodes,
      clusters,
      opportunities,
      eligibleCount,
      suppressedCount,
      coveredCount,
      duplicateCount,
      timestamp,
    };
  }

  /**
   * Helper to process raw session events for a specific tenant and return detected opportunities.
   */
  async processSessionEvents(
    tenant: TenantContext,
    events: NormalizedSessionEvent[],
    options: {
      existingTools?: ToolManifest[];
      envelope?: CapabilityEnvelope;
      now?: number;
      db?: Queryable;
    } = {},
  ): Promise<OpportunityDetection[]> {
    TenantGuard.assertAccess(
      { accountId: tenant.accountId, workspaceId: tenant.workspaceId },
      tenant,
    );
    const result = await this.detectOpportunities({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      events,
      existingTools: options.existingTools,
      envelope: options.envelope,
      now: options.now,
      db: options.db,
    });
    return result.opportunities;
  }

  /**
   * Retrieves a single OpportunityDetection by ID with tenant isolation.
   */
  async getOpportunityById(
    tenant: TenantContext,
    opportunityId: string,
    db?: Queryable,
  ): Promise<OpportunityDetection | null> {
    await this.ensureInitialized();
    return this.repository.getOpportunityById(tenant, opportunityId, db);
  }

  /**
   * Lists detected opportunities matching filter criteria for a tenant.
   */
  async listOpportunities(
    tenant: TenantContext,
    filter: OpportunityFilter = {},
    db?: Queryable,
  ): Promise<OpportunityDetection[]> {
    await this.ensureInitialized();
    return this.repository.listOpportunities(tenant, filter, db);
  }

  /**
   * Retrieves recent opportunity hashes for cooldown tracking.
   */
  async getRecentOpportunityHashes(
    tenant: TenantContext,
    since: Date | string | number,
    db?: Queryable,
  ): Promise<Map<string, number>> {
    await this.ensureInitialized();
    return this.repository.getRecentOpportunityHashes(tenant, since, db);
  }
}

/**
 * Factory function creating an OpportunityDetectionService instance.
 */
export function createOpportunityDetectionService(
  options: OpportunityDetectionServiceOptions = {},
): OpportunityDetectionService {
  return new OpportunityDetectionService(options);
}
