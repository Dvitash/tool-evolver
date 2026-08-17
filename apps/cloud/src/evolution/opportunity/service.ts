import { randomUUID } from "node:crypto";
import type {
  CapabilityEnvelope,
  NormalizedSessionEvent,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { InferenceService } from "../../models/service.js";
import type { TenantContext } from "../../tenant.js";
import { OpportunityClassifier } from "./classifier.js";
import { StructuralClusterer } from "./clustering.js";
import { CoverageEngine } from "./coverage.js";
import { EpisodeSegmenter } from "./episode.js";
import { SuppressionEngine } from "./suppression.js";
import { TriggerEvaluator } from "./triggers.js";
import type {
  ClustererOptions,
  DetectOpportunitiesParams,
  OpportunityDetection,
  OpportunityDetectionResult,
  OpportunityDetectionStatus,
  SegmenterOptions,
  SuppressionOptions,
  TriggerOptions,
} from "./types.js";

/**
 * Filter options for listing stored opportunities.
 */
export interface OpportunityFilter {
  status?: OpportunityDetectionStatus;
  workspaceId?: string;
  structuralHash?: string;
  triggerType?: "normal_frequency" | "exceptional_waste";
}

/**
 * Configuration options for OpportunityDetectionService.
 */
export interface OpportunityDetectionServiceOptions {
  segmenter?: SegmenterOptions;
  clusterer?: ClustererOptions;
  triggers?: TriggerOptions;
  suppression?: SuppressionOptions;
  inferenceService?: InferenceService;
}

/**
 * Orchestrates opportunity detection from normalized session history.
 */
export class OpportunityDetectionService {
  private readonly segmenter: EpisodeSegmenter;
  private readonly clusterer: StructuralClusterer;
  private readonly triggerEvaluator: TriggerEvaluator;
  private readonly coverageEngine: CoverageEngine;
  private readonly suppressionEngine: SuppressionEngine;
  private readonly classifier: OpportunityClassifier;

  // In-memory persistent store for detected opportunities (keyed by tenant/id)
  private readonly opportunityStore: Map<string, OpportunityDetection> = new Map();
  private readonly recentHashes: Map<string, number> = new Map();

  constructor(options: OpportunityDetectionServiceOptions = {}) {
    this.segmenter = new EpisodeSegmenter(options.segmenter);
    this.clusterer = new StructuralClusterer(options.clusterer);
    this.triggerEvaluator = new TriggerEvaluator(options.triggers);
    this.coverageEngine = new CoverageEngine();
    this.suppressionEngine = new SuppressionEngine(options.suppression);
    this.classifier = new OpportunityClassifier(options.inferenceService);
  }

  /**
   * Runs the complete opportunity detection pipeline over a stream of normalized session events.
   */
  async detectOpportunities(
    params: DetectOpportunitiesParams,
  ): Promise<OpportunityDetectionResult> {
    const { accountId, workspaceId, events, existingTools = [], envelope } = params;
    const now = params.now ?? Date.now();
    const timestamp = new Date(now).toISOString();

    // 1. Episode Segmentation
    const episodes = this.segmenter.segmentEvents(events);

    // 2. Structural Clustering
    const clusters = this.clusterer.clusterEpisodes(episodes);

    const opportunities: OpportunityDetection[] = [];
    let eligibleCount = 0;
    let suppressedCount = 0;
    let coveredCount = 0;
    let duplicateCount = 0;

    // Combine recent opportunity hashes for cooldown tracking
    const recentHashes = params.recentOpportunityHashes ?? this.recentHashes;

    for (const cluster of clusters) {
      // 3. Trigger Evaluation
      const triggerResult = this.triggerEvaluator.evaluateCluster(cluster);
      if (!triggerResult.triggered) {
        continue;
      }

      // 4. Suppression Analysis
      const suppressionResult = this.suppressionEngine.evaluateSuppression(cluster, {
        envelope,
        recentOpportunityHashes: recentHashes,
        now,
      });

      // 5. Coverage Analysis against existing tool catalog
      const coverageResult = this.coverageEngine.evaluateCoverage(cluster, existingTools);

      // 6. Determine Opportunity Detection Status
      let status: OpportunityDetectionStatus;
      if (coverageResult.status === "duplicate") {
        status = "duplicate";
        duplicateCount++;
      } else if (coverageResult.status === "covered") {
        status = "covered";
        coveredCount++;
      } else if (suppressionResult.suppressed) {
        status = "suppressed";
        suppressedCount++;
      } else {
        status = "eligible";
        eligibleCount++;
      }

      // 7. Intent Classification & Summarization (LLM + Heuristic Fallback)
      const classification = await this.classifier.classifyOpportunity(
        accountId,
        cluster,
        triggerResult.reason,
      );

      // 8. Construct OpportunityDetection domain entity
      // Invariant: Deterministic values (occurrenceCount, distinctSessionCount, evidenceEventIds, metrics, triggerReason)
      // are strictly preserved and cannot be overwritten by LLM.
      const opportunity: OpportunityDetection = {
        id: `opp_${randomUUID()}`,
        accountId,
        workspaceId,
        clusterId: cluster.clusterId,
        structuralHash: cluster.structuralHash,
        status,
        triggerType: triggerResult.triggerType as "normal_frequency" | "exceptional_waste",
        triggerReason: triggerResult.reason,
        occurrenceCount: triggerResult.metrics.occurrenceCount,
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

      // Persist in store
      this.opportunityStore.set(opportunity.id, opportunity);
      this.recentHashes.set(cluster.structuralHash, now);

      opportunities.push(opportunity);
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
   * Processes session events for a given tenant.
   */
  async processSessionEvents(
    tenant: TenantContext,
    events: NormalizedSessionEvent[],
    options: {
      existingTools?: ToolManifest[];
      envelope?: CapabilityEnvelope;
    } = {},
  ): Promise<OpportunityDetection[]> {
    const result = await this.detectOpportunities({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      events,
      existingTools: options.existingTools,
      envelope: options.envelope,
    });
    return result.opportunities;
  }

  /**
   * Retrieves a single OpportunityDetection by ID.
   */
  async getOpportunityById(
    tenant: TenantContext,
    opportunityId: string,
  ): Promise<OpportunityDetection | null> {
    const opp = this.opportunityStore.get(opportunityId);
    if (!opp) return null;
    if (opp.accountId !== tenant.accountId || opp.workspaceId !== tenant.workspaceId) {
      return null;
    }
    return opp;
  }

  /**
   * Lists detected opportunities matching filter criteria for a tenant.
   */
  async listOpportunities(
    tenant: TenantContext,
    filter: OpportunityFilter = {},
  ): Promise<OpportunityDetection[]> {
    const results: OpportunityDetection[] = [];

    for (const opp of this.opportunityStore.values()) {
      if (opp.accountId !== tenant.accountId) continue;
      if (opp.workspaceId !== tenant.workspaceId) continue;
      if (filter.status && opp.status !== filter.status) continue;
      if (filter.structuralHash && opp.structuralHash !== filter.structuralHash) continue;
      if (filter.triggerType && opp.triggerType !== filter.triggerType) continue;

      results.push(opp);
    }

    return results;
  }

  /**
   * Clears in-memory opportunity store (useful for testing).
   */
  clear(): void {
    this.opportunityStore.clear();
    this.recentHashes.clear();
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
