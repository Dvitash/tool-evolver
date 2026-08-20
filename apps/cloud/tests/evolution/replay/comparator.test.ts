import { describe, expect, it } from "vitest";
import { ReplayTraceComparator } from "../../../src/evolution/replay/comparator.js";
import {
  calculateWeightedModelCost,
  MODEL_COST_SCHEDULE_V1,
  MODEL_COST_SCHEDULE_ID_V1,
  MODEL_COST_SCHEDULES,
} from "../../../src/evolution/replay/types.js";
import type {
  ModelUsageMetrics,
  ReplayExecutionTrace,
  ReplayScenario,
  ReplayScenarioExecutionResult,
  WorkloadBenchmarkComparison,
  WorkloadSize,
  WorkloadBenchmarkEvidence,
} from "../../../src/evolution/replay/types.js";

describe("ReplayTraceComparator", () => {
  const comparator = new ReplayTraceComparator();

  const baseScenario: ReplayScenario = {
    id: "sc-01",
    name: "Search Content Scenario",
    description: "Tests file search",
    type: "observed_episode",
    evidenceEventIds: ["ev-01"],
    input: { filePath: "/workspace/src/index.ts", query: "export" },
    virtualState: {},
    invariants: [
      {
        id: "inv-01",
        name: "Output Schema",
        type: "output_schema",
        description: "Output must conform to schema",
        severity: "critical",
      },
      {
        id: "inv-02",
        name: "Semantic Equality",
        type: "semantic_equality",
        description: "Matches expected count",
        severity: "warning",
        expectedValue: { matchCount: 2 },
      },
      {
        id: "inv-03",
        name: "Side Effects",
        type: "side_effect_containment",
        description: "Contains side effects",
        severity: "critical",
      },
    ],
    allowedBrokerOperations: [
      {
        service: "fs",
        operation: "*",
        pathPattern: "/workspace/.*",
      },
    ],
    baselineMetrics: {
      stepCount: 5,
      totalTokens: 500,
      totalDurationMs: 1500,
      toolCallsCount: 4,
      estimatedCostUsd: 0.0015,
    },
    expectedOutcome: "success",
  };

  function makeEvidence(size: WorkloadSize, overrides: Partial<WorkloadBenchmarkEvidence> = {}): WorkloadBenchmarkEvidence {
    const digest = size === "small" ? "a".repeat(64) : size === "medium" ? "b".repeat(64) : "c".repeat(64);
    return {
      benchmarkId: `bench-${size}`,
      baselineRunId: `baseline-${size}`,
      candidateRunId: `candidate-${size}`,
      workloadInputDigest: digest,
      candidateRevisionId: "rev_valid_01",
      artifactDigest: "d".repeat(64),
      modelProvider: "test-provider",
      modelId: "test-model",
      observedAt: "2026-08-20T12:00:00.000Z",
      scheduleId: MODEL_COST_SCHEDULE_ID_V1,
      ...overrides,
    };
  }

  describe("Invariant Satisfaction & Metrics Calculation", () => {
    it("returns pass when candidate satisfies all invariants within boundaries", async () => {
      const trace: ReplayExecutionTrace = {
        scenarioId: "sc-01",
        seed: 42,
        operations: [
          {
            service: "fs",
            operation: "readFile",
            args: ["/workspace/src/index.ts", "utf-8"],
            result: "export const a = 1;\nexport const b = 2;\n",
            timestamp: Date.now(),
            durationMs: 10,
          },
        ],
        toolOutput: {
          matchCount: 2,
          totalLines: 2,
          matches: ["export const a = 1;", "export const b = 2;"],
        },
        error: null,
        durationMs: 50,
        stepCount: 1,
        tokensUsed: 120,
        logs: [],
        stateSnapshot: {
          modifiedFiles: {},
          networkRequests: [],
          executedCommands: [],
        },
      };

      const result = await comparator.compareTrace(baseScenario, trace);

      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
      expect(result.divergenceFindings.length).toBe(0);

      // Verify metrics comparison
      expect(result.metricsComparison.stepReductionCount).toBe(4);
      expect(result.metricsComparison.stepReductionPercent).toBe(80);
      expect(result.metricsComparison.durationReductionMs).toBe(1450);
      expect(result.metricsComparison.tokenSavingsCount).toBe(380);
    });
  });

  describe("Unauthorized Side-Effect Detection", () => {
    it("detects unauthorized broker operations outside allowed constraints", async () => {
      const trace: ReplayExecutionTrace = {
        scenarioId: "sc-01",
        seed: 42,
        operations: [
          {
            service: "fs",
            operation: "readFile",
            args: ["/etc/shadow", "utf-8"], // Outside /workspace/.*
            timestamp: Date.now(),
            durationMs: 5,
          },
        ],
        toolOutput: { matchCount: 0 },
        error: null,
        durationMs: 20,
        stepCount: 1,
        logs: [],
      };

      const result = await comparator.compareTrace(baseScenario, trace);

      expect(result.status).toBe("terminal_divergence");
      expect(result.passed).toBe(false);
      expect(result.divergenceFindings.some((f) => f.category === "unauthorized_side_effect")).toBe(
        true,
      );
    });

    it("detects unauthorized file mutations in state snapshot", async () => {
      const scenarioWithMutationInv: ReplayScenario = {
        ...baseScenario,
        invariants: [
          {
            id: "inv-mut",
            name: "No Unauth Mutations",
            type: "no_unauthorized_mutations",
            description: "No writes outside workspace",
            severity: "critical",
          },
        ],
      };

      const trace: ReplayExecutionTrace = {
        scenarioId: "sc-01",
        seed: 42,
        operations: [],
        toolOutput: {},
        error: null,
        durationMs: 10,
        stepCount: 1,
        logs: [],
        stateSnapshot: {
          modifiedFiles: {
            "/etc/hosts": "127.0.0.1 evil.com",
          },
        },
      };

      const result = await comparator.compareTrace(scenarioWithMutationInv, trace);
      expect(result.status).toBe("terminal_divergence");
      expect(result.divergenceFindings.some((f) => f.message.includes("/etc/hosts"))).toBe(true);
    });
  });

  describe("Negative Scenario Error Handling", () => {
    it("validates handled errors in negative scenarios", async () => {
      const negScenario: ReplayScenario = {
        ...baseScenario,
        id: "sc-neg-01",
        type: "negative_missing_file",
        expectedOutcome: "error",
        expectedErrorSubstring: "ENOENT",
        invariants: [
          {
            id: "inv-err",
            name: "Error Invariant",
            type: "error_mapping",
            description: "Must handle error",
            severity: "critical",
          },
        ],
      };

      const traceSuccess: ReplayExecutionTrace = {
        scenarioId: "sc-neg-01",
        seed: 42,
        operations: [],
        toolOutput: { error: "ENOENT: file not found" },
        error: "ENOENT: file not found",
        durationMs: 15,
        stepCount: 1,
        logs: [],
      };

      const resSuccess = await comparator.compareTrace(negScenario, traceSuccess);
      expect(resSuccess.status).toBe("pass");

      // Failing negative scenario: succeeded when error was expected
      const traceFailing: ReplayExecutionTrace = {
        scenarioId: "sc-neg-01",
        seed: 42,
        operations: [],
        toolOutput: { data: "unexpected success" },
        error: null,
        durationMs: 15,
        stepCount: 1,
        logs: [],
      };

      const resFailing = await comparator.compareTrace(negScenario, traceFailing);
      expect(resFailing.status).toBe("repairable_divergence");
      expect(
        resFailing.divergenceFindings.some((f) => f.category === "unhandled_negative_case"),
      ).toBe(true);
    });
  });

  describe("Overall Results Aggregation", () => {
    it("correctly aggregates multi-scenario outcomes and metrics", () => {
      const res1: ReplayScenarioExecutionResult = {
        scenarioId: "s1",
        scenarioName: "Scenario 1",
        status: "pass",
        passed: true,
        executionTrace: {} as unknown as ReplayExecutionTrace,
        invariantEvaluations: [],
        metricsComparison: {
          baselineStepCount: 4,
          candidateStepCount: 1,
          stepReductionCount: 3,
          stepReductionPercent: 75,
          baselineDurationMs: 1000,
          candidateDurationMs: 100,
          durationReductionMs: 900,
          durationReductionPercent: 90,
          baselineTokens: 400,
          candidateTokens: 100,
          tokenSavingsCount: 300,
          tokenSavingsPercent: 75,
          baselineToolCalls: 3,
          candidateToolCalls: 1,
        },
        divergenceFindings: [],
        durationMs: 100,
        seed: 42,
      };

      const res2: ReplayScenarioExecutionResult = {
        scenarioId: "s2",
        scenarioName: "Scenario 2",
        type: "counterfactual",
        status: "pass",
        passed: true,
        executionTrace: {} as unknown as ReplayExecutionTrace,
        invariantEvaluations: [],
        metricsComparison: {
          baselineStepCount: 4,
          candidateStepCount: 1,
          stepReductionCount: 3,
          stepReductionPercent: 75,
          baselineDurationMs: 1000,
          candidateDurationMs: 150,
          durationReductionMs: 850,
          durationReductionPercent: 85,
          baselineTokens: 400,
          candidateTokens: 120,
          tokenSavingsCount: 280,
          tokenSavingsPercent: 70,
          baselineToolCalls: 3,
          candidateToolCalls: 1,
        },
        divergenceFindings: [],
        durationMs: 150,
        seed: 43,
      };

      const overall = comparator.compareOverall([res1, res2]);

      expect(overall.status).toBe("pass");
      expect(overall.passed).toBe(true);
      expect(overall.passedScenarioCount).toBe(2);
      expect(overall.totalScenarioCount).toBe(2);
      expect(overall.overallMetrics.baselineStepCount).toBe(8);
      expect(overall.overallMetrics.candidateStepCount).toBe(2);
      expect(overall.overallMetrics.stepReductionPercent).toBe(75);
    });
  });

  // ——— New workload/model usage pricing/comparison tests ———
  describe("Workload Model Cost & Benchmarks", () => {
    const mkUsage = (overrides: Partial<ModelUsageMetrics> = {}): ModelUsageMetrics => ({
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 20_000,
      turns: 3,
      toolCalls: 4,
      redundantToolCalls: 0,
      wallTimeMs: 1500,
      correct: true,
      ...overrides,
    });

    it("calculates exact weighted cost formula with authoritative schedule", () => {
      expect(MODEL_COST_SCHEDULE_V1).toEqual({ input: 1, output: 4, cacheRead: 0.25 });
      expect(MODEL_COST_SCHEDULES[MODEL_COST_SCHEDULE_ID_V1]).toEqual(MODEL_COST_SCHEDULE_V1);

      const usage: ModelUsageMetrics = {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 2_000_000,
        turns: 5,
        toolCalls: 6,
        redundantToolCalls: 0,
        wallTimeMs: 3000,
        correct: true,
      };
      // (1_000_000*1 + 500_000*4 + 2_000_000*0.25) / 1_000_000 = (1 + 2 + 0.5) = 3.5
      expect(calculateWeightedModelCost(usage)).toBe(3.5);
      expect(calculateWeightedModelCost(usage, MODEL_COST_SCHEDULE_ID_V1)).toBe(3.5);
      // all-zero / custom prices via unknown schedule must be rejected
      expect(() => calculateWeightedModelCost(usage, "unknown-schedule-v999")).toThrow(/Unknown scheduleId|Unknown model cost scheduleId/);
      expect(() => calculateWeightedModelCost(usage, "custom-zero" as any)).toThrow();

      const smallUsage = mkUsage({ inputTokens: 10_000, outputTokens: 5_000, cacheReadTokens: 0 });
      // (10k*1 +5k*4)/1M = (10k+20k)/1M=0.03
      expect(calculateWeightedModelCost(smallUsage)).toBeCloseTo(0.03, 10);
    });

    it("computes correct non-redundant savings benchmark when candidate cheaper and correct", async () => {
      const baseline = mkUsage({ inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 50_000, redundantToolCalls: 0, correct: true });
      const candidate = mkUsage({ inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 20_000, redundantToolCalls: 0, correct: true });
      const evidence = makeEvidence("small");
      const baselineCost = calculateWeightedModelCost(baseline, evidence.scheduleId);
      const candidateCost = calculateWeightedModelCost(candidate, evidence.scheduleId);
      expect(candidateCost).toBeLessThan(baselineCost);

      const scenario: ReplayScenario = {
        ...baseScenario,
        id: "sc-workload-small",
        workloadSize: "small",
        baselineModelUsage: baseline,
        benchmarkEvidence: evidence,
      };
      const trace: ReplayExecutionTrace = {
        scenarioId: "sc-workload-small",
        seed: 1,
        operations: [
          { service: "fs", operation: "readFile", args: ["/workspace/a.ts"], timestamp: Date.now(), durationMs: 5 },
          { service: "fs", operation: "readFile", args: ["/workspace/b.ts"], timestamp: Date.now(), durationMs: 5 },
        ],
        toolOutput: { matchCount: 2 },
        error: null,
        durationMs: 50,
        stepCount: 1,
        logs: [],
        modelUsage: candidate,
      };

      const res = await comparator.compareTrace(scenario, trace);
      expect(res.workloadBenchmark).toBeDefined();
      const wb = res.workloadBenchmark!;
      expect(wb.workloadSize).toBe("small");
      expect(wb.baselineCostUsd).toBe(baselineCost);
      expect(wb.candidateCostUsd).toBe(candidateCost);
      expect(wb.correctnessPassed).toBe(true);
      expect(wb.redundantVerificationCalls).toBe(0);
      expect(wb.candidate.redundantToolCalls).toBe(0);
      // costDeltaPercent negative when candidate cheaper
      expect(wb.costDeltaPercent).toBeCloseTo(((candidateCost - baselineCost) / baselineCost) * 100, 10);
      expect(wb.costDeltaPercent).toBeLessThanOrEqual(0);
      // Redundancy must be explicit from usage, not guessed from broker operations (operations length 2 but redundant 0)
      expect(wb.redundantVerificationCalls).toBe(0);
      expect(wb.redundantVerificationCalls).not.toBe(trace.operations.length);
      // evidence binding fields are fully populated from explicit evidence
      expect(wb.benchmarkId).toBe(evidence.benchmarkId);
      expect(wb.candidateRevisionId).toBe(evidence.candidateRevisionId);

      // existing replay metrics remain unchanged when workload present
      expect(res.metricsComparison.stepReductionCount).toBe(4);
      expect(res.metricsComparison.baselineStepCount).toBe(5);
    });

    it("derives redundantVerificationCalls explicitly from candidate usage, even when broker calls many", async () => {
      const baseline = mkUsage({ redundantToolCalls: 0 });
      const candidate = mkUsage({ redundantToolCalls: 3, toolCalls: 10, correct: true });
      const evidence = makeEvidence("medium");
      const scenario: ReplayScenario = {
        ...baseScenario,
        workloadSize: "medium",
        baselineModelUsage: baseline,
        benchmarkEvidence: evidence,
      };
      const trace: ReplayExecutionTrace = {
        scenarioId: baseScenario.id,
        seed: 2,
        operations: [
          { service: "fs", operation: "readFile", args: ["/workspace/x.ts"], timestamp: Date.now(), durationMs: 1 },
        ],
        toolOutput: { matchCount: 2 },
        error: null,
        durationMs: 60,
        stepCount: 1,
        logs: [],
        modelUsage: candidate,
      };
      const res = await comparator.compareTrace(scenario, trace);
      expect(res.workloadBenchmark).toBeDefined();
      expect(res.workloadBenchmark!.redundantVerificationCalls).toBe(3);
      expect(res.workloadBenchmark!.candidate.redundantToolCalls).toBe(3);
      // not inferred from operations.length (1)
      expect(res.workloadBenchmark!.redundantVerificationCalls).not.toBe(trace.operations.length);
      expect(res.workloadBenchmark!.correctnessPassed).toBe(true);
    });

    it("flags candidate cost regression when candidateCost > baselineCost", async () => {
      const baseline = mkUsage({ inputTokens: 50_000, outputTokens: 20_000, cacheReadTokens: 10_000 });
      const candidate = mkUsage({ inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 50_000 }); // more tokens -> higher cost
      const evidence = makeEvidence("large");
      const baselineCost = calculateWeightedModelCost(baseline, evidence.scheduleId);
      const candidateCost = calculateWeightedModelCost(candidate, evidence.scheduleId);
      expect(candidateCost).toBeGreaterThan(baselineCost);

      const scenario: ReplayScenario = {
        ...baseScenario,
        workloadSize: "large",
        baselineModelUsage: baseline,
        benchmarkEvidence: evidence,
      };
      const trace: ReplayExecutionTrace = {
        scenarioId: baseScenario.id,
        seed: 3,
        operations: [],
        toolOutput: { matchCount: 2 },
        error: null,
        durationMs: 40,
        stepCount: 1,
        logs: [],
        modelUsage: candidate,
      };
      const res = await comparator.compareTrace(scenario, trace);
      expect(res.workloadBenchmark).toBeDefined();
      expect(res.workloadBenchmark!.candidateCostUsd).toBeGreaterThan(res.workloadBenchmark!.baselineCostUsd);
      expect(res.workloadBenchmark!.costDeltaPercent).toBeGreaterThan(0);
      // candidate still correct but cost regressed
      expect(res.workloadBenchmark!.correctnessPassed).toBe(true);
    });

    it("aggregates deterministic small/medium/large ordering while existing replay metrics remain unchanged", async () => {
      const mkBench = (size: WorkloadSize, inputTokens: number): WorkloadBenchmarkComparison => {
        const baseline = mkUsage({ inputTokens: inputTokens + 100_000, outputTokens: 50_000, correct: true });
        const candidate = mkUsage({ inputTokens, outputTokens: 30_000, correct: true });
        const evidence = makeEvidence(size);
        return comparator.buildWorkloadBenchmark(size, baseline, candidate, evidence);
      };

      // Create scenario results unsorted: large, small, medium
      const makeResult = (size: WorkloadSize, baselineTokens: number, candidateTokens: number): ReplayScenarioExecutionResult => {
        const baseline = mkUsage({ inputTokens: baselineTokens, correct: true });
        const candidate = mkUsage({ inputTokens: candidateTokens, correct: true });
        const evidence = makeEvidence(size);
        const wb = comparator.buildWorkloadBenchmark(size, baseline, candidate, evidence);
        return {
          scenarioId: `s-${size}`,
          scenarioName: `Scenario ${size}`,
          type: "observed_episode",
          status: "pass",
          passed: true,
          executionTrace: { scenarioId: `s-${size}`, seed: 1, operations: [], durationMs: 100, stepCount: 1, logs: [] } as unknown as ReplayExecutionTrace,
          invariantEvaluations: [],
          metricsComparison: {
            baselineStepCount: 2,
            candidateStepCount: 1,
            stepReductionCount: 1,
            stepReductionPercent: 50,
            baselineDurationMs: 200,
            candidateDurationMs: 100,
            durationReductionMs: 100,
            durationReductionPercent: 50,
            baselineTokens: 200,
            candidateTokens: 100,
            tokenSavingsCount: 100,
            tokenSavingsPercent: 50,
            baselineToolCalls: 2,
            candidateToolCalls: 1,
          },
          divergenceFindings: [],
          durationMs: 100,
          seed: 1,
          workloadBenchmark: wb,
        };
      };

      const resLarge = makeResult("large", 300_000, 150_000);
      const resSmall = makeResult("small", 100_000, 50_000);
      const resMedium = makeResult("medium", 200_000, 100_000);

      // Pass unsorted
      const overall = comparator.compareOverall([resLarge, resSmall, resMedium]);
      expect(overall.workloadBenchmarks).toBeDefined();
      expect(overall.workloadBenchmarks!.map((b) => b.workloadSize)).toEqual(["small", "medium", "large"]);
      // deterministic ordering regardless of input order
      const overall2 = comparator.compareOverall([resSmall, resMedium, resLarge]);
      expect(overall2.workloadBenchmarks!.map((b) => b.workloadSize)).toEqual(["small", "medium", "large"]);
      expect(overall.workloadBenchmarks).toEqual(overall2.workloadBenchmarks);

      // existing replay metrics unchanged aggregation (2+2+2 baseline steps =6)
      expect(overall.overallMetrics.baselineStepCount).toBe(6);
      expect(overall.overallMetrics.candidateStepCount).toBe(3);
      expect(overall.overallMetrics.stepReductionPercent).toBe(50);
      // ensure external benchmarks merge also sorted
      const external: WorkloadBenchmarkComparison = mkBench("medium", 80_000); // duplicate size should throw
      expect(() => comparator.compareOverall([resSmall, resMedium], [external])).toThrow(/Duplicate/);
    });

    it("validates finite non-negative metrics fail-closed", () => {
      const badBaseline = mkUsage({ inputTokens: NaN });
      const goodCandidate = mkUsage();
      const evidence = makeEvidence("small");
      expect(() => comparator.buildWorkloadBenchmark("small", badBaseline, goodCandidate, evidence)).toThrow(/finite/);
      const badCandidate = mkUsage({ outputTokens: -10 });
      expect(() => comparator.buildWorkloadBenchmark("small", mkUsage(), badCandidate, evidence)).toThrow(/non-negative|finite/);
      const infUsage = mkUsage({ cacheReadTokens: Infinity });
      expect(() => calculateWeightedModelCost(infUsage)).toThrow(/finite/);
    });
    it("keeps existing replay metrics unchanged when workload benchmarks absent", async () => {
      const trace: ReplayExecutionTrace = {
        scenarioId: "sc-01",
        seed: 42,
        operations: [],
        toolOutput: { matchCount: 2 },
        error: null,
        durationMs: 50,
        stepCount: 1,
        logs: [],
      };
      const res = await comparator.compareTrace(baseScenario, trace);
      expect(res.workloadBenchmark).toBeUndefined();
      expect(res.metricsComparison.stepReductionCount).toBe(4);
      // compareOverall without benchmarks should have no workloadBenchmarks
      const overall = comparator.compareOverall([res]);
      expect(overall.workloadBenchmarks).toBeUndefined();
      expect(overall.overallMetrics.baselineStepCount).toBe(5);
    });

    it("returns undefined when any canonical telemetry field is absent without fabrication", async () => {
      const baseline = mkUsage({ inputTokens: 200_000, correct: true });
      const candidate = mkUsage({ inputTokens: 100_000, correct: true });
      const evidence = makeEvidence("small");

      // missing workloadSize
      const scenarioNoSize: ReplayScenario = {
        ...baseScenario,
        baselineModelUsage: baseline,
        benchmarkEvidence: evidence,
      };
      const traceWithUsage: ReplayExecutionTrace = {
        scenarioId: baseScenario.id,
        seed: 10,
        operations: [],
        toolOutput: { matchCount: 2 },
        error: null,
        durationMs: 50,
        stepCount: 1,
        logs: [],
        modelUsage: candidate,
        tokensUsed: 999,
      };
      const resNoSize = await comparator.compareTrace(scenarioNoSize, traceWithUsage);
      expect(resNoSize.workloadBenchmark).toBeUndefined();

      // missing baselineModelUsage
      const scenarioNoBaseline: ReplayScenario = {
        ...baseScenario,
        workloadSize: "small",
        benchmarkEvidence: evidence,
      };
      const resNoBaseline = await comparator.compareTrace(scenarioNoBaseline, traceWithUsage);
      expect(resNoBaseline.workloadBenchmark).toBeUndefined();

      // missing trace.modelUsage
      const scenarioFull: ReplayScenario = {
        ...baseScenario,
        workloadSize: "small",
        baselineModelUsage: baseline,
        benchmarkEvidence: evidence,
      };
      const traceNoUsage: ReplayExecutionTrace = {
        scenarioId: baseScenario.id,
        seed: 11,
        operations: [],
        toolOutput: { matchCount: 2 },
        error: null,
        durationMs: 50,
        stepCount: 1,
        logs: [],
        tokensUsed: 500,
      };
      const resNoCandidate = await comparator.compareTrace(scenarioFull, traceNoUsage);
      expect(resNoCandidate.workloadBenchmark).toBeUndefined();

      // missing benchmarkEvidence (explicit evidence required)
      const scenarioNoEvidence: ReplayScenario = {
        ...baseScenario,
        workloadSize: "small",
        baselineModelUsage: baseline,
      };
      const resNoEvidence = await comparator.compareTrace(scenarioNoEvidence, traceWithUsage);
      expect(resNoEvidence.workloadBenchmark).toBeUndefined();

      // ensure tokensUsed/duration/stepCount do not fabricate candidate usage
      const traceFabricated: ReplayExecutionTrace = {
        scenarioId: baseScenario.id,
        seed: 12,
        operations: [{ service: "fs", operation: "readFile", args: ["/workspace/a.ts"], timestamp: Date.now(), durationMs: 5 }],
        toolOutput: { matchCount: 2 },
        error: null,
        durationMs: 100,
        stepCount: 5,
        tokensUsed: 1000,
        logs: [],
      };
      const resFabricated = await comparator.compareTrace(scenarioFull, traceFabricated);
      expect(resFabricated.workloadBenchmark).toBeUndefined();

      // overall remains undefined when all derived are absent
      const overall = comparator.compareOverall([resNoSize, resNoBaseline, resNoCandidate, resNoEvidence, resFabricated]);
      expect(overall.workloadBenchmarks).toBeUndefined();
    });

    it("explicit observed evidence creates a fully bound comparison; tokens alone cannot", async () => {
      const baseline = mkUsage({ inputTokens: 200_000, correct: true });
      const candidate = mkUsage({ inputTokens: 100_000, correct: true });
      const evidence = makeEvidence("small");
      const scenarioWithEvidence: ReplayScenario = {
        ...baseScenario,
        workloadSize: "small",
        baselineModelUsage: baseline,
        benchmarkEvidence: evidence,
      };
      const traceWithUsage: ReplayExecutionTrace = {
        scenarioId: baseScenario.id,
        seed: 20,
        operations: [],
        toolOutput: { matchCount: 2 },
        error: null,
        durationMs: 50,
        stepCount: 1,
        logs: [],
        modelUsage: candidate,
      };
      const resWithEvidence = await comparator.compareTrace(scenarioWithEvidence, traceWithUsage);
      expect(resWithEvidence.workloadBenchmark).toBeDefined();
      expect(resWithEvidence.workloadBenchmark!.benchmarkId).toBe(evidence.benchmarkId);
      expect(resWithEvidence.workloadBenchmark!.workloadInputDigest).toBe(evidence.workloadInputDigest);
      expect(resWithEvidence.workloadBenchmark!.candidateRevisionId).toBe(evidence.candidateRevisionId);
      // without evidence, even with tokens, no benchmark
      const scenarioNoEvidence: ReplayScenario = {
        ...baseScenario,
        workloadSize: "small",
        baselineModelUsage: baseline,
      };
      const resTokensOnly = await comparator.compareTrace(scenarioNoEvidence, {
        ...traceWithUsage,
        tokensUsed: 9999,
        modelUsage: undefined,
      } as unknown as ReplayExecutionTrace);
      expect(resTokensOnly.workloadBenchmark).toBeUndefined();
    });
  });
  describe("Immutable Benchmark Evidence & Pricing Integrity", () => {
    const mkUsageFull = (overrides: Partial<ModelUsageMetrics> = {}): ModelUsageMetrics => ({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      turns: 2,
      toolCalls: 3,
      redundantToolCalls: 0,
      wallTimeMs: 1200,
      correct: true,
      ...overrides,
    });

    const makeEvidence = (size: WorkloadSize, overrides: Partial<WorkloadBenchmarkComparison> = {}): WorkloadBenchmarkComparison => {
      const baseline = mkUsageFull({ inputTokens: size === "small" ? 2000 : size === "medium" ? 5000 : 10000, outputTokens: size === "small" ? 600 : 2000, cacheReadTokens: 200 });
      const candidate = mkUsageFull({ inputTokens: size === "small" ? 1000 : size === "medium" ? 4500 : 9000, outputTokens: size === "small" ? 500 : 1800, cacheReadTokens: 200 });
      const scheduleId = MODEL_COST_SCHEDULE_ID_V1;
      const baselineCostUsd = calculateWeightedModelCost(baseline, scheduleId);
      const candidateCostUsd = calculateWeightedModelCost(candidate, scheduleId);
      const digest = size === "small" ? "a".repeat(64) : size === "medium" ? "b".repeat(64) : "c".repeat(64);
      return {
        workloadSize: size,
        baseline,
        candidate,
        baselineCostUsd,
        candidateCostUsd,
        costDeltaPercent: baselineCostUsd === 0 ? 0 : ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100,
        correctnessPassed: true,
        redundantVerificationCalls: 0,
        benchmarkId: `bench-${size}`,
        baselineRunId: `baseline-${size}`,
        candidateRunId: `candidate-${size}`,
        workloadInputDigest: digest,
        candidateRevisionId: "rev_valid_01",
        artifactDigest: "d".repeat(64),
        modelProvider: "test-provider",
        modelId: "test-model",
        observedAt: "2026-08-20T12:00:00.000Z",
        scheduleId,
        ...overrides,
      } as WorkloadBenchmarkComparison;
    };

    it("rejects forged cheap costs (baselineCostUsd mismatch)", () => {
      const bm = makeEvidence("small");
      const forged = { ...bm, baselineCostUsd: bm.baselineCostUsd * 0.1 };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([forged])).toThrow(/baselineCostUsd/);
      const evidence: WorkloadBenchmarkEvidence = {
        benchmarkId: bm.benchmarkId,
        baselineRunId: bm.baselineRunId,
        candidateRunId: bm.candidateRunId,
        workloadInputDigest: bm.workloadInputDigest,
        candidateRevisionId: bm.candidateRevisionId,
        artifactDigest: bm.artifactDigest,
        modelProvider: bm.modelProvider,
        modelId: bm.modelId,
        observedAt: bm.observedAt,
        scheduleId: bm.scheduleId,
      };
      const bm2 = comparator.buildWorkloadBenchmark("small", bm.baseline, bm.candidate, evidence);
      // tamper
      const forged2 = { ...bm2, candidateCostUsd: 0.00001 };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([forged2])).toThrow(/candidateCostUsd/);
    });

    it("rejects costDeltaPercent mismatch", () => {
      const bm = makeEvidence("small");
      const forged = { ...bm, costDeltaPercent: bm.costDeltaPercent + 10 };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([forged])).toThrow(/costDeltaPercent/);
    });

    it("rejects copied rows under new size labels (duplicate benchmarkId)", () => {
      const a = makeEvidence("small");
      const b = { ...makeEvidence("medium"), benchmarkId: a.benchmarkId };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([a, b])).toThrow(/duplicate benchmarkId/i);
    });

    it("rejects duplicate baselineRunId", () => {
      const a = makeEvidence("small");
      const b = makeEvidence("medium");
      const bDup = { ...b, baselineRunId: a.baselineRunId };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([a, bDup])).toThrow(/duplicate baselineRunId/i);
    });

    it("rejects duplicate candidateRunId", () => {
      const a = makeEvidence("small");
      const b = { ...makeEvidence("medium"), candidateRunId: a.candidateRunId };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([a, b])).toThrow(/duplicate candidateRunId/i);
    });

    it("rejects duplicate workloadInputDigest", () => {
      const a = makeEvidence("small");
      const b = { ...makeEvidence("medium"), workloadInputDigest: a.workloadInputDigest };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([a, b])).toThrow(/duplicate workloadInputDigest/i);
    });

    it("rejects duplicate workloadSize", () => {
      const a = makeEvidence("small");
      const b = makeEvidence("small");
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([a, b])).toThrow(/Duplicate workloadSize/);
    });

    it("rejects wrong revision/digest formats", () => {
      const badRev = makeEvidence("small", { candidateRevisionId: "bad rev!" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([badRev])).toThrow(/candidateRevisionId/);
      const badArt = makeEvidence("small", { artifactDigest: "not-hex" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([badArt])).toThrow(/artifactDigest/);
      const badInput = makeEvidence("small", { workloadInputDigest: "zzzz" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([badInput])).toThrow(/workloadInputDigest/);
      const badBench = makeEvidence("small", { benchmarkId: "" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([badBench])).toThrow(/benchmarkId/);
    });

    it("rejects invalid timestamps", () => {
      const bad = makeEvidence("small", { observedAt: "not-iso" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([bad])).toThrow(/observedAt/);
      const bad2 = makeEvidence("small", { observedAt: "2026-13-01T00:00:00Z" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([bad2])).toThrow(/observedAt/);
      const bad3 = makeEvidence("small", { observedAt: "2026/08/20 12:00:00" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([bad3])).toThrow(/observedAt/);
    });

    it("rejects empty model fields", () => {
      const badProv = makeEvidence("small", { modelProvider: "" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([badProv])).toThrow(/modelProvider/);
      const badModel = makeEvidence("small", { modelId: "   " });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([badModel])).toThrow(/modelId/);
    });

    it("rejects mismatched candidateRevisionId/artifactDigest across rows", () => {
      const a = makeEvidence("small");
      const b = makeEvidence("medium");
      const c = makeEvidence("large", { candidateRevisionId: "rev_other_02" });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([a, b, c])).toThrow(/candidateRevisionId mismatch/);
      const a2 = makeEvidence("small");
      const b2 = makeEvidence("medium");
      const c2 = makeEvidence("large", { artifactDigest: "e".repeat(64) });
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([a2, b2, c2])).toThrow(/artifactDigest mismatch/);
    });

    it("valid bound rows sort and survive (small→medium→large)", () => {
      const large = makeEvidence("large");
      const small = makeEvidence("small");
      const medium = makeEvidence("medium");
      const sorted = comparator.sortAndValidateWorkloadBenchmarks([large, small, medium]);
      expect(sorted.map((b) => b.workloadSize)).toEqual(["small", "medium", "large"]);
      // also via compareOverall merging
      const makeRes = (size: WorkloadSize): ReplayScenarioExecutionResult => ({
        scenarioId: `s-${size}`,
        scenarioName: `Scenario ${size}`,
        type: "observed_episode",
        status: "pass",
        passed: true,
        executionTrace: { scenarioId: `s-${size}`, seed: 1, operations: [], durationMs: 100, stepCount: 1, logs: [] } as unknown as ReplayExecutionTrace,
        invariantEvaluations: [],
        divergenceFindings: [],
        metricsComparison: {
          baselineStepCount: 5,
          candidateStepCount: 3,
          stepReductionCount: 2,
          stepReductionPercent: 40,
          baselineDurationMs: 200,
          candidateDurationMs: 100,
          durationReductionMs: 100,
          durationReductionPercent: 50,
          baselineTokens: 1000,
          candidateTokens: 600,
          tokenSavingsCount: 400,
          tokenSavingsPercent: 40,
          baselineToolCalls: 5,
          candidateToolCalls: 3,
        },
        workloadBenchmark: makeEvidence(size),
      });
      const overall = comparator.compareOverall([makeRes("large"), makeRes("small"), makeRes("medium")]);
      expect(overall.workloadBenchmarks).toBeDefined();
      expect(overall.workloadBenchmarks!.map((b) => b.workloadSize)).toEqual(["small", "medium", "large"]);
    });

    it("recomputes costs with authoritative schedule and rejects mismatch", () => {
      const baseline = mkUsageFull({ inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 20_000 });
      const candidate = mkUsageFull({ inputTokens: 50_000, outputTokens: 20_000, cacheReadTokens: 10_000 });
      const evidence: WorkloadBenchmarkEvidence = {
        benchmarkId: "bench-small",
        baselineRunId: "base-small",
        candidateRunId: "cand-small",
        workloadInputDigest: "a".repeat(64),
        candidateRevisionId: "rev_valid_01",
        artifactDigest: "d".repeat(64),
        modelProvider: "prov",
        modelId: "model",
        observedAt: "2026-08-20T00:00:00Z",
        scheduleId: MODEL_COST_SCHEDULE_ID_V1,
      };
      const bm = comparator.buildWorkloadBenchmark("small", baseline, candidate, evidence);
      const expectedBaseline = calculateWeightedModelCost(baseline, MODEL_COST_SCHEDULE_ID_V1);
      const expectedCandidate = calculateWeightedModelCost(candidate, MODEL_COST_SCHEDULE_ID_V1);
      expect(bm.baselineCostUsd).toBeCloseTo(expectedBaseline, 9);
      expect(bm.candidateCostUsd).toBeCloseTo(expectedCandidate, 9);
      expect(bm.scheduleId).toBe(MODEL_COST_SCHEDULE_ID_V1);
      // Unknown schedule must be rejected terminally
      const badEvidence = { ...evidence, scheduleId: "unknown-schedule-v999" } as unknown as WorkloadBenchmarkEvidence;
      expect(() => comparator.buildWorkloadBenchmark("small", baseline, candidate, badEvidence)).toThrow(/Unknown scheduleId|Unknown model cost scheduleId/);
      // all-zero forgery via tampered cost must still be rejected
      const forged = { ...bm, baselineCostUsd: 0 };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([forged])).toThrow(/baselineCostUsd/);
      // custom-price forgery impossible: caller cannot supply arbitrary prices, only scheduleId
      const forged2 = { ...bm, scheduleId: "custom-zero" as unknown as string, baselineCostUsd: 0, candidateCostUsd: 0 };
      expect(() => comparator.sortAndValidateWorkloadBenchmarks([forged2 as unknown as typeof bm])).toThrow(/Unknown scheduleId|scheduleId/);
    });

    it("buildWorkloadBenchmark requires explicit evidence; no placeholder fabrication", () => {
      const baseline = mkUsageFull();
      const candidate = mkUsageFull();
      // @ts-expect-error missing evidence should not compile or should throw if called incorrectly
      expect(() => (comparator as unknown as { buildWorkloadBenchmark: (...a: unknown[]) => unknown }).buildWorkloadBenchmark("small", baseline, candidate)).toThrow();
      // also invalid evidence missing fields should throw
      const badEvidence = { benchmarkId: "bench-small" } as unknown as WorkloadBenchmarkEvidence;
      expect(() => comparator.buildWorkloadBenchmark("small", baseline, candidate, badEvidence)).toThrow();
    });
  });
});
