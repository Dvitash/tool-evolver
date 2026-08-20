import { type CapabilityManifest, CapabilityManifestSchema } from "@tool-evolver/contracts";
import type { DatabasePool } from "../../db/client.js";
import { EvidenceRepository } from "../../storage/repositories/evidence-repository.js";
import type { TenantContext } from "../../tenant.js";
import { HistoricalReplayRunner } from "./runner.js";
import { ReplayScenarioBuilder } from "./scenario-builder.js";
import type {
  CandidateTarget,
  EvidenceSource,
  HistoricalReplayOptions,
  HistoricalReplayResult,
  ModelUsageMetrics,
  ReplayScenario,
  ReplayScenarioExecutionResult,
  WorkloadBenchmarkComparison,
  WorkloadSize,
} from "./types.js";
import { WORKLOAD_SIZE_ORDER } from "./types.js";

/**
 * Options for replaying a candidate against historical evidence.
 */
export interface ReplayCandidateOptions {
  candidate: CandidateTarget;
  evidence?: EvidenceSource;
  evidenceSetId?: string;
  options?: HistoricalReplayOptions;
}

/**
 * Configuration options for HistoricalReplayService.
 */
export interface HistoricalReplayServiceOptions {
  builder?: ReplayScenarioBuilder;
  runner?: HistoricalReplayRunner;
  evidenceRepo?: EvidenceRepository;
  dbPool?: DatabasePool;
  defaultTimeoutMs?: number;
  defaultSeed?: number | string;
}

type LooseCapabilityManifest = {
  manifestId?: string;
  fs?: Partial<CapabilityManifest["fs"]>;
  net?: Partial<CapabilityManifest["net"]>;
  command?: Partial<CapabilityManifest["command"]>;
  secrets?: Partial<CapabilityManifest["secrets"]>;
  limits?: Partial<CapabilityManifest["limits"]>;
  exec?: {
    allowExec?: boolean;
    allowedCommands?: string[];
  };
};

function workloadOrderIndex(size: WorkloadSize): number {
  const idx = WORKLOAD_SIZE_ORDER.indexOf(size);
  return idx >= 0 ? idx : 999;
}

const ALLOWED_WORKLOAD_SIZES = new Set<WorkloadSize>(WORKLOAD_SIZE_ORDER as readonly WorkloadSize[]);

function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function validateModelUsageMetrics(metrics: unknown, path: string): ModelUsageMetrics {
  if (typeof metrics !== "object" || metrics === null) {
    throw new Error(`${path} must be an object`);
  }
  const m = metrics as Record<string, unknown>;
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "turns", "toolCalls", "redundantToolCalls", "wallTimeMs", "correct"]) {
    if (!(k in m)) {
      throw new Error(`${path}.${k} is required`);
    }
  }
  if (!isFiniteNonNegative(m.inputTokens) || !Number.isInteger(m.inputTokens as number)) {
    throw new Error(`${path}.inputTokens must be a finite non-negative integer`);
  }
  if (!isFiniteNonNegative(m.outputTokens) || !Number.isInteger(m.outputTokens as number)) {
    throw new Error(`${path}.outputTokens must be a finite non-negative integer`);
  }
  if (!isFiniteNonNegative(m.cacheReadTokens) || !Number.isInteger(m.cacheReadTokens as number)) {
    throw new Error(`${path}.cacheReadTokens must be a finite non-negative integer`);
  }
  if (!isFiniteNonNegative(m.turns) || !Number.isInteger(m.turns as number)) {
    throw new Error(`${path}.turns must be a finite non-negative integer`);
  }
  if (!isFiniteNonNegative(m.toolCalls) || !Number.isInteger(m.toolCalls as number)) {
    throw new Error(`${path}.toolCalls must be a finite non-negative integer`);
  }
  if (!isFiniteNonNegative(m.redundantToolCalls) || !Number.isInteger(m.redundantToolCalls as number)) {
    throw new Error(`${path}.redundantToolCalls must be a finite non-negative integer`);
  }
  if (!isFiniteNonNegative(m.wallTimeMs)) {
    throw new Error(`${path}.wallTimeMs must be a finite non-negative number`);
  }
  if (typeof m.correct !== "boolean") {
    throw new Error(`${path}.correct must be a boolean`);
  }
  return m as unknown as ModelUsageMetrics;
}

function validateWorkloadBenchmarkComparison(value: unknown, index: number): WorkloadBenchmarkComparison {
  const path = `workloadBenchmarks[${index}]`;
  if (typeof value !== "object" || value === null) {
    throw new Error(`${path} must be an object`);
  }
  const r = value as Record<string, unknown>;
  if (!("workloadSize" in r)) {
    throw new Error(`${path}.workloadSize is required`);
  }
  if (typeof r.workloadSize !== "string" || !ALLOWED_WORKLOAD_SIZES.has(r.workloadSize as WorkloadSize)) {
    throw new Error(`${path}.workloadSize must be one of small, medium, large`);
  }
  if (!("baseline" in r)) {
    throw new Error(`${path}.baseline is required`);
  }
  if (!("candidate" in r)) {
    throw new Error(`${path}.candidate is required`);
  }
  const baseline = validateModelUsageMetrics(r.baseline, `${path}.baseline`);
  const candidate = validateModelUsageMetrics(r.candidate, `${path}.candidate`);
  if (!("baselineCostUsd" in r)) {
    throw new Error(`${path}.baselineCostUsd is required`);
  }
  if (!isFiniteNonNegative(r.baselineCostUsd)) {
    throw new Error(`${path}.baselineCostUsd must be a finite non-negative number`);
  }
  if (!("candidateCostUsd" in r)) {
    throw new Error(`${path}.candidateCostUsd is required`);
  }
  if (!isFiniteNonNegative(r.candidateCostUsd)) {
    throw new Error(`${path}.candidateCostUsd must be a finite non-negative number`);
  }
  if (!("costDeltaPercent" in r)) {
    throw new Error(`${path}.costDeltaPercent is required`);
  }
  if (!isFiniteNumber(r.costDeltaPercent)) {
    throw new Error(`${path}.costDeltaPercent must be a finite number`);
  }
  if (!("correctnessPassed" in r)) {
    throw new Error(`${path}.correctnessPassed is required`);
  }
  if (typeof r.correctnessPassed !== "boolean") {
    throw new Error(`${path}.correctnessPassed must be a boolean`);
  }
  if (!("redundantVerificationCalls" in r)) {
    throw new Error(`${path}.redundantVerificationCalls is required`);
  }
  if (!isFiniteNonNegative(r.redundantVerificationCalls) || !Number.isInteger(r.redundantVerificationCalls as number)) {
    throw new Error(`${path}.redundantVerificationCalls must be a finite non-negative integer`);
  }
  return {
    workloadSize: r.workloadSize as WorkloadSize,
    baseline,
    candidate,
    baselineCostUsd: r.baselineCostUsd as number,
    candidateCostUsd: r.candidateCostUsd as number,
    costDeltaPercent: r.costDeltaPercent as number,
    correctnessPassed: r.correctnessPassed as boolean,
    redundantVerificationCalls: r.redundantVerificationCalls as number,
  };
}

function validateAndSortWorkloadBenchmarks(benchmarks: unknown): WorkloadBenchmarkComparison[] {
  if (!Array.isArray(benchmarks)) {
    throw new Error(`workloadBenchmarks must be an array`);
  }
  const validated = benchmarks.map((row, idx) => validateWorkloadBenchmarkComparison(row, idx));
  const seen = new Set<WorkloadSize>();
  for (const b of validated) {
    if (seen.has(b.workloadSize)) {
      throw new Error(`workloadBenchmarks duplicate workloadSize '${b.workloadSize}'`);
    }
    seen.add(b.workloadSize);
  }
  validated.sort((a, b) => workloadOrderIndex(a.workloadSize) - workloadOrderIndex(b.workloadSize));
  return validated;
}

function normalizeLegacyPath(path: string): string {
  const normalized = path.trim().replace(/\/\.\*$/, "");
  return normalized || "/";
}

/**
 * Replays may receive persisted candidates created before capability manifests became
 * fully materialized. Normalize those legacy/partial manifests conservatively before
 * deriving replay authorization. Missing sections never imply permission.
 */
function normalizeCandidateCapabilities(candidate: CandidateTarget): CandidateTarget {
  if (!("requiredCapabilities" in candidate) || !candidate.requiredCapabilities) {
    return candidate;
  }

  const raw = candidate.requiredCapabilities as unknown as LooseCapabilityManifest;
  const normalized = CapabilityManifestSchema.parse({
    manifestId: raw.manifestId,
    fs: {
      readPaths: (raw.fs?.readPaths ?? []).map(normalizeLegacyPath),
      writePaths: (raw.fs?.writePaths ?? []).map(normalizeLegacyPath),
      allowWorkspaceRoot: raw.fs?.allowWorkspaceRoot ?? false,
      allowTemp: raw.fs?.allowTemp ?? false,
      denyPaths: (raw.fs?.denyPaths ?? []).map(normalizeLegacyPath),
      maxFileSizeBytes: raw.fs?.maxFileSizeBytes ?? 10_485_760,
    },
    net: {
      allowOutbound: raw.net?.allowOutbound ?? false,
      allowedDomains: raw.net?.allowedDomains ?? [],
      allowedHosts: raw.net?.allowedHosts ?? [],
      allowedPorts: raw.net?.allowedPorts ?? [],
      allowedProtocols: raw.net?.allowedProtocols ?? ["https"],
      allowLocalhost: raw.net?.allowLocalhost ?? false,
      denyPrivateRanges: raw.net?.denyPrivateRanges ?? true,
    },
    command: {
      allowShellExecution: raw.command?.allowShellExecution ?? raw.exec?.allowExec ?? false,
      allowedCommands: raw.command?.allowedCommands ?? raw.exec?.allowedCommands ?? [],
      allowedBinaries: raw.command?.allowedBinaries ?? [],
      forbiddenPatterns: raw.command?.forbiddenPatterns ?? [],
      allowEnvPassthrough: raw.command?.allowEnvPassthrough ?? [],
    },
    secrets: {
      allowedSecretNames: raw.secrets?.allowedSecretNames ?? [],
      allowedPrefixes: raw.secrets?.allowedPrefixes ?? [],
      denyDirectRead: raw.secrets?.denyDirectRead ?? true,
      injectAsEnv: raw.secrets?.injectAsEnv ?? true,
    },
    limits: {
      maxConcurrentExecutions: raw.limits?.maxConcurrentExecutions ?? 4,
      maxCpuUsagePercent: raw.limits?.maxCpuUsagePercent ?? 100,
      maxMemoryMb: raw.limits?.maxMemoryMb ?? 128,
      maxExecutionTimeMs: raw.limits?.maxExecutionTimeMs ?? 30_000,
      maxOutputSizeBytes: raw.limits?.maxOutputSizeBytes ?? 1_048_576,
    },
  });

  return {
    ...candidate,
    requiredCapabilities: normalized,
  } as CandidateTarget;
}

/**
 * Replays a candidate tool against historical session evidence.
 */
export class HistoricalReplayService {
  private readonly builder: ReplayScenarioBuilder;
  private readonly runner: HistoricalReplayRunner;
  private readonly evidenceRepo?: EvidenceRepository;
  private readonly defaultTimeoutMs: number;
  private readonly defaultSeed: number | string;

  constructor(options: HistoricalReplayServiceOptions = {}) {
    this.builder = options.builder ?? new ReplayScenarioBuilder();
    this.runner = options.runner ?? new HistoricalReplayRunner();
    this.evidenceRepo =
      options.evidenceRepo ?? (options.dbPool ? new EvidenceRepository(options.dbPool) : undefined);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.defaultSeed = options.defaultSeed ?? 42;
  }

  async replayCandidate(
    tenant: TenantContext,
    options: ReplayCandidateOptions,
  ): Promise<HistoricalReplayResult> {
    let evidenceSource = options.evidence;

    if (!evidenceSource && options.evidenceSetId && this.evidenceRepo) {
      const resolved = await this.evidenceRepo.resolveEvidenceSet(tenant, options.evidenceSetId);
      if (resolved) {
        evidenceSource = resolved;
      }
    }

    if (!evidenceSource) {
      throw new Error(
        "No evidence source provided for historical replay. Supply either 'evidence' or valid 'evidenceSetId'.",
      );
    }

    const replayOpts: HistoricalReplayOptions = {
      seed: this.defaultSeed,
      timeoutMs: this.defaultTimeoutMs,
      ...options.options,
    };

    // Validate and sort external workload benchmarks without fabricating missing values.
    // Fail closed on invalid or duplicate rows before any execution.
    const rawExternal = (replayOpts as unknown as { workloadBenchmarks?: unknown }).workloadBenchmarks;
    if (rawExternal !== undefined) {
      const validated = validateAndSortWorkloadBenchmarks(rawExternal);
      (replayOpts as unknown as { workloadBenchmarks?: WorkloadBenchmarkComparison[] }).workloadBenchmarks = validated;
    }

    const candidate = normalizeCandidateCapabilities(options.candidate);
    const scenarios = this.builder.buildScenarios(evidenceSource, candidate, replayOpts);

    return this.runner.runScenarios(candidate, scenarios, replayOpts);
  }

  buildScenarios(
    evidence: EvidenceSource,
    candidate: CandidateTarget,
    options?: HistoricalReplayOptions,
  ): ReplayScenario[] {
    // Pass through without altering workloadBenchmarks; builder threads workloadSize/baselineModelUsage via scenarios
    return this.builder.buildScenarios(
      evidence,
      normalizeCandidateCapabilities(candidate),
      options,
    );
  }

  async executeSingleScenario(
    candidate: CandidateTarget,
    scenario: ReplayScenario,
    options?: { seed?: number | string; timeoutMs?: number },
  ): Promise<ReplayScenarioExecutionResult> {
    return this.runner.runScenario(normalizeCandidateCapabilities(candidate), scenario, options);
  }
}

export function createHistoricalReplayService(
  options: HistoricalReplayServiceOptions = {},
): HistoricalReplayService {
  return new HistoricalReplayService(options);
}
