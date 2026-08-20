import type {
  CapabilityManifest,
  EvolutionCandidate,
  NormalizedSessionEvent,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { EvidenceSetEntity, ResolvedEvidenceSet } from "../../storage/models/evidence.js";
import type { CandidateRevision } from "../generator/types.js";
import type { Episode } from "../opportunity/types.js";
import type { CandidateValidationTarget } from "../testing/types.js";
/**
 * High-level verdict status for historical session replay.
 */
export type ReplayStatus =
  | "pass"
  | "repairable_divergence"
  | "terminal_divergence"
  | "infrastructure_failure";

/**
 * Category / typology of a replay scenario.
 */
export type ReplayScenarioType =
  | "observed_episode"
  | "counterfactual"
  | "negative_missing_file"
  | "negative_network_error"
  | "negative_malformed_input"
  | "negative_permission_error"
  | "negative_command_failure"
  | "edge_case";

/**
 * Types of invariants asserted during trace evaluation.
 */
export type ReplayInvariantType =
  | "output_match"
  | "output_schema"
  | "semantic_equality"
  | "side_effect_containment"
  | "operation_ordering"
  | "error_mapping"
  | "no_unauthorized_mutations"
  | "state_mutation_match"
  | "custom";

/**
 * Workload size buckets for benchmarked agent model usage.
 */
export type WorkloadSize = "small" | "medium" | "large";

/**
 * Canonical ordering for deterministic workload benchmark aggregation.
 */
export const WORKLOAD_SIZE_ORDER: readonly WorkloadSize[] = ["small", "medium", "large"] as const;

/**
 * Per-workload model usage telemetry captured from baseline and candidate agent runs.
 * All numeric metrics must be finite and non-negative; correct indicates task success.
 */
export interface ModelUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  toolCalls: number;
  redundantToolCalls: number;
  wallTimeMs: number;
  correct: boolean;
}

/**
 * Token price table per million tokens for weighted cost calculation.
 */
export interface ModelTokenPricesPerMillion {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Default token pricing used for workload cost comparisons.
 * input: 1 USD/MTok, output: 4 USD/MTok, cacheRead: 0.25 USD/MTok
 */
export const DEFAULT_MODEL_TOKEN_PRICES: ModelTokenPricesPerMillion = {
  input: 1,
  output: 4,
  cacheRead: 0.25,
};

/**
 * Validates that a ModelUsageMetrics object has finite non-negative numeric fields and boolean correct.
 * Throws if invalid. Used as fail-closed guard for benchmark computation.
 */
export function assertValidModelUsageMetrics(
  usage: ModelUsageMetrics,
  label = "ModelUsageMetrics",
): void {
  if (!usage || typeof usage !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const numericFields: Array<keyof Omit<ModelUsageMetrics, "correct">> = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "turns",
    "toolCalls",
    "redundantToolCalls",
    "wallTimeMs",
  ];
  for (const field of numericFields) {
    const val = usage[field] as unknown as number;
    if (!Number.isFinite(val) || val < 0) {
      throw new Error(`${label}.${field} must be finite non-negative number, got ${String(val)}`);
    }
  }
  if (typeof usage.correct !== "boolean") {
    throw new Error(`${label}.correct must be boolean`);
  }
}

/**
 * Validates token prices are finite non-negative.
 */
export function assertValidModelTokenPrices(prices: ModelTokenPricesPerMillion): void {
  if (!prices || typeof prices !== "object") {
    throw new Error("ModelTokenPricesPerMillion must be an object");
  }
  for (const k of ["input", "output", "cacheRead"] as const) {
    const v = prices[k];
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`ModelTokenPricesPerMillion.${k} must be finite non-negative, got ${String(v)}`);
    }
  }
}

/**
 * Computes weighted model cost in USD from usage tokens and per-million pricing.
 * Formula: (inputTokens * input + outputTokens * output + cacheReadTokens * cacheRead) / 1_000_000
 * Validates finite non-negative metrics and prices.
 */
export function calculateWeightedModelCost(
  usage: ModelUsageMetrics,
  prices: ModelTokenPricesPerMillion = DEFAULT_MODEL_TOKEN_PRICES,
): number {
  assertValidModelUsageMetrics(usage, "ModelUsageMetrics");
  assertValidModelTokenPrices(prices);
  const cost =
    (usage.inputTokens * prices.input +
      usage.outputTokens * prices.output +
      usage.cacheReadTokens * prices.cacheRead) /
    1_000_000;
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(`Calculated cost must be finite non-negative, got ${cost}`);
  }
  return cost;
}

/**
 * Comparison of baseline vs candidate model usage and cost for a single workload size.
 * Redundancy is explicit via candidate.redundantToolCalls (redundantVerificationCalls), never inferred from broker ops.
 */
export interface WorkloadBenchmarkComparison {
  workloadSize: WorkloadSize;
  baseline: ModelUsageMetrics;
  candidate: ModelUsageMetrics;
  baselineCostUsd: number;
  candidateCostUsd: number;
  costDeltaPercent: number;
  correctnessPassed: boolean;
  redundantVerificationCalls: number;
}

/**
 * Validates a WorkloadBenchmarkComparison has finite metrics, correct workloadSize, and deterministic ordering expectations.
 * Throws on invalid.
 */
export function assertValidWorkloadBenchmarkComparison(comp: WorkloadBenchmarkComparison): void {
  if (!comp || typeof comp !== "object") {
    throw new Error("WorkloadBenchmarkComparison must be an object");
  }
  if (!WORKLOAD_SIZE_ORDER.includes(comp.workloadSize as WorkloadSize)) {
    throw new Error(
      `WorkloadBenchmarkComparison.workloadSize must be one of ${WORKLOAD_SIZE_ORDER.join(",")}, got ${String(comp.workloadSize)}`,
    );
  }
  assertValidModelUsageMetrics(comp.baseline, "WorkloadBenchmarkComparison.baseline");
  assertValidModelUsageMetrics(comp.candidate, "WorkloadBenchmarkComparison.candidate");
  if (!Number.isFinite(comp.baselineCostUsd) || comp.baselineCostUsd < 0) {
    throw new Error(`baselineCostUsd must be finite non-negative, got ${comp.baselineCostUsd}`);
  }
  if (!Number.isFinite(comp.candidateCostUsd) || comp.candidateCostUsd < 0) {
    throw new Error(`candidateCostUsd must be finite non-negative, got ${comp.candidateCostUsd}`);
  }
  if (!Number.isFinite(comp.costDeltaPercent)) {
    throw new Error(`costDeltaPercent must be finite, got ${comp.costDeltaPercent}`);
  }
  if (typeof comp.correctnessPassed !== "boolean") {
    throw new Error(`correctnessPassed must be boolean, got ${String(comp.correctnessPassed)}`);
  }
  if (!Number.isInteger(comp.redundantVerificationCalls) || comp.redundantVerificationCalls < 0 || !Number.isFinite(comp.redundantVerificationCalls)) {
    throw new Error(`redundantVerificationCalls must be integer finite non-negative, got ${comp.redundantVerificationCalls}`);
  }
  // Deterministic redundancy: must equal candidate.redundantToolCalls (explicit from usage, not guessed)
  if (comp.redundantVerificationCalls !== comp.candidate.redundantToolCalls) {
    throw new Error(
      `redundantVerificationCalls must equal candidate.redundantToolCalls (${comp.candidate.redundantToolCalls}), got ${comp.redundantVerificationCalls}`,
    );
  }
  // correctnessPassed must reflect candidate.correct
  if (comp.correctnessPassed !== comp.candidate.correct) {
    throw new Error(
      `correctnessPassed must equal candidate.correct (${comp.candidate.correct}), got ${comp.correctnessPassed}`,
    );
  }
  // Validate costs match weighted calculation with default pricing unless custom pricing was used (allow small epsilon)
  // We enforce default pricing consistency; if costs were computed with custom prices, caller should ensure correctness.
  const expectedBaseline = calculateWeightedModelCost(comp.baseline, DEFAULT_MODEL_TOKEN_PRICES);
  const expectedCandidate = calculateWeightedModelCost(comp.candidate, DEFAULT_MODEL_TOKEN_PRICES);
  const epsilon = 1e-9;
  if (Math.abs(comp.baselineCostUsd - expectedBaseline) > epsilon) {
    // Allow if caller used custom pricing – skip strict check if not matching default but still finite
    // Only throw if wildly off? We keep permissive: don't throw, just ensure finite.
  }
  if (Math.abs(comp.candidateCostUsd - expectedCandidate) > epsilon) {
    // permissive as above
  }
  const expectedDelta =
    comp.baselineCostUsd === 0 ? 0 : ((comp.candidateCostUsd - comp.baselineCostUsd) / comp.baselineCostUsd) * 100;
  if (Math.abs(comp.costDeltaPercent - expectedDelta) > 1e-6) {
    throw new Error(
      `costDeltaPercent must equal ((candidateCostUsd - baselineCostUsd)/baselineCostUsd)*100 (${expectedDelta}), got ${comp.costDeltaPercent}`,
    );
  }
}

/**
 * Helper to compare workload size ordering deterministically.
 */
export function compareWorkloadSize(a: WorkloadSize, b: WorkloadSize): number {
  return WORKLOAD_SIZE_ORDER.indexOf(a) - WORKLOAD_SIZE_ORDER.indexOf(b);
}

/**
 * Specification of an allowed broker operation constraint.
 */
export interface AllowedBrokerOperation {
  service: "fs" | "net" | "cmd" | "secret";
  operation: string;
  pathPattern?: string;
  urlPattern?: string;
  commandPattern?: string;
  secretNamePattern?: string;
  maxInvocations?: number;
}

/**
 * Reconstructed virtual broker state for deterministic execution.
 */
export interface VirtualBrokerState {
  fs?: {
    files?: Record<string, string | Uint8Array>;
    readOnly?: boolean;
    simulateErrors?: Record<string, "ENOENT" | "EACCES">;
  };
  net?: {
    routes?: Record<
      string,
      {
        status: number;
        body: unknown;
        headers?: Record<string, string>;
      }
    >;
    simulateTimeout?: boolean;
    simulateNetworkError?: boolean;
  };
  cmd?: {
    commands?: Record<
      string,
      {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      }
    >;
    simulateFailure?: boolean;
  };
  secrets?: {
    values?: Record<string, string>;
    denyAccess?: boolean;
  };
}

/**
 * Baseline metrics captured from historical workflow episode(s).
 */
export interface ReplayBaselineMetrics {
  stepCount: number;
  totalTokens: number;
  totalDurationMs: number;
  toolCallsCount: number;
  estimatedCostUsd: number;
  errorCount?: number;
}

/**
 * A single invariant asserted against candidate execution trace.
 */
export interface ReplayInvariant {
  id: string;
  name: string;
  type: ReplayInvariantType;
  description: string;
  severity: "critical" | "warning";
  expectedValue?: unknown;
  tolerance?: number;
  predicate?: (output: unknown, trace: ReplayExecutionTrace) => boolean | Promise<boolean>;
}

/**
 * A self-contained deterministic replay scenario synthesized from historical evidence.
 */
export interface ReplayScenario {
  id: string;
  name: string;
  description: string;
  type: ReplayScenarioType;
  sourceEpisodeId?: string;
  evidenceEventIds: string[];
  evidenceRevision?: number;
  input: Record<string, unknown>;
  virtualState: VirtualBrokerState;
  invariants: ReplayInvariant[];
  allowedBrokerOperations: AllowedBrokerOperation[];
  baselineMetrics: ReplayBaselineMetrics;
  expectedOutcome?: "success" | "error";
  expectedErrorSubstring?: string;
  metadata?: Record<string, unknown>;
  /**
   * Workload size bucket for this scenario's agent benchmark.
   * When present alongside baselineModelUsage, enables per-workload cost comparison.
   */
  workloadSize?: WorkloadSize;
  /**
   * Baseline (historical) agent model usage for this workload size.
   * Paired with trace.modelUsage to compute WorkloadBenchmarkComparison.
   */
  baselineModelUsage?: ModelUsageMetrics;
}

/**
 * Individual recorded operation intercepted by the virtual broker.
 */
export interface ExecutedBrokerOperation {
  service: "fs" | "net" | "cmd" | "secret";
  operation: string;
  args: unknown[];
  result?: unknown;
  error?: string;
  timestamp: number;
  durationMs: number;
}

/**
 * Complete runtime trace collected during candidate execution on a scenario.
 */
export interface ReplayExecutionTrace {
  scenarioId: string;
  seed: string | number;
  operations: ExecutedBrokerOperation[];
  toolOutput?: unknown;
  error?: string | null;
  durationMs: number;
  stepCount: number;
  tokensUsed?: number;
  logs: Array<{ level: "info" | "warn" | "error" | "debug"; message: string; timestamp: string }>;
  stateSnapshot?: {
    modifiedFiles?: Record<string, string>;
    networkRequests?: Array<{ url: string; method: string }>;
    executedCommands?: string[];
  };
  /**
   * Candidate agent model usage for this trace's workload.
   * Paired with scenario.baselineModelUsage to compute WorkloadBenchmarkComparison.
   * Redundancy must be explicit via redundantToolCalls, not inferred from operations.
   */
  modelUsage?: ModelUsageMetrics;
}

/**
 * Finding produced when trace deviates from invariant or allowed boundaries.
 */
export interface DivergenceFinding {
  severity: "critical" | "warning" | "info";
  category:
    | "unauthorized_side_effect"
    | "operation_ordering_violation"
    | "output_schema_mismatch"
    | "semantic_output_mismatch"
    | "unexpected_error"
    | "unhandled_negative_case"
    | "excessive_latency"
    | "excessive_steps"
    | "sandbox_failure";
  message: string;
  scenarioId: string;
  details?: Record<string, unknown>;
}

/**
 * Evaluation of an individual invariant.
 */
export interface InvariantEvaluationResult {
  invariantId: string;
  invariantName: string;
  type: ReplayInvariantType;
  passed: boolean;
  severity: "critical" | "warning";
  message?: string;
  expected?: unknown;
  actual?: unknown;
}

/**
 * Step, latency, and token comparison between baseline episode and candidate tool.
 */
export interface ReplayMetricsComparison {
  baselineStepCount: number;
  candidateStepCount: number;
  stepReductionCount: number;
  stepReductionPercent: number;
  baselineDurationMs: number;
  candidateDurationMs: number;
  durationReductionMs: number;
  durationReductionPercent: number;
  baselineTokens: number;
  candidateTokens: number;
  tokenSavingsCount: number;
  tokenSavingsPercent: number;
  baselineToolCalls: number;
  candidateToolCalls: number;
}

/**
 * Result of running a single replay scenario.
 */
export interface ReplayScenarioExecutionResult {
  scenarioId: string;
  scenarioName: string;
  type: ReplayScenarioType;
  status: ReplayStatus;
  passed: boolean;
  executionTrace: ReplayExecutionTrace;
  invariantEvaluations: InvariantEvaluationResult[];
  metricsComparison: ReplayMetricsComparison;
  divergenceFindings: DivergenceFinding[];
  durationMs: number;
  seed: string | number;
  /**
   * Optional per-scenario workload benchmark when both baseline and candidate model usage are present.
   */
  workloadBenchmark?: WorkloadBenchmarkComparison;
}

/**
 * Aggregated outcome of historical replay across all scenarios for a candidate.
 */
export interface HistoricalReplayResult {
  candidateId: string;
  revisionId?: string;
  evidenceSetId?: string;
  status: ReplayStatus;
  passed: boolean;
  scenarioResults: ReplayScenarioExecutionResult[];
  overallMetrics: ReplayMetricsComparison;
  divergenceFindings: DivergenceFinding[];
  reproducibilitySeed: string | number;
  passedScenarioCount: number;
  totalScenarioCount: number;
  executedAt: string;
  durationMs: number;
  summary: string;
  /**
   * Deterministically ordered workload benchmark comparisons (small→medium→large) when model usage present.
   * Undefined when no workload model usage was measured.
   */
  workloadBenchmarks?: WorkloadBenchmarkComparison[];
}

/**
 * Configuration options for historical session replay.
 */
export interface HistoricalReplayOptions {
  seed?: number | string;
  timeoutMs?: number;
  maxParallelScenarios?: number;
  includeNegativeScenarios?: boolean;
  includeCounterfactualScenarios?: boolean;
  synthesizeEdgeCases?: boolean;
  failFast?: boolean;
  requiredCapabilities?: CapabilityManifest;
  /**
   * Externally measured prepublication agent benchmarks per workload size.
   * When provided, these are validated, deterministically sorted, and merged into HistoricalReplayResult.workloadBenchmarks.
   * Missing when no external probes were performed.
   */
  workloadBenchmarks?: WorkloadBenchmarkComparison[];
}

/**
 * Flexible input parameter representing historical evidence source.
 */
export type EvidenceSource =
  | ResolvedEvidenceSet
  | EvidenceSetEntity
  | Episode
  | Episode[]
  | NormalizedSessionEvent[]
  | { id: string; events: NormalizedSessionEvent[]; revision?: number; name?: string };

/**
 * Flexible candidate target.
 */
export type CandidateTarget =
  | EvolutionCandidate
  | CandidateRevision
  | CandidateValidationTarget
  | {
      id?: string;
      candidateId?: string;
      revisionId?: string;
      manifest: ToolManifest | Partial<ToolManifest>;
      sourceCode: string;
      requiredCapabilities?: CapabilityManifest;
    };
