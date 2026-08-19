import {
  type CandidateTriggerReason,
  type CapabilityEnvelope,
  CapabilityManifest,
  type NormalizedSessionEvent,
  type ToolManifest,
} from "@tool-evolver/contracts";
import { z } from "zod";
import type { Queryable } from "../../db/client.js";

/**
 * High-level functional category of a tool or command.
 */
export type ToolClass =
  | "file_read"
  | "file_edit"
  | "search"
  | "test_runner"
  | "build_tool"
  | "vcs"
  | "package_manager"
  | "shell_exec"
  | "subagent"
  | "browser"
  | "network"
  | "general";

/**
 * Metric summary for an individual episode.
 */
export interface EpisodeMetrics {
  stepCount: number;
  totalTokens: number;
  retryCount: number;
  estimatedCostUsd: number;
  totalDurationMs: number;
}

/**
 * A contiguous segment of a session / branch event stream representing a cohesive workflow.
 */
export interface Episode {
  id: string;
  sessionId: string;
  branchId?: string;
  accountId: string;
  workspaceId: string;
  events: NormalizedSessionEvent[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turnIndex: number;
  isCompleted: boolean;
  hasErrors: boolean;
  metrics: EpisodeMetrics;
}

/**
 * Deterministic structural features extracted from an Episode.
 */
export interface EpisodeSignature {
  signatureId: string;
  structuralHash: string;
  operationSequence: string[];
  toolClasses: ToolClass[];
  commandPatterns: string[];
  normalizedPaths: string[];
  argumentShapeHashes: string[];
  stepCount: number;
  totalDurationMs: number;
  totalTokens: number;
  retryCount: number;
  estimatedCostUsd: number;
  errorTypes: string[];
}

/**
 * Aggregated metrics across all episodes in a workflow cluster.
 */
export interface ClusterMetrics {
  totalDurationMs: number;
  avgDurationMs: number;
  totalTokens: number;
  avgTokens: number;
  totalCostUsd: number;
  totalRetries: number;
  totalStepCount: number;
  avgStepCount: number;
}

/**
 * Structural cluster of similar episodes in a workspace.
 */
export interface WorkflowCluster {
  clusterId: string;
  workspaceId: string;
  version: string;
  structuralHash: string;
  representativeSignature: EpisodeSignature;
  episodes: Episode[];
  episodeCount: number;
  distinctSessionIds: string[];
  completedOccurrences: number;
  metrics: ClusterMetrics;
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceEventIds: string[];
}

/**
 * Opportunity trigger evaluation type.
 */
export type TriggerType = "normal_frequency" | "exceptional_waste" | "none";

/**
 * Waste thresholds for triggering exceptional opportunities on a single occurrence.
 */
export interface WasteThresholds {
  exceptionalDurationMs: number;
  exceptionalTokenCount: number;
  exceptionalRetryCount: number;
  exceptionalCostUsd: number;
  exceptionalStepCount: number;
}

export const DEFAULT_WASTE_THRESHOLDS: WasteThresholds = {
  exceptionalDurationMs: 120_000, // 2 minutes
  exceptionalTokenCount: 25_000,
  exceptionalRetryCount: 3,
  exceptionalCostUsd: 0.5,
  exceptionalStepCount: 15,
};

/**
 * Result of evaluating opportunity triggers on a cluster or episode.
 */
export interface TriggerResult {
  triggered: boolean;
  triggerType: TriggerType;
  reason: CandidateTriggerReason;
  description: string;
  evidenceEventIds: string[];
  metrics: {
    occurrenceCount: number;
    durationMs: number;
    tokenCount: number;
    retryCount: number;
    estimatedCostUsd: number;
  };
}

/**
 * Tool coverage status relative to existing catalog.
 */
export type CoverageStatus = "net_new" | "update_candidate" | "covered" | "duplicate";

/**
 * Result of comparing a cluster to existing tool catalog.
 */
export interface CoverageResult {
  status: CoverageStatus;
  matchingToolId?: string;
  matchingToolName?: string;
  similarityScore: number;
  overlapRatio: number;
  reason: string;
  suggestedActions?: string[];
}

/**
 * Suppression reason for unviable opportunities.
 */
export type SuppressionReason =
  | "trivial"
  | "out_of_envelope"
  | "destructive"
  | "unobservable"
  | "in_cooldown"
  | "none";

/**
 * Result of suppression analysis.
 */
export interface SuppressionResult {
  suppressed: boolean;
  reason: SuppressionReason;
  details: string;
}

/**
 * Parameter inferred for candidate tool by classifier.
 */
export interface OpportunityInferredInput {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
}

/**
 * Model or rule-generated classification metadata for an opportunity.
 */
export interface OpportunityClassification {
  title: string;
  description: string;
  taskClass: string;
  pattern: string;
  confidenceScore: number;
  priority: "low" | "medium" | "high" | "critical";
  inferredInputs?: OpportunityInferredInput[];
  candidateOutputSchema?: Record<string, unknown>;
  suggestedToolName?: string;
  commandProfiles?: string[];
  provenance?: Record<string, unknown>;
}

/**
 * Lifecycle status of an OpportunityDetection record.
 */
export type OpportunityDetectionStatus = "eligible" | "suppressed" | "covered" | "duplicate";

/**
 * First-class OpportunityDetection domain entity.
 */
export interface OpportunityDetection {
  id: string;
  accountId: string;
  workspaceId: string;
  clusterId: string;
  structuralHash: string;
  idempotencyKey?: string;
  status: OpportunityDetectionStatus;
  triggerType: "normal_frequency" | "exceptional_waste";
  triggerReason: CandidateTriggerReason;
  occurrenceCount: number;
  distinctSessionCount: number;
  evidenceEventIds: string[];
  coverage: CoverageResult;
  suppression: SuppressionResult;
  classification: OpportunityClassification;
  metrics: {
    totalDurationMs: number;
    avgDurationMs: number;
    totalTokens: number;
    totalRetries: number;
    totalCostUsd: number;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Options for EpisodeSegmenter.
 */
export interface SegmenterOptions {
  idleGapThresholdMs?: number;
  minEventsPerEpisode?: number;
  maxEventsPerEpisode?: number;
}

/**
 * Options for StructuralClusterer.
 */
export interface ClustererOptions {
  version?: string;
  similarityThreshold?: number;
}

/**
 * Options for TriggerEvaluator.
 */
export interface TriggerOptions {
  minOccurrencesNormal?: number;
  wasteThresholds?: Partial<WasteThresholds>;
}

/**
 * Options for SuppressionEngine.
 */
export interface SuppressionOptions {
  cooldownMs?: number;
  disallowedCommands?: string[];
  minMeaningfulSteps?: number;
}

/**
 * Filter criteria for querying opportunities.
 */
export interface OpportunityFilter {
  status?: OpportunityDetectionStatus;
  workspaceId?: string;
  structuralHash?: string;
  triggerType?: "normal_frequency" | "exceptional_waste";
  limit?: number;
  offset?: number;
}

/**
 * Parameters for OpportunityDetectionService.detectOpportunities.
 */
export interface DetectOpportunitiesParams {
  accountId: string;
  workspaceId: string;
  events: NormalizedSessionEvent[];
  existingTools?: ToolManifest[];
  envelope?: CapabilityEnvelope;
  recentOpportunityHashes?: Set<string> | Map<string, number>;
  now?: number;
  db?: Queryable;
}

/**
 * Result of detecting opportunities.
 */
export interface OpportunityDetectionResult {
  episodes: Episode[];
  clusters: WorkflowCluster[];
  opportunities: OpportunityDetection[];
  eligibleCount: number;
  suppressedCount: number;
  coveredCount: number;
  duplicateCount: number;
  timestamp: string;
}
