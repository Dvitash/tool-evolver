import type { CandidateTriggerReason } from "@tool-evolver/contracts";
import {
  DEFAULT_WASTE_THRESHOLDS,
  type Episode,
  type TriggerOptions,
  type TriggerResult,
  TriggerType,
  type WasteThresholds,
  type WorkflowCluster,
} from "./types.js";

const DEFAULT_MIN_OCCURRENCES_NORMAL = 3;

/**
 * Opportunity trigger evaluation engine.
 */
export class TriggerEvaluator {
  private readonly minOccurrencesNormal: number;
  private readonly wasteThresholds: WasteThresholds;

  constructor(options: TriggerOptions = {}) {
    this.minOccurrencesNormal = options.minOccurrencesNormal ?? DEFAULT_MIN_OCCURRENCES_NORMAL;
    this.wasteThresholds = {
      ...DEFAULT_WASTE_THRESHOLDS,
      ...options.wasteThresholds,
    };
  }

  /**
   * Evaluates if a workflow cluster meets opportunity trigger criteria.
   */
  evaluateCluster(cluster: WorkflowCluster): TriggerResult {
    const occurrenceCount =
      cluster.completedOccurrences > 0 ? cluster.completedOccurrences : cluster.episodeCount;
    const maxEpisodeMetrics = this.getMaxEpisodeMetrics(cluster.episodes);

    // 1. Normal Frequency Trigger: >= 3 distinct completed occurrences
    if (occurrenceCount >= this.minOccurrencesNormal) {
      return {
        triggered: true,
        triggerType: "normal_frequency",
        reason: "repeated_pattern",
        description: `Frequent workflow pattern detected across ${occurrenceCount} occurrences in ${cluster.distinctSessionIds.length} sessions.`,
        evidenceEventIds: cluster.evidenceEventIds,
        metrics: {
          occurrenceCount,
          durationMs: cluster.metrics.avgDurationMs,
          tokenCount: cluster.metrics.avgTokens,
          retryCount: cluster.metrics.totalRetries,
          estimatedCostUsd: cluster.metrics.totalCostUsd,
        },
      };
    }

    // 2. Exceptional Waste Trigger: 1 occurrence exceeding waste thresholds
    const wasteCheck = this.checkExceptionalWaste(maxEpisodeMetrics);
    if (wasteCheck.exceeded) {
      return {
        triggered: true,
        triggerType: "exceptional_waste",
        reason: wasteCheck.reason,
        description: `Exceptional resource waste detected on single occurrence: ${wasteCheck.description}`,
        evidenceEventIds: cluster.evidenceEventIds,
        metrics: {
          occurrenceCount,
          durationMs: maxEpisodeMetrics.durationMs,
          tokenCount: maxEpisodeMetrics.tokenCount,
          retryCount: maxEpisodeMetrics.retryCount,
          estimatedCostUsd: maxEpisodeMetrics.estimatedCostUsd,
        },
      };
    }

    // 3. Not Triggered
    return {
      triggered: false,
      triggerType: "none",
      reason: "repeated_pattern",
      description: `Workflow does not meet frequency threshold (found ${occurrenceCount} < ${this.minOccurrencesNormal}) nor exceptional waste criteria.`,
      evidenceEventIds: cluster.evidenceEventIds,
      metrics: {
        occurrenceCount,
        durationMs: cluster.metrics.avgDurationMs,
        tokenCount: cluster.metrics.avgTokens,
        retryCount: cluster.metrics.totalRetries,
        estimatedCostUsd: cluster.metrics.totalCostUsd,
      },
    };
  }

  /**
   * Evaluates a single episode directly for exceptional waste triggers.
   */
  evaluateSingleEpisode(episode: Episode): TriggerResult {
    const metrics = {
      durationMs: episode.metrics.totalDurationMs,
      tokenCount: episode.metrics.totalTokens,
      retryCount: episode.metrics.retryCount,
      estimatedCostUsd: episode.metrics.estimatedCostUsd,
      stepCount: episode.metrics.stepCount,
    };

    const wasteCheck = this.checkExceptionalWaste(metrics);
    const eventIds = episode.events.map((e) => e.eventId);

    if (wasteCheck.exceeded) {
      return {
        triggered: true,
        triggerType: "exceptional_waste",
        reason: wasteCheck.reason,
        description: `Exceptional resource waste detected in episode: ${wasteCheck.description}`,
        evidenceEventIds: eventIds,
        metrics: {
          occurrenceCount: 1,
          durationMs: episode.metrics.totalDurationMs,
          tokenCount: episode.metrics.totalTokens,
          retryCount: episode.metrics.retryCount,
          estimatedCostUsd: episode.metrics.estimatedCostUsd,
        },
      };
    }

    return {
      triggered: false,
      triggerType: "none",
      reason: "repeated_pattern",
      description: "Single episode does not exceed exceptional waste thresholds.",
      evidenceEventIds: eventIds,
      metrics: {
        occurrenceCount: 1,
        durationMs: episode.metrics.totalDurationMs,
        tokenCount: episode.metrics.totalTokens,
        retryCount: episode.metrics.retryCount,
        estimatedCostUsd: episode.metrics.estimatedCostUsd,
      },
    };
  }

  /**
   * Computes the maximum metric values observed across any single episode in the cluster.
   */
  private getMaxEpisodeMetrics(episodes: Episode[]): {
    durationMs: number;
    tokenCount: number;
    retryCount: number;
    estimatedCostUsd: number;
    stepCount: number;
  } {
    let maxDurationMs = 0;
    let maxTokens = 0;
    let maxRetries = 0;
    let maxCostUsd = 0;
    let maxSteps = 0;

    for (const ep of episodes) {
      if (ep.metrics.totalDurationMs > maxDurationMs) maxDurationMs = ep.metrics.totalDurationMs;
      if (ep.metrics.totalTokens > maxTokens) maxTokens = ep.metrics.totalTokens;
      if (ep.metrics.retryCount > maxRetries) maxRetries = ep.metrics.retryCount;
      if (ep.metrics.estimatedCostUsd > maxCostUsd) maxCostUsd = ep.metrics.estimatedCostUsd;
      if (ep.metrics.stepCount > maxSteps) maxSteps = ep.metrics.stepCount;
    }

    return {
      durationMs: maxDurationMs,
      tokenCount: maxTokens,
      retryCount: maxRetries,
      estimatedCostUsd: maxCostUsd,
      stepCount: maxSteps,
    };
  }

  /**
   * Checks if metrics exceed any exceptional waste threshold.
   */
  private checkExceptionalWaste(metrics: {
    durationMs: number;
    tokenCount: number;
    retryCount: number;
    estimatedCostUsd: number;
    stepCount: number;
  }): { exceeded: boolean; reason: CandidateTriggerReason; description: string } {
    // 1. Retry / failure recovery waste
    if (metrics.retryCount >= this.wasteThresholds.exceptionalRetryCount) {
      return {
        exceeded: true,
        reason: "failure_recovery",
        description: `High retry count (${metrics.retryCount} retries >= threshold ${this.wasteThresholds.exceptionalRetryCount})`,
      };
    }

    // 2. High latency bottleneck
    if (metrics.durationMs >= this.wasteThresholds.exceptionalDurationMs) {
      return {
        exceeded: true,
        reason: "latency_bottleneck",
        description: `High duration (${Math.round(metrics.durationMs / 1000)}s >= threshold ${Math.round(this.wasteThresholds.exceptionalDurationMs / 1000)}s)`,
      };
    }

    // 3. Token volume waste
    if (metrics.tokenCount >= this.wasteThresholds.exceptionalTokenCount) {
      return {
        exceeded: true,
        reason: "missing_abstraction",
        description: `High token consumption (${metrics.tokenCount} tokens >= threshold ${this.wasteThresholds.exceptionalTokenCount})`,
      };
    }

    // 4. Financial cost waste
    if (metrics.estimatedCostUsd >= this.wasteThresholds.exceptionalCostUsd) {
      return {
        exceeded: true,
        reason: "missing_abstraction",
        description: `High estimated cost ($${metrics.estimatedCostUsd} >= threshold $${this.wasteThresholds.exceptionalCostUsd})`,
      };
    }

    // 5. Excessive manual steps
    if (metrics.stepCount >= this.wasteThresholds.exceptionalStepCount) {
      return {
        exceeded: true,
        reason: "missing_abstraction",
        description: `High step count (${metrics.stepCount} steps >= threshold ${this.wasteThresholds.exceptionalStepCount})`,
      };
    }

    return {
      exceeded: false,
      reason: "repeated_pattern",
      description: "No waste thresholds exceeded.",
    };
  }
}

/**
 * Convenience function to evaluate triggers for a cluster.
 */
export function evaluateOpportunityTriggers(
  cluster: WorkflowCluster,
  options?: TriggerOptions,
): TriggerResult {
  const evaluator = new TriggerEvaluator(options);
  return evaluator.evaluateCluster(cluster);
}
