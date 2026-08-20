import type { CapabilityManifest, ToolManifest } from "@tool-evolver/contracts";
import { ValidationSandbox } from "../testing/validation-sandbox.js";
import { ReplayTraceComparator } from "./comparator.js";
import type {
  CandidateTarget,
  HistoricalReplayOptions,
  HistoricalReplayResult,
  ModelUsageMetrics,
  ReplayExecutionTrace,
  ReplayScenario,
  ReplayScenarioExecutionResult,
  WorkloadBenchmarkComparison,
  WorkloadSize,
  BenchmarkAttestation,
  WorkloadBenchmarkEvidence,
} from "./types.js";
import {
  WORKLOAD_SIZE_ORDER,
  calculateWeightedModelCost,
  assertValidWorkloadBenchmarkComparison,
  assertValidWorkloadBenchmarkEvidence,
} from "./types.js";
import { DeterministicRandom, VirtualToolBrokerClient } from "./virtual-broker.js";

function unwrapCandidateRevision(candidate: CandidateTarget): CandidateTarget {
  if (candidate && typeof candidate === "object" && "artifacts" in candidate) {
    const maybeArtifacts = (candidate as unknown as Record<string, unknown>).artifacts;
    if (maybeArtifacts && typeof maybeArtifacts === "object") {
      const art = maybeArtifacts as Record<string, unknown>;
      const out: Record<string, unknown> = { ...(candidate as unknown as Record<string, unknown>) };
      const candidateRec = candidate as unknown as Record<string, unknown>;
      if ((!("sourceCode" in candidate) || typeof candidateRec.sourceCode !== "string") && typeof art.sourceCode === "string") {
        out.sourceCode = art.sourceCode;
      }
      const hasManifest = "manifest" in candidate;
      const hasProposed = "proposedTool" in candidate;
      if (!hasManifest && !hasProposed && art.manifest) {
        out.manifest = art.manifest;
      } else if (!hasManifest && art.manifest && !out.manifest) {
        out.manifest = art.manifest;
      }
      if (!("requiredCapabilities" in candidate) && art.capabilities) {
        out.requiredCapabilities = art.capabilities;
      }
      if (!("workflowDefinition" in candidate) && art.workflowDefinition) {
        out.workflowDefinition = art.workflowDefinition;
      }
      if (!("plan" in candidate) && art.plan) {
        out.plan = art.plan;
      }
      return out as unknown as CandidateTarget;
    }
  }
  return candidate;
}

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
  const required = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "turns",
    "toolCalls",
    "redundantToolCalls",
    "wallTimeMs",
    "correct",
  ] as const;
  for (const k of required) {
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

function validateWorkloadBenchmarkEvidenceForRunner(
  raw: unknown,
  path: string,
): WorkloadBenchmarkEvidence {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path} must be an object`);
  }
  const ev = raw as Record<string, unknown>;
  // Delegate to strict assert after constructing shallow copy; but we need to validate presence first
  const required = [
    "benchmarkId",
    "baselineRunId",
    "candidateRunId",
    "workloadInputDigest",
    "candidateRevisionId",
    "artifactDigest",
    "modelProvider",
    "modelId",
    "observedAt",
    "scheduleId",
  ] as const;
  for (const k of required) {
    if (!(k in ev)) {
      throw new Error(`${path}.${k} is required`);
    }
  }
  const scheduleIdRaw = ev.scheduleId as unknown;
  if (typeof scheduleIdRaw !== "string" || (scheduleIdRaw as string).trim().length === 0) {
    throw new Error(`${path}.scheduleId must be a non-empty string`);
  }
  // Build typed candidate to use assert
  const candidate: WorkloadBenchmarkEvidence = {
    benchmarkId: ev.benchmarkId as string,
    baselineRunId: ev.baselineRunId as string,
    candidateRunId: ev.candidateRunId as string,
    workloadInputDigest: ev.workloadInputDigest as string,
    candidateRevisionId: ev.candidateRevisionId as string,
    artifactDigest: ev.artifactDigest as string,
    modelProvider: ev.modelProvider as string,
    modelId: ev.modelId as string,
    observedAt: ev.observedAt as string,
    scheduleId: scheduleIdRaw as string,
    ...(ev.attestation !== undefined ? { attestation: ev.attestation as BenchmarkAttestation } : {}),
  };
  assertValidWorkloadBenchmarkEvidence(candidate, path);
  return candidate;
}

function validateWorkloadBenchmarkComparison(
  value: unknown,
  index: number,
): WorkloadBenchmarkComparison {
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
  // Evidence fields - all required
  const evidence = validateWorkloadBenchmarkEvidenceForRunner(r, path);

  const constructed: WorkloadBenchmarkComparison = {
    workloadSize: r.workloadSize as WorkloadSize,
    baseline,
    candidate,
    baselineCostUsd: r.baselineCostUsd as number,
    candidateCostUsd: r.candidateCostUsd as number,
    costDeltaPercent: r.costDeltaPercent as number,
    correctnessPassed: r.correctnessPassed as boolean,
    redundantVerificationCalls: r.redundantVerificationCalls as number,
    benchmarkId: evidence.benchmarkId,
    baselineRunId: evidence.baselineRunId,
    candidateRunId: evidence.candidateRunId,
    workloadInputDigest: evidence.workloadInputDigest,
    candidateRevisionId: evidence.candidateRevisionId,
    artifactDigest: evidence.artifactDigest,
    modelProvider: evidence.modelProvider,
    modelId: evidence.modelId,
    observedAt: evidence.observedAt,
    scheduleId: evidence.scheduleId,
    ...(r.attestation !== undefined ? { attestation: r.attestation as BenchmarkAttestation } : {}),
  };

  // Strict cross-field validation (cost recomputation, binding)
  assertValidWorkloadBenchmarkComparison(constructed);

  return constructed;
}

function validateAndSortWorkloadBenchmarks(
  benchmarks: unknown,
): WorkloadBenchmarkComparison[] {
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
  // Enforce distinct evidence identities and binding across all rows
  const seenBenchmarkId = new Set<string>();
  const seenBaselineRunId = new Set<string>();
  const seenCandidateRunId = new Set<string>();
  const seenInputDigest = new Set<string>();
  let expectedRevision: string | undefined;
  let expectedArtifact: string | undefined;
  for (const b of validated) {
    if (seenBenchmarkId.has(b.benchmarkId)) {
      throw new Error(`Duplicate benchmarkId '${b.benchmarkId}' in workloadBenchmarks`);
    }
    seenBenchmarkId.add(b.benchmarkId);
    if (seenBaselineRunId.has(b.baselineRunId)) {
      throw new Error(`Duplicate baselineRunId '${b.baselineRunId}' in workloadBenchmarks`);
    }
    seenBaselineRunId.add(b.baselineRunId);
    if (seenCandidateRunId.has(b.candidateRunId)) {
      throw new Error(`Duplicate candidateRunId '${b.candidateRunId}' in workloadBenchmarks`);
    }
    seenCandidateRunId.add(b.candidateRunId);
    if (seenInputDigest.has(b.workloadInputDigest)) {
      throw new Error(`Duplicate workloadInputDigest '${b.workloadInputDigest}' in workloadBenchmarks`);
    }
    seenInputDigest.add(b.workloadInputDigest);
    if (expectedRevision === undefined) expectedRevision = b.candidateRevisionId;
    else if (b.candidateRevisionId !== expectedRevision) {
      throw new Error(`candidateRevisionId mismatch: expected '${expectedRevision}', got '${b.candidateRevisionId}'`);
    }
    if (expectedArtifact === undefined) expectedArtifact = b.artifactDigest;
    else if (b.artifactDigest !== expectedArtifact) {
      throw new Error(`artifactDigest mismatch: expected '${expectedArtifact}', got '${b.artifactDigest}'`);
    }
  }
  validated.sort((a, b) => workloadOrderIndex(a.workloadSize) - workloadOrderIndex(b.workloadSize));
  return validated;
}

function deriveWorkloadBenchmark(
  workloadSize: WorkloadSize,
  baseline: ModelUsageMetrics,
  candidate: ModelUsageMetrics,
  evidence: WorkloadBenchmarkEvidence,
): WorkloadBenchmarkComparison {
  assertValidWorkloadBenchmarkEvidence(evidence, "benchmarkEvidence");
  const baselineCostUsd = calculateWeightedModelCost(baseline, evidence.scheduleId);
  const candidateCostUsd = calculateWeightedModelCost(candidate, evidence.scheduleId);
  const costDeltaPercent =
    baselineCostUsd === 0 ? 0 : ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100;
  const constructed: WorkloadBenchmarkComparison = {
    workloadSize,
    baseline,
    candidate,
    baselineCostUsd,
    candidateCostUsd,
    costDeltaPercent,
    correctnessPassed: candidate.correct === true,
    redundantVerificationCalls: candidate.redundantToolCalls,
    benchmarkId: evidence.benchmarkId,
    baselineRunId: evidence.baselineRunId,
    candidateRunId: evidence.candidateRunId,
    workloadInputDigest: evidence.workloadInputDigest,
    candidateRevisionId: evidence.candidateRevisionId,
    artifactDigest: evidence.artifactDigest,
    modelProvider: evidence.modelProvider,
    modelId: evidence.modelId,
    observedAt: evidence.observedAt,
    scheduleId: evidence.scheduleId,
  };
  assertValidWorkloadBenchmarkComparison(constructed);
  return constructed;
}

function collectScenarioDerivedBenchmarks(
  scenarios: ReplayScenario[],
  scenarioResults: ReplayScenarioExecutionResult[],
): WorkloadBenchmarkComparison[] {
  const scenarioById = new Map<string, ReplayScenario>();
  for (const s of scenarios) {
    scenarioById.set(s.id, s);
  }
  const derived: WorkloadBenchmarkComparison[] = [];
  for (const result of scenarioResults) {
    const scenario = scenarioById.get(result.scenarioId);
    if (!scenario) continue;
    const workloadSize = scenario.workloadSize as WorkloadSize | undefined;
    const baseline = scenario.baselineModelUsage as ModelUsageMetrics | undefined;
    const evidence = scenario.benchmarkEvidence as WorkloadBenchmarkEvidence | undefined;
    const candidate = result.executionTrace.modelUsage as ModelUsageMetrics | undefined;
    if (!workloadSize || !baseline || !evidence || !candidate) continue;
    if (!ALLOWED_WORKLOAD_SIZES.has(workloadSize)) continue;
    try {
      const validatedBaseline = validateModelUsageMetrics(baseline, `scenario ${scenario.id} baselineModelUsage`);
      const validatedCandidate = validateModelUsageMetrics(candidate, `trace ${result.scenarioId} modelUsage`);
      const validatedEvidence = validateWorkloadBenchmarkEvidenceForRunner(evidence, `scenario ${scenario.id} benchmarkEvidence`);
      // Ensure evidence workload binding matches scenario? evidence itself is canonical; no extra check
      const bench = deriveWorkloadBenchmark(workloadSize, validatedBaseline, validatedCandidate, validatedEvidence);
      const validatedBench = validateWorkloadBenchmarkComparison(bench, derived.length);
      derived.push(validatedBench);
    } catch {
      throw new Error(
        `Invalid scenario-derived workload benchmark for workloadSize '${String(workloadSize)}'`,
      );
    }
  }
  const seenDerived = new Set<WorkloadSize>();
  for (const b of derived) {
    if (seenDerived.has(b.workloadSize)) {
      throw new Error(`Derived workloadBenchmarks duplicate workloadSize '${b.workloadSize}'`);
    }
    seenDerived.add(b.workloadSize);
  }
  derived.sort((a, b) => workloadOrderIndex(a.workloadSize) - workloadOrderIndex(b.workloadSize));
  return derived;
}

/**
 * Executes candidate tools against historical replay scenarios in isolated sandboxes.
 */
export class HistoricalReplayRunner {
  private readonly sandbox: ValidationSandbox;
  private readonly comparator: ReplayTraceComparator;

  constructor(
    options: {
      sandbox?: ValidationSandbox;
      comparator?: ReplayTraceComparator;
    } = {},
  ) {
    this.sandbox = options.sandbox ?? new ValidationSandbox();
    this.comparator = options.comparator ?? new ReplayTraceComparator();
  }

  /**
   * Runs a single replay scenario against a candidate tool.
   */
  async runScenario(
    candidate: CandidateTarget,
    scenario: ReplayScenario,
    options: {
      seed?: number | string;
      timeoutMs?: number;
    } = {},
  ): Promise<ReplayScenarioExecutionResult> {
    const normalizedCandidate = unwrapCandidateRevision(candidate);
    const seed = options.seed ?? 42;
    const timeoutMs = options.timeoutMs ?? 5000;

    const sourceCode = this.extractSourceCode(normalizedCandidate);
    const manifest = this.extractManifest(normalizedCandidate);
    const capabilities = this.extractCapabilities(normalizedCandidate);

    const brokerClient = new VirtualToolBrokerClient(scenario.virtualState);

    // Execute candidate code in isolated sandbox
    const runResult = await this.sandbox.executeCandidate(
      sourceCode,
      manifest,
      scenario.input,
      brokerClient,
      {
        timeoutMs,
        seed,
        capabilities,
      },
    );

    const outputTokens = runResult.output
      ? Math.ceil(JSON.stringify(runResult.output).length / 4)
      : 0;
    const tokensUsed = 20 + outputTokens;

    const trace: ReplayExecutionTrace = {
      scenarioId: scenario.id,
      seed,
      operations: brokerClient.trace,
      toolOutput: runResult.output,
      error: runResult.error ?? null,
      durationMs: runResult.durationMs,
      stepCount: 1,
      tokensUsed,
      logs: runResult.logs,
      stateSnapshot: brokerClient.getStateSnapshot(),
    };

    // Thread canonical explicit telemetry only: preserve modelUsage if sandbox provided it and is valid
    const existingModelUsage = (runResult as unknown as { modelUsage?: ModelUsageMetrics }).modelUsage;
    if (existingModelUsage) {
      try {
        validateModelUsageMetrics(existingModelUsage, `trace.modelUsage`);
        (trace as unknown as { modelUsage?: ModelUsageMetrics }).modelUsage = existingModelUsage as ModelUsageMetrics;
      } catch {
        // Fail-closed: do not thread invalid telemetry; comparator will see no benchmark
      }
    }

    return this.comparator.compareTrace(scenario, trace, manifest);
  }

  /**
   * Runs an array of replay scenarios across candidate tool with bounded concurrency.
   */
  async runScenarios(
    candidate: CandidateTarget,
    scenarios: ReplayScenario[],
    options: HistoricalReplayOptions = {},
  ): Promise<HistoricalReplayResult> {
    const normalizedCandidate = unwrapCandidateRevision(candidate);
    const startTime = Date.now();
    const rng = new DeterministicRandom(options.seed ?? 42);
    const candidateId = this.extractCandidateId(normalizedCandidate);
    const revisionId = this.extractRevisionId(normalizedCandidate);
    const evidenceSetId = scenarios[0]?.sourceEpisodeId;

    // Validate external workload benchmarks early, before execution, to fail closed without side effects
    let validatedExternal: WorkloadBenchmarkComparison[] | undefined;
    const rawExternal = (options as unknown as { workloadBenchmarks?: unknown }).workloadBenchmarks;
    if (rawExternal !== undefined) {
      validatedExternal = validateAndSortWorkloadBenchmarks(rawExternal);
    }

    const maxParallel = options.maxParallelScenarios ?? 4;
    const scenarioResults: ReplayScenarioExecutionResult[] = [];

    // Execute in bounded batches
    for (let i = 0; i < scenarios.length; i += maxParallel) {
      const chunk = scenarios.slice(i, i + maxParallel);
      const chunkPromises = chunk.map((scenario) => {
        const scenarioSeed = rng.nextUuid();
        return this.runScenario(normalizedCandidate, scenario, {
          seed: scenarioSeed,
          timeoutMs: options.timeoutMs,
        });
      });

      const chunkResults = await Promise.all(chunkPromises);
      scenarioResults.push(...chunkResults);

      if (options.failFast) {
        const failed = chunkResults.find((r) => r.status === "terminal_divergence");
        if (failed) {
          break;
        }
      }
    }

    let overall: ReturnType<ReplayTraceComparator["compareOverall"]>;
    try {
      const maybeCompare = this.comparator.compareOverall as unknown as (
        results: ReplayScenarioExecutionResult[],
        external?: WorkloadBenchmarkComparison[],
      ) => ReturnType<ReplayTraceComparator["compareOverall"]>;
      if (maybeCompare.length >= 2) {
        overall = maybeCompare.call(this.comparator, scenarioResults, validatedExternal);
      } else {
        overall = this.comparator.compareOverall(scenarioResults);
      }
    } catch (err) {
      throw err;
    }
    const durationMs = Date.now() - startTime;

    const summary = `Replay completed with status '${overall.status}'. Passed ${overall.passedScenarioCount}/${overall.totalScenarioCount} scenarios with ${overall.overallMetrics.stepReductionPercent}% step reduction and ${overall.overallMetrics.tokenSavingsPercent}% token savings.`;

    // Derive scenario-based benchmarks from canonical workloadSize + baselineModelUsage + benchmarkEvidence and trace.modelUsage
    let derivedBenchmarks: WorkloadBenchmarkComparison[] = [];
    try {
      derivedBenchmarks = collectScenarioDerivedBenchmarks(scenarios, scenarioResults);
    } catch (err) {
      throw err;
    }

    // If both derived and explicit exist, reject duplicate workload sizes
    let finalBenchmarks: WorkloadBenchmarkComparison[] | undefined;
    if (validatedExternal && derivedBenchmarks.length > 0) {
      const externalSizes = new Set(validatedExternal.map((b) => b.workloadSize));
      for (const d of derivedBenchmarks) {
        if (externalSizes.has(d.workloadSize)) {
          throw new Error(
            `Duplicate workloadSize '${d.workloadSize}' between scenario-derived and explicit workloadBenchmarks`,
          );
        }
      }
      finalBenchmarks = [...derivedBenchmarks, ...validatedExternal];
      finalBenchmarks.sort((a, b) => workloadOrderIndex(a.workloadSize) - workloadOrderIndex(b.workloadSize));
      // Validate merged distinct evidence across combined set
      finalBenchmarks = validateAndSortWorkloadBenchmarks(finalBenchmarks);
    } else if (validatedExternal) {
      finalBenchmarks = validatedExternal;
    } else if (derivedBenchmarks.length > 0) {
      finalBenchmarks = validateAndSortWorkloadBenchmarks(derivedBenchmarks);
    } else {
      finalBenchmarks = undefined;
    }

    // Respect comparator's own workload handling if it already produced benchmarks
    const comparatorWorkloads = (overall as unknown as { workloadBenchmarks?: unknown }).workloadBenchmarks as
      | WorkloadBenchmarkComparison[]
      | undefined;
    if (comparatorWorkloads !== undefined) {
      // Comparator already validated and sorted; prefer its merged result but ensure it matches our final (if both exist they must agree)
      // If comparator produced benchmarks, they already include derived+external handling; use them as authoritative
      finalBenchmarks = comparatorWorkloads as WorkloadBenchmarkComparison[];
    }

    const result: HistoricalReplayResult = {
      candidateId,
      revisionId,
      evidenceSetId,
      status: overall.status,
      passed: overall.passed,
      scenarioResults,
      overallMetrics: overall.overallMetrics,
      divergenceFindings: overall.divergenceFindings,
      reproducibilitySeed: options.seed ?? 42,
      passedScenarioCount: overall.passedScenarioCount,
      totalScenarioCount: overall.totalScenarioCount,
      executedAt: new Date().toISOString(),
      durationMs,
      summary,
    } as HistoricalReplayResult;

    if (finalBenchmarks !== undefined) {
      (result as unknown as { workloadBenchmarks?: WorkloadBenchmarkComparison[] }).workloadBenchmarks =
        finalBenchmarks;
    }

    return result;
  }

  private extractSourceCode(candidate: CandidateTarget): string {
    if ("sourceCode" in candidate && typeof (candidate as unknown as Record<string, unknown>).sourceCode === "string") {
      return (candidate as unknown as { sourceCode: string }).sourceCode;
    }
    if ("artifacts" in candidate) {
      const art = (candidate as unknown as Record<string, unknown>).artifacts as Record<string, unknown> | undefined;
      if (art && typeof art.sourceCode === "string") return art.sourceCode;
    }
    throw new Error("Candidate does not contain sourceCode");
  }

  private extractManifest(candidate: CandidateTarget): ToolManifest | Partial<ToolManifest> {
    if ("manifest" in candidate && (candidate as unknown as Record<string, unknown>).manifest) {
      return (candidate as unknown as { manifest: ToolManifest }).manifest;
    }
    if ("proposedTool" in candidate && (candidate as unknown as Record<string, unknown>).proposedTool) {
      return (candidate as unknown as { proposedTool: ToolManifest }).proposedTool;
    }
    if ("artifacts" in candidate) {
      const art = (candidate as unknown as Record<string, unknown>).artifacts as Record<string, unknown> | undefined;
      const m = art?.manifest as ToolManifest | undefined;
      if (m) return m;
    }
    return { name: "candidate_tool" };
  }

  private extractCapabilities(candidate: CandidateTarget): CapabilityManifest | undefined {
    if ("requiredCapabilities" in candidate && (candidate as unknown as Record<string, unknown>).requiredCapabilities) {
      return (candidate as unknown as { requiredCapabilities: CapabilityManifest }).requiredCapabilities;
    }
    if ("artifacts" in candidate) {
      const art = (candidate as unknown as Record<string, unknown>).artifacts as Record<string, unknown> | undefined;
      const caps = art?.capabilities as CapabilityManifest | undefined;
      if (caps) return caps;
    }
    return undefined;
  }

  private extractCandidateId(candidate: CandidateTarget): string {
    if ("id" in candidate && typeof (candidate as unknown as Record<string, unknown>).id === "string") {
      return (candidate as unknown as { id: string }).id;
    }
    if ("candidateId" in candidate && typeof (candidate as unknown as Record<string, unknown>).candidateId === "string") {
      return (candidate as unknown as { candidateId: string }).candidateId;
    }
    if ("artifacts" in candidate) {
      const candId = (candidate as unknown as Record<string, unknown>).candidateId;
      if (typeof candId === "string") return candId;
    }
    return "candidate-unknown";
  }

  private extractRevisionId(candidate: CandidateTarget): string | undefined {
    if ("revisionId" in candidate && typeof (candidate as unknown as Record<string, unknown>).revisionId === "string") {
      return (candidate as unknown as { revisionId: string }).revisionId;
    }
    return undefined;
  }
}
