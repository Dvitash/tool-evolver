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
