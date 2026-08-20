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
 * Evaluator-owned canonical cost schedule V1.
 * input: 1 USD/MTok, output: 4 USD/MTok, cacheRead: 0.25 USD/MTok
 * Rows must reference this via scheduleId; arbitrary caller prices are NEVER trusted.
 */
export const MODEL_COST_SCHEDULE_V1: Readonly<ModelTokenPricesPerMillion> = {
  input: 1,
  output: 4,
  cacheRead: 0.25,
} as const;

/** Canonical schedule identifier */
export const MODEL_COST_SCHEDULE_ID_V1 = "MODEL_COST_SCHEDULE_V1" as const;

/**
 * Evaluator-owned schedule registry — server-side authority for pricing.
 * Only scheduleIds present here are valid; unknown IDs are terminally rejected.
 */
export const MODEL_COST_SCHEDULES: Readonly<Record<string, Readonly<ModelTokenPricesPerMillion>>> = {
  [MODEL_COST_SCHEDULE_ID_V1]: MODEL_COST_SCHEDULE_V1,
} as const;


/**
 * HMAC-SHA256 benchmark attestation binding a benchmark row to its canonical payload.
 * issuer/keyId identify the signing key; signature is hex HMAC-SHA256 over canonical JSON of the row excluding attestation.
 * Secret is NEVER logged or exposed.
 */
export interface BenchmarkAttestation {
  issuer: string;
  keyId: string;
  algorithm: "hmac-sha256";
  signature: string;
}


/**
 * Resolves a scheduleId to its authoritative pricing. Throws on unknown schedule.
 */
export function resolveModelCostSchedule(scheduleId: string): ModelTokenPricesPerMillion {
  const prices = (MODEL_COST_SCHEDULES as Record<string, ModelTokenPricesPerMillion>)[scheduleId];
  if (!prices) {
    throw new Error(`Unknown model cost scheduleId '${scheduleId}' — must be one of ${Object.keys(MODEL_COST_SCHEDULES).join(", ")}`);
  }
  return prices;
}

/**
 * Validates scheduleId is a known evaluator-owned schedule.
 */
export function assertValidScheduleId(scheduleId: unknown): void {
  if (typeof scheduleId !== "string" || !scheduleId.trim()) {
    throw new Error(`scheduleId must be a non-empty string, got ${String(scheduleId)}`);
  }
  if (!(scheduleId in MODEL_COST_SCHEDULES)) {
    throw new Error(`Unknown scheduleId '${String(scheduleId)}' — must be one of ${Object.keys(MODEL_COST_SCHEDULES).join(", ")}`);
  }
}

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
 * Computes weighted model cost in USD from usage tokens and authoritative schedule pricing.
 * Formula: (inputTokens * input + outputTokens * output + cacheReadTokens * cacheRead) / 1_000_000
 * Resolves scheduleId server-side via MODEL_COST_SCHEDULES; unknown scheduleId throws terminally.
 * Zero-price forgery impossible — caller cannot supply arbitrary prices.
 */
export function calculateWeightedModelCost(
  usage: ModelUsageMetrics,
  scheduleId: string = MODEL_COST_SCHEDULE_ID_V1,
): number {
  assertValidModelUsageMetrics(usage, "ModelUsageMetrics");
  assertValidScheduleId(scheduleId);
  const prices = resolveModelCostSchedule(scheduleId);
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
 * Canonical explicit benchmark evidence carrying all immutable identity/binding/pricing fields.
 * Required alongside workloadSize + baselineModelUsage + trace.modelUsage to derive a scenario benchmark.
 * No placeholder values are fabricated; absence yields no benchmark.
 */
export interface WorkloadBenchmarkEvidence {
  benchmarkId: string;
  baselineRunId: string;
  candidateRunId: string;
  workloadInputDigest: string;
  candidateRevisionId: string;
  artifactDigest: string;
  modelProvider: string;
  modelId: string;
  observedAt: string;
  scheduleId: string;
}

/**
 * Comparison of baseline vs candidate model usage and cost for a single workload size.
 * Redundancy is explicit via candidate.redundantToolCalls (redundantVerificationCalls), never inferred from broker ops.
 * Immutable evidence binding fields prevent row relabeling and cost forgery; all are required.
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
  benchmarkId: string;
  baselineRunId: string;
  candidateRunId: string;
  workloadInputDigest: string;
  candidateRevisionId: string;
  artifactDigest: string;
  modelProvider: string;
  modelId: string;
  observedAt: string;
  scheduleId: string;
  attestation?: BenchmarkAttestation;
}

/**
 * Helpers for immutable benchmark evidence validation.
 */
function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidIdentifier(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,127}$/.test(value)
  );
}

function isValidSha256Digest(value: unknown): boolean {
  return typeof value === "string" && /^(sha256:)?[a-f0-9]{64}$/i.test(value);
}

function isValidIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}(:\d{2})?)$/.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function isValidHexSignature(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isValidBenchmarkAttestationFormat(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.issuer === "string" &&
    (a.issuer as string).trim().length > 0 &&
    typeof a.keyId === "string" &&
    (a.keyId as string).trim().length > 0 &&
    a.algorithm === "hmac-sha256" &&
    isValidHexSignature(a.signature)
  );
}

/**
 * Validates a BenchmarkAttestation has correct formats and required fields.
 */
export function assertValidBenchmarkAttestation(
  att: BenchmarkAttestation,
  label = "BenchmarkAttestation",
): void {
  if (!att || typeof att !== "object") {
    throw new Error(`${label} must be an object`);
  }
  if (!isNonEmptyString((att as unknown as Record<string, unknown>).issuer)) {
    throw new Error(`${label}.issuer must be a nonempty string, got ${String((att as unknown as Record<string, unknown>).issuer)}`);
  }
  if (!isNonEmptyString((att as unknown as Record<string, unknown>).keyId)) {
    throw new Error(`${label}.keyId must be a nonempty string, got ${String((att as unknown as Record<string, unknown>).keyId)}`);
  }
  if ((att as unknown as Record<string, unknown>).algorithm !== "hmac-sha256") {
    throw new Error(`${label}.algorithm must be 'hmac-sha256', got ${String((att as unknown as Record<string, unknown>).algorithm)}`);
  }
  if (!isValidHexSignature((att as unknown as Record<string, unknown>).signature)) {
    throw new Error(`${label}.signature must be a 64-char hex HMAC-SHA256, got ${String((att as unknown as Record<string, unknown>).signature)}`);
  }
}


/**
 * Validates a WorkloadBenchmarkEvidence has correct formats and required fields.
 */
export function assertValidWorkloadBenchmarkEvidence(
  ev: WorkloadBenchmarkEvidence,
  label = "WorkloadBenchmarkEvidence",
): void {
  if (!ev || typeof ev !== "object") {
    throw new Error(`${label} must be an object`);
  }
  if (!isValidIdentifier(ev.benchmarkId)) {
    throw new Error(`${label}.benchmarkId must be a valid identifier (nonempty, a-zA-Z0-9_-. :), got ${String(ev.benchmarkId)}`);
  }
  if (!isValidIdentifier(ev.baselineRunId)) {
    throw new Error(`${label}.baselineRunId must be a valid identifier, got ${String(ev.baselineRunId)}`);
  }
  if (!isValidIdentifier(ev.candidateRunId)) {
    throw new Error(`${label}.candidateRunId must be a valid identifier, got ${String(ev.candidateRunId)}`);
  }
  if (!isValidSha256Digest(ev.workloadInputDigest)) {
    throw new Error(`${label}.workloadInputDigest must be a valid SHA-256 digest (64 hex or sha256: hex), got ${String(ev.workloadInputDigest)}`);
  }
  if (!isValidIdentifier(ev.candidateRevisionId)) {
    throw new Error(`${label}.candidateRevisionId must be a valid identifier, got ${String(ev.candidateRevisionId)}`);
  }
  if (!isValidSha256Digest(ev.artifactDigest)) {
    throw new Error(`${label}.artifactDigest must be a valid SHA-256 digest, got ${String(ev.artifactDigest)}`);
  }
  if (!isNonEmptyString(ev.modelProvider)) {
    throw new Error(`${label}.modelProvider must be a nonempty string, got ${String(ev.modelProvider)}`);
  }
  if (!isNonEmptyString(ev.modelId)) {
    throw new Error(`${label}.modelId must be a nonempty string, got ${String(ev.modelId)}`);
  }
  if (!isValidIsoTimestamp(ev.observedAt)) {
    throw new Error(`${label}.observedAt must be a valid ISO 8601 timestamp, got ${String(ev.observedAt)}`);
  }
  assertValidScheduleId(ev.scheduleId);
  if ((ev as unknown as Record<string, unknown>).attestation !== undefined) {
    assertValidBenchmarkAttestation((ev as unknown as Record<string, unknown>).attestation as BenchmarkAttestation, `${label}.attestation`);
  }
}

/**
 * Validates a WorkloadBenchmarkComparison has finite metrics, correct workloadSize, and deterministic ordering expectations.
 * Throws on invalid. Recomputes weighted costs server-side from raw usage and authoritative scheduleId; rejects caller costs/deltas that mismatch.
 * Validates ISO observedAt, nonempty identities/digests/model fields, and binding formats. All evidence fields are required.
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
  if (!isValidIdentifier((comp as unknown as Record<string, unknown>).benchmarkId)) {
    throw new Error(`WorkloadBenchmarkComparison.benchmarkId must be a valid identifier (nonempty, a-zA-Z0-9_-. :), got ${String((comp as unknown as Record<string, unknown>).benchmarkId)}`);
  }
  if (!isValidIdentifier((comp as unknown as Record<string, unknown>).baselineRunId)) {
    throw new Error(`WorkloadBenchmarkComparison.baselineRunId must be a valid identifier, got ${String((comp as unknown as Record<string, unknown>).baselineRunId)}`);
  }
  if (!isValidIdentifier((comp as unknown as Record<string, unknown>).candidateRunId)) {
    throw new Error(`WorkloadBenchmarkComparison.candidateRunId must be a valid identifier, got ${String((comp as unknown as Record<string, unknown>).candidateRunId)}`);
  }
  if (!isValidSha256Digest((comp as unknown as Record<string, unknown>).workloadInputDigest)) {
    throw new Error(`WorkloadBenchmarkComparison.workloadInputDigest must be a valid SHA-256 digest (64 hex or sha256: hex), got ${String((comp as unknown as Record<string, unknown>).workloadInputDigest)}`);
  }
  if (!isValidIdentifier((comp as unknown as Record<string, unknown>).candidateRevisionId)) {
    throw new Error(`WorkloadBenchmarkComparison.candidateRevisionId must be a valid identifier, got ${String((comp as unknown as Record<string, unknown>).candidateRevisionId)}`);
  }
  if (!isValidSha256Digest((comp as unknown as Record<string, unknown>).artifactDigest)) {
    throw new Error(`WorkloadBenchmarkComparison.artifactDigest must be a valid SHA-256 digest, got ${String((comp as unknown as Record<string, unknown>).artifactDigest)}`);
  }
  if (!isNonEmptyString((comp as unknown as Record<string, unknown>).modelProvider)) {
    throw new Error(`WorkloadBenchmarkComparison.modelProvider must be a nonempty string, got ${String((comp as unknown as Record<string, unknown>).modelProvider)}`);
  }
  if (!isNonEmptyString((comp as unknown as Record<string, unknown>).modelId)) {
    throw new Error(`WorkloadBenchmarkComparison.modelId must be a nonempty string, got ${String((comp as unknown as Record<string, unknown>).modelId)}`);
  }
  if (!isValidIsoTimestamp((comp as unknown as Record<string, unknown>).observedAt)) {
    throw new Error(`WorkloadBenchmarkComparison.observedAt must be a valid ISO 8601 timestamp, got ${String((comp as unknown as Record<string, unknown>).observedAt)}`);
  }
  assertValidScheduleId(comp.scheduleId);
  if ((comp as unknown as Record<string, unknown>).attestation !== undefined) {
    assertValidBenchmarkAttestation((comp as unknown as Record<string, unknown>).attestation as BenchmarkAttestation, "WorkloadBenchmarkComparison.attestation");
  }
  assertValidModelUsageMetrics(comp.baseline, "WorkloadBenchmarkComparison.baseline");
  assertValidModelUsageMetrics(comp.candidate, "WorkloadBenchmarkComparison.candidate");
  const expectedBaseline = calculateWeightedModelCost(comp.baseline, comp.scheduleId);
  const expectedCandidate = calculateWeightedModelCost(comp.candidate, comp.scheduleId);
  const epsilon = 1e-9;
  if (Math.abs(comp.baselineCostUsd - expectedBaseline) > epsilon) {
    throw new Error(
      `baselineCostUsd must equal weighted cost from baseline usage and scheduleId (${expectedBaseline}), got ${comp.baselineCostUsd}`,
    );
  }
  if (Math.abs(comp.candidateCostUsd - expectedCandidate) > epsilon) {
    throw new Error(
      `candidateCostUsd must equal weighted cost from candidate usage and scheduleId (${expectedCandidate}), got ${comp.candidateCostUsd}`,
    );
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
   * When present alongside baselineModelUsage and benchmarkEvidence, enables per-workload cost comparison.
   */
  workloadSize?: WorkloadSize;
  /**
   * Baseline (historical) agent model usage for this workload size.
   * Paired with trace.modelUsage and benchmarkEvidence to compute WorkloadBenchmarkComparison.
   */
  baselineModelUsage?: ModelUsageMetrics;
  /**
   * Canonical explicit benchmark evidence carrying all immutable identity/binding/pricing fields.
   * Required alongside workloadSize and baselineModelUsage to derive a scenario benchmark; otherwise no benchmark is produced.
   * No placeholder fabrication.
   */
  benchmarkEvidence?: WorkloadBenchmarkEvidence;
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
   * Paired with scenario.baselineModelUsage and scenario.benchmarkEvidence to compute WorkloadBenchmarkComparison.
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
   * Optional per-scenario workload benchmark when both baseline and candidate model usage and explicit evidence are present.
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
   * Missing when no external probes were performed. Each row must be fully bound with immutable evidence.
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
