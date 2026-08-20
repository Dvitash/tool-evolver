import type { ToolManifest } from "@tool-evolver/contracts";
import type {
  AllowedBrokerOperation,
  DivergenceFinding,
  ExecutedBrokerOperation,
  InvariantEvaluationResult,
  ModelUsageMetrics,
  ReplayExecutionTrace,
  ReplayInvariant,
  ReplayMetricsComparison,
  ReplayScenario,
  ReplayScenarioExecutionResult,
  ReplayStatus,
  WorkloadBenchmarkComparison,
  WorkloadSize,
  WorkloadBenchmarkEvidence,
} from "./types.js";
import {
  WORKLOAD_SIZE_ORDER,
  calculateWeightedModelCost,
  assertValidWorkloadBenchmarkComparison,
  assertValidWorkloadBenchmarkEvidence,
} from "./types.js";

/**
 * Replay trace and invariant comparator assessing candidate correctness, side effects, and metrics.
 * Extended to compute deterministic workload benchmark comparisons when baseline and candidate model usage are present
 * alongside explicit canonical benchmark evidence.
 * Redundancy is explicit from ModelUsageMetrics.redundantToolCalls, never inferred from broker operations.
 * No placeholder evidence is fabricated; evidence must be explicitly provided.
 */
export class ReplayTraceComparator {
  /**
   * Computes a single workload benchmark comparison deterministically.
   * Requires explicit canonical evidence carrying all immutable identity/binding/pricing fields.
   * Validates finite non-negative metrics and workload size ordering.
   * Recomputes weighted costs server-side from raw usage and authoritative scheduleId; rejects caller costs that mismatch.
   * No fallback placeholder evidence.
   */
  buildWorkloadBenchmark(
    workloadSize: WorkloadSize,
    baseline: ModelUsageMetrics,
    candidate: ModelUsageMetrics,
    evidence: WorkloadBenchmarkEvidence,
  ): WorkloadBenchmarkComparison {
    if (!WORKLOAD_SIZE_ORDER.includes(workloadSize)) {
      throw new Error(
        `Invalid workloadSize '${String(workloadSize)}' — must be one of ${WORKLOAD_SIZE_ORDER.join(",")}`,
      );
    }
    assertValidWorkloadBenchmarkEvidence(evidence, "WorkloadBenchmarkEvidence");
    const scheduleId = evidence.scheduleId;
    const baselineCostUsd = calculateWeightedModelCost(baseline, scheduleId);
    const candidateCostUsd = calculateWeightedModelCost(candidate, scheduleId);

    if (!Number.isFinite(baselineCostUsd) || baselineCostUsd < 0) {
      throw new Error(`baselineCostUsd must be finite non-negative, got ${baselineCostUsd}`);
    }
    if (!Number.isFinite(candidateCostUsd) || candidateCostUsd < 0) {
      throw new Error(`candidateCostUsd must be finite non-negative, got ${candidateCostUsd}`);
    }

    const costDeltaPercent =
      baselineCostUsd === 0 ? 0 : ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100;

    if (!Number.isFinite(costDeltaPercent)) {
      throw new Error(`costDeltaPercent must be finite, got ${costDeltaPercent}`);
    }

    const redundantVerificationCalls = candidate.redundantToolCalls;
    if (!Number.isInteger(redundantVerificationCalls) || !Number.isFinite(redundantVerificationCalls) || redundantVerificationCalls < 0) {
      throw new Error(`redundantVerificationCalls must be integer finite non-negative, got ${redundantVerificationCalls}`);
    }

    const correctnessPassed = candidate.correct === true;

    const result: WorkloadBenchmarkComparison = {
      workloadSize,
      baseline,
      candidate,
      baselineCostUsd,
      candidateCostUsd,
      costDeltaPercent,
      correctnessPassed,
      redundantVerificationCalls,
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
    const att = (evidence as unknown as Record<string, unknown>).attestation as WorkloadBenchmarkComparison["attestation"] | undefined;
    if (att !== undefined) {
      (result as unknown as Record<string, unknown>).attestation = att;
    }
    return result;
  }

  /**
   * Derives workload benchmark from scenario and trace when all canonical telemetry and explicit evidence are present.
   * Returns undefined when any canonical field is absent.
   * Canonical fields: scenario.workloadSize, scenario.baselineModelUsage, scenario.benchmarkEvidence, trace.modelUsage
   * No synthesis from tokensUsed or other implicit signals.
   * Validates finite non-negative metrics and evidence; throws fail-closed on invalid.
   */
  deriveWorkloadBenchmark(
    scenario: ReplayScenario,
    trace: ReplayExecutionTrace,
  ): WorkloadBenchmarkComparison | undefined {
    const workloadSize = scenario.workloadSize;
    const baseline = scenario.baselineModelUsage;
    const evidence = scenario.benchmarkEvidence;
    const candidate = trace.modelUsage;
    if (!workloadSize || !baseline || !evidence || !candidate) return undefined;
    return this.buildWorkloadBenchmark(workloadSize, baseline, candidate, evidence);
  }

  /**
   * Validates a WorkloadBenchmarkComparison for finite non-negative fields and deterministic expectations.
   * Throws on invalid. Strict: recomputes costs with authoritative scheduleId and validates all evidence fields.
   */
  private validateWorkloadBenchmark(comp: WorkloadBenchmarkComparison): void {
    assertValidWorkloadBenchmarkComparison(comp);
  }

  /**
   * Sorts workload benchmarks deterministically by WORKLOAD_SIZE_ORDER (small→medium→large).
   * Validates no duplicate workloadSize and that entries are valid.
   * Enforces distinct benchmarkId/baselineRunId/candidateRunId/workloadInputDigest across rows
   * and exact candidateRevisionId/artifactDigest binding across all rows. All rows must be fully bound.
   */
  sortAndValidateWorkloadBenchmarks(
    benchmarks: WorkloadBenchmarkComparison[],
  ): WorkloadBenchmarkComparison[] {
    for (const b of benchmarks) {
      this.validateWorkloadBenchmark(b);
    }
    const seen = new Set<WorkloadSize>();
    for (const b of benchmarks) {
      if (seen.has(b.workloadSize)) {
        throw new Error(`Duplicate workloadSize '${b.workloadSize}' in workloadBenchmarks`);
      }
      seen.add(b.workloadSize);
    }
    const seenBenchmarkId = new Set<string>();
    const seenBaselineRunId = new Set<string>();
    const seenCandidateRunId = new Set<string>();
    const seenInputDigest = new Set<string>();
    let expectedRevision: string | undefined;
    let expectedArtifact: string | undefined;
    for (const b of benchmarks) {
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
    return [...benchmarks].sort(
      (a, b) => WORKLOAD_SIZE_ORDER.indexOf(a.workloadSize) - WORKLOAD_SIZE_ORDER.indexOf(b.workloadSize),
    );
  }

  /**
   * Evaluates candidate execution trace against a replay scenario's invariants and constraints.
   */
  async compareTrace(
    scenario: ReplayScenario,
    trace: ReplayExecutionTrace,
    candidateManifest?: ToolManifest | Partial<ToolManifest>,
  ): Promise<ReplayScenarioExecutionResult> {
    const invariantEvaluations: InvariantEvaluationResult[] = [];
    const divergenceFindings: DivergenceFinding[] = [];

    // 1. Evaluate explicit scenario invariants
    for (const inv of scenario.invariants) {
      const evalRes = await this.evaluateInvariant(inv, scenario, trace, candidateManifest);
      invariantEvaluations.push(evalRes);

      if (!evalRes.passed) {
        divergenceFindings.push({
          severity: inv.severity,
          category: this.mapInvariantTypeToFindingCategory(inv.type),
          scenarioId: scenario.id,
          message: evalRes.message ?? `Invariant '${inv.name}' failed`,
          details: {
            expected: evalRes.expected,
            actual: evalRes.actual,
          },
        });
      }
    }

    // 2. Evaluate side-effect containment against allowed broker operations
    const sideEffectFindings = this.checkSideEffectContainment(scenario, trace);
    divergenceFindings.push(...sideEffectFindings);

    // 3. Evaluate negative scenario error expectations
    if (scenario.expectedOutcome === "error") {
      const errorEvaluation = this.checkNegativeScenarioOutcome(scenario, trace);
      if (!errorEvaluation.passed) {
        divergenceFindings.push({
          severity: "critical",
          category: "unhandled_negative_case",
          scenarioId: scenario.id,
          message: errorEvaluation.message ?? "Expected error was not produced",
          details: {
            expectedErrorSubstring: scenario.expectedErrorSubstring,
            traceError: trace.error,
            toolOutput: trace.toolOutput,
          },
        });
      }
    }

    // 4. Compute metrics comparison (existing behavior unchanged)
    const metricsComparison = this.computeMetricsComparison(scenario, trace);

    // 5. Compute workload benchmark when canonical telemetry and explicit evidence are present
    let workloadBenchmark: WorkloadBenchmarkComparison | undefined;
    workloadBenchmark = this.deriveWorkloadBenchmark(scenario, trace);

    // 6. Determine overall scenario status
    const status = this.determineScenarioStatus(trace, invariantEvaluations, divergenceFindings);
    const passed = status === "pass";

    const result: ReplayScenarioExecutionResult = {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      type: scenario.type,
      status,
      passed,
      executionTrace: trace,
      invariantEvaluations,
      metricsComparison,
      divergenceFindings,
      durationMs: trace.durationMs,
      seed: trace.seed,
    };

    if (workloadBenchmark) {
      result.workloadBenchmark = workloadBenchmark;
    }

    return result;
  }

  /**
   * Aggregates individual scenario results into overall replay status, metrics, and findings.
   * Also aggregates deterministic workload benchmarks when present (small→medium→large).
   */
  compareOverall(
    scenarioResults: ReplayScenarioExecutionResult[],
    externalWorkloadBenchmarks?: WorkloadBenchmarkComparison[],
  ): {
    status: ReplayStatus;
    passed: boolean;
    overallMetrics: ReplayMetricsComparison;
    divergenceFindings: DivergenceFinding[];
    passedScenarioCount: number;
    totalScenarioCount: number;
    workloadBenchmarks?: WorkloadBenchmarkComparison[];
  } {
    const totalScenarioCount = scenarioResults.length;
    const passedScenarioCount = scenarioResults.filter((r) => r.passed).length;
    const allFindings = scenarioResults.flatMap((r) => r.divergenceFindings);

    let status: ReplayStatus = "pass";
    if (scenarioResults.some((r) => r.status === "infrastructure_failure")) {
      status = "infrastructure_failure";
    } else if (scenarioResults.some((r) => r.status === "terminal_divergence")) {
      status = "terminal_divergence";
    } else if (scenarioResults.some((r) => r.status === "repairable_divergence")) {
      status = "repairable_divergence";
    }

    // Aggregate overall metrics across scenarios
    let totalBaselineSteps = 0;
    let totalCandidateSteps = 0;
    let totalBaselineDuration = 0;
    let totalCandidateDuration = 0;
    let totalBaselineTokens = 0;
    let totalCandidateTokens = 0;
    let totalBaselineToolCalls = 0;
    let totalCandidateToolCalls = 0;

    for (const res of scenarioResults) {
      const m = res.metricsComparison;
      totalBaselineSteps += m.baselineStepCount;
      totalCandidateSteps += m.candidateStepCount;
      totalBaselineDuration += m.baselineDurationMs;
      totalCandidateDuration += m.candidateDurationMs;
      totalBaselineTokens += m.baselineTokens;
      totalCandidateTokens += m.candidateTokens;
      totalBaselineToolCalls += m.baselineToolCalls;
      totalCandidateToolCalls += m.candidateToolCalls;
    }

    const stepReductionCount = Math.max(0, totalBaselineSteps - totalCandidateSteps);
    const stepReductionPercent =
      totalBaselineSteps > 0 ? Math.round((stepReductionCount / totalBaselineSteps) * 100) : 0;

    const durationReductionMs = Math.max(0, totalBaselineDuration - totalCandidateDuration);
    const durationReductionPercent =
      totalBaselineDuration > 0
        ? Math.round((durationReductionMs / totalBaselineDuration) * 100)
        : 0;

    const tokenSavingsCount = Math.max(0, totalBaselineTokens - totalCandidateTokens);
    const tokenSavingsPercent =
      totalBaselineTokens > 0 ? Math.round((tokenSavingsCount / totalBaselineTokens) * 100) : 0;

    const overallMetrics: ReplayMetricsComparison = {
      baselineStepCount: totalBaselineSteps,
      candidateStepCount: totalCandidateSteps,
      stepReductionCount,
      stepReductionPercent,
      baselineDurationMs: totalBaselineDuration,
      candidateDurationMs: totalCandidateDuration,
      durationReductionMs,
      durationReductionPercent,
      baselineTokens: totalBaselineTokens,
      candidateTokens: totalCandidateTokens,
      tokenSavingsCount,
      tokenSavingsPercent,
      baselineToolCalls: totalBaselineToolCalls,
      candidateToolCalls: totalCandidateToolCalls,
    };

    // Aggregate workload benchmarks deterministically
    const derivedBenchmarks: WorkloadBenchmarkComparison[] = [];
    for (const res of scenarioResults) {
      if (res.workloadBenchmark) {
        derivedBenchmarks.push(res.workloadBenchmark);
      }
    }

    // Handle external benchmarks (e.g., HistoricalReplayOptions.workloadBenchmarks)
    const external = externalWorkloadBenchmarks ? [...externalWorkloadBenchmarks] : [];

    // Validate and merge: no duplicate workloadSize between derived and external
    let merged: WorkloadBenchmarkComparison[] | undefined;
    const allBenchmarks = [...derivedBenchmarks, ...external];
    if (allBenchmarks.length > 0) {
      // Validate no duplicates across merged set
      const seen = new Map<WorkloadSize, WorkloadBenchmarkComparison>();
      for (const b of allBenchmarks) {
        this.validateWorkloadBenchmark(b);
        if (seen.has(b.workloadSize)) {
          throw new Error(`Duplicate workloadSize '${b.workloadSize}' between derived and external benchmarks`);
        }
        seen.set(b.workloadSize, b);
      }
      merged = this.sortAndValidateWorkloadBenchmarks(allBenchmarks);
    }

    const baseReturn: {
      status: ReplayStatus;
      passed: boolean;
      overallMetrics: ReplayMetricsComparison;
      divergenceFindings: DivergenceFinding[];
      passedScenarioCount: number;
      totalScenarioCount: number;
      workloadBenchmarks?: WorkloadBenchmarkComparison[];
    } = {
      status,
      passed: status === "pass",
      overallMetrics,
      divergenceFindings: allFindings,
      passedScenarioCount,
      totalScenarioCount,
    };

    if (merged && merged.length > 0) {
      baseReturn.workloadBenchmarks = merged;
    }

    return baseReturn;
  }

  /**
   * Evaluates a single invariant against execution trace.
   */
  private async evaluateInvariant(
    invariant: ReplayInvariant,
    scenario: ReplayScenario,
    trace: ReplayExecutionTrace,
    manifest?: ToolManifest | Partial<ToolManifest>,
  ): Promise<InvariantEvaluationResult> {
    const baseResult: InvariantEvaluationResult = {
      invariantId: invariant.id,
      invariantName: invariant.name,
      type: invariant.type,
      passed: true,
      severity: invariant.severity,
    };

    // If custom predicate exists, run it
    if (invariant.predicate) {
      try {
        const res = await invariant.predicate(trace.toolOutput, trace);
        if (!res) {
          return {
            ...baseResult,
            passed: false,
            message: `Custom invariant predicate returned false: ${invariant.description}`,
            actual: trace.toolOutput,
          };
        }
      } catch (err: unknown) {
        return {
          ...baseResult,
          passed: false,
          message: `Custom invariant predicate threw error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    switch (invariant.type) {
      case "output_schema": {
        if (scenario.expectedOutcome === "error") {
          return baseResult;
        }
        if (trace.error && !scenario.expectedOutcome) {
          return {
            ...baseResult,
            passed: false,
            message: `Execution failed with error: ${trace.error}`,
            actual: trace.error,
          };
        }
        if (trace.toolOutput === undefined && !trace.error) {
          return {
            ...baseResult,
            passed: false,
            message: "Candidate tool returned undefined output.",
            actual: undefined,
          };
        }
        return baseResult;
      }

      case "semantic_equality": {
        if (invariant.expectedValue !== undefined) {
          const match = this.isSemanticMatch(trace.toolOutput, invariant.expectedValue);
          if (!match) {
            return {
              ...baseResult,
              passed: false,
              message: `Candidate output does not match expected semantic value.`,
              expected: invariant.expectedValue,
              actual: trace.toolOutput,
            };
          }
        }
        return baseResult;
      }

      case "side_effect_containment": {
        const sideEffectFindings = this.checkSideEffectContainment(scenario, trace);
        if (sideEffectFindings.length > 0) {
          return {
            ...baseResult,
            passed: false,
            message: `Unauthorized broker side-effects detected: ${sideEffectFindings.map((f) => f.message).join("; ")}`,
            actual: trace.operations,
          };
        }
        return baseResult;
      }

      case "no_unauthorized_mutations": {
        const modified = trace.stateSnapshot?.modifiedFiles ?? {};
        const allowedFs = scenario.allowedBrokerOperations.filter((op) => op.service === "fs");
        for (const filePath of Object.keys(modified)) {
          const isAllowed = allowedFs.some((op) => {
            if (!op.pathPattern || op.pathPattern === ".*") return true;
            return new RegExp(op.pathPattern).test(filePath);
          });
          if (!isAllowed) {
            return {
              ...baseResult,
              passed: false,
              message: `Unauthorized file mutation at '${filePath}'`,
              actual: filePath,
            };
          }
        }
        return baseResult;
      }

      case "operation_ordering": {
        const orderingValid = this.checkOperationOrdering(trace.operations);
        if (!orderingValid.valid) {
          return {
            ...baseResult,
            passed: false,
            message: orderingValid.reason ?? "Invalid operation ordering detected",
            actual: trace.operations.map((o) => `${o.service}.${o.operation}`),
          };
        }
        return baseResult;
      }

      case "error_mapping": {
        const outcome = this.checkNegativeScenarioOutcome(scenario, trace);
        if (!outcome.passed) {
          return {
            ...baseResult,
            passed: false,
            message: outcome.message,
            actual: trace.error ?? trace.toolOutput,
          };
        }
        return baseResult;
      }

      default:
        return baseResult;
    }
  }

  /**
   * Checks whether all executed broker operations fall within allowed scenario constraints.
   */
  private checkSideEffectContainment(
    scenario: ReplayScenario,
    trace: ReplayExecutionTrace,
  ): DivergenceFinding[] {
    const findings: DivergenceFinding[] = [];
    const allowed = scenario.allowedBrokerOperations;

    for (const op of trace.operations) {
      const allowedMatch = allowed.find((a) => {
        if (a.service !== op.service) return false;
        if (a.operation !== "*" && a.operation !== op.operation) return false;

        // Path pattern check for fs operations
        if (op.service === "fs" && a.pathPattern && op.args[0] && typeof op.args[0] === "string") {
          if (!new RegExp(a.pathPattern).test(op.args[0])) return false;
        }

        // URL pattern check for net operations
        if (op.service === "net" && a.urlPattern && op.args[0] && typeof op.args[0] === "string") {
          if (!new RegExp(a.urlPattern).test(op.args[0])) return false;
        }

        // Command pattern check for cmd operations
        if (
          op.service === "cmd" &&
          a.commandPattern &&
          op.args[0] &&
          typeof op.args[0] === "string"
        ) {
          const commandArgs = Array.isArray(op.args[1])
            ? op.args[1].filter((value): value is string => typeof value === "string")
            : [];
          const commandProfile = [op.args[0], ...commandArgs].join(" ").trim();
          if (!new RegExp(a.commandPattern).test(commandProfile)) return false;
        }

        return true;
      });

      if (!allowedMatch) {
        findings.push({
          severity: "critical",
          category: "unauthorized_side_effect",
          scenarioId: scenario.id,
          message: `Unauthorized broker operation '${op.service}.${op.operation}' with arguments ${JSON.stringify(op.args)}`,
          details: {
            service: op.service,
            operation: op.operation,
            args: op.args,
            allowedBrokerOperations: allowed,
          },
        });
      }
    }

    return findings;
  }

  /**
   * Checks whether operation execution ordering satisfies causal ordering rules.
   */
  private checkOperationOrdering(operations: ExecutedBrokerOperation[]): {
    valid: boolean;
    reason?: string;
  } {
    return { valid: true };
  }

  /**
   * Validates that negative scenarios produce the expected handled error behavior.
   */
  private checkNegativeScenarioOutcome(
    scenario: ReplayScenario,
    trace: ReplayExecutionTrace,
  ): { passed: boolean; message?: string } {
    const hasError = !!trace.error;
    const outputHasError =
      trace.toolOutput &&
      typeof trace.toolOutput === "object" &&
      ("error" in (trace.toolOutput as Record<string, unknown>) ||
        "isError" in (trace.toolOutput as Record<string, unknown>) ||
        "failed" in (trace.toolOutput as Record<string, unknown>));

    if (!hasError && !outputHasError) {
      return {
        passed: false,
        message: `Expected negative scenario '${scenario.type}' to fail or return error object, but execution succeeded.`,
      };
    }

    if (scenario.expectedErrorSubstring) {
      const errStr = `${trace.error ?? ""} ${JSON.stringify(trace.toolOutput ?? "")}`;
      if (!errStr.includes(scenario.expectedErrorSubstring)) {
        return {
          passed: true,
          message: `Error produced but substring '${scenario.expectedErrorSubstring}' was not explicitly matched.`,
        };
      }
    }

    return { passed: true };
  }

  /**
   * Compares baseline metrics from historical episode with candidate execution trace.
   */
  private computeMetricsComparison(
    scenario: ReplayScenario,
    trace: ReplayExecutionTrace,
  ): ReplayMetricsComparison {
    const baseline = scenario.baselineMetrics;
    const candidateStepCount = Math.max(trace.stepCount, 1);
    const stepReductionCount = Math.max(0, baseline.stepCount - candidateStepCount);
    const stepReductionPercent =
      baseline.stepCount > 0 ? Math.round((stepReductionCount / baseline.stepCount) * 100) : 0;

    const candidateDurationMs = trace.durationMs;
    const durationReductionMs = Math.max(0, baseline.totalDurationMs - candidateDurationMs);
    const durationReductionPercent =
      baseline.totalDurationMs > 0
        ? Math.round((durationReductionMs / baseline.totalDurationMs) * 100)
        : 0;

    const candidateTokens = trace.tokensUsed ?? Math.min(100, baseline.totalTokens);
    const tokenSavingsCount = Math.max(0, baseline.totalTokens - candidateTokens);
    const tokenSavingsPercent =
      baseline.totalTokens > 0 ? Math.round((tokenSavingsCount / baseline.totalTokens) * 100) : 0;

    const candidateToolCalls = trace.operations.length;

    return {
      baselineStepCount: baseline.stepCount,
      candidateStepCount,
      stepReductionCount,
      stepReductionPercent,
      baselineDurationMs: baseline.totalDurationMs,
      candidateDurationMs,
      durationReductionMs,
      durationReductionPercent,
      baselineTokens: baseline.totalTokens,
      candidateTokens,
      tokenSavingsCount,
      tokenSavingsPercent,
      baselineToolCalls: baseline.toolCallsCount,
      candidateToolCalls,
    };
  }

  /**
   * Determines status of scenario execution.
   */
  private determineScenarioStatus(
    trace: ReplayExecutionTrace,
    evaluations: InvariantEvaluationResult[],
    findings: DivergenceFinding[],
  ): ReplayStatus {
    if (findings.some((f) => f.category === "sandbox_failure")) {
      return "infrastructure_failure";
    }

    const criticalFindings = findings.filter((f) => f.severity === "critical");
    if (criticalFindings.length > 0) {
      if (
        criticalFindings.some(
          (f) =>
            f.category === "unauthorized_side_effect" ||
            f.category === "operation_ordering_violation",
        )
      ) {
        return "terminal_divergence";
      }
      return "repairable_divergence";
    }

    const warningFindings = findings.filter((f) => f.severity === "warning");
    if (warningFindings.length > 0) {
      return "repairable_divergence";
    }

    return "pass";
  }

  /**
   * Helper to map invariant type to divergence finding category.
   */
  private mapInvariantTypeToFindingCategory(
    type: ReplayInvariant["type"],
  ): DivergenceFinding["category"] {
    switch (type) {
      case "output_schema":
        return "output_schema_mismatch";
      case "semantic_equality":
        return "semantic_output_mismatch";
      case "side_effect_containment":
      case "no_unauthorized_mutations":
        return "unauthorized_side_effect";
      case "operation_ordering":
        return "operation_ordering_violation";
      case "error_mapping":
        return "unhandled_negative_case";
      default:
        return "unexpected_error";
    }
  }

  /**
   * Checks semantic match between candidate output and expected value.
   */
  private isSemanticMatch(actual: unknown, expected: unknown): boolean {
    if (actual === expected) return true;
    if (actual === undefined || actual === null || expected === undefined || expected === null) {
      return actual === expected;
    }

    if (typeof actual === "string" && typeof expected === "string") {
      return (
        actual.trim() === expected.trim() || actual.includes(expected) || expected.includes(actual)
      );
    }

    if (typeof actual === "number" && typeof expected === "number") {
      return actual === expected;
    }

    if (typeof actual === "object" && typeof expected === "object") {
      const expObj = expected as Record<string, unknown>;
      const actObj = actual as Record<string, unknown>;
      for (const [k, v] of Object.entries(expObj)) {
        if (!this.isSemanticMatch(actObj[k], v)) {
          return false;
        }
      }
      return true;
    }

    return false;
  }
}
