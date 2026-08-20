import { describe, expect, it } from "vitest";
import { ReplayTraceComparator } from "../../../src/evolution/replay/comparator.js";
import {
  calculateWeightedModelCost,
  DEFAULT_MODEL_TOKEN_PRICES,
} from "../../../src/evolution/replay/types.js";
import type {
  ModelUsageMetrics,
  ReplayExecutionTrace,
  ReplayScenario,
  ReplayScenarioExecutionResult,
  WorkloadBenchmarkComparison,
  WorkloadSize,
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

    it("calculates exact weighted cost formula with default pricing", () => {
      expect(DEFAULT_MODEL_TOKEN_PRICES).toEqual({ input: 1, output: 4, cacheRead: 0.25 });

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
      expect(calculateWeightedModelCost(usage, { input: 1, output: 4, cacheRead: 0.25 })).toBe(3.5);
      // custom pricing: (1M*2 + 500k*10 + 2M*1)/1M = 2 +5 +2 =9
      expect(calculateWeightedModelCost(usage, { input: 2, output: 10, cacheRead: 1 })).toBe(9);

      const smallUsage = mkUsage({ inputTokens: 10_000, outputTokens: 5_000, cacheReadTokens: 0 });
      // (10k*1 +5k*4)/1M = (10k+20k)/1M=0.03
      expect(calculateWeightedModelCost(smallUsage)).toBeCloseTo(0.03, 10);
    });

    it("computes correct non-redundant savings benchmark when candidate cheaper and correct", async () => {
      const baseline = mkUsage({ inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 50_000, redundantToolCalls: 0, correct: true });
      const candidate = mkUsage({ inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 20_000, redundantToolCalls: 0, correct: true });
      const baselineCost = calculateWeightedModelCost(baseline);
      const candidateCost = calculateWeightedModelCost(candidate);
      expect(candidateCost).toBeLessThan(baselineCost);

      const scenario: ReplayScenario = {
        ...baseScenario,
        id: "sc-workload-small",
        workloadSize: "small",
        baselineModelUsage: baseline,
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

      // existing replay metrics remain unchanged when workload present
      expect(res.metricsComparison.stepReductionCount).toBe(4);
      expect(res.metricsComparison.baselineStepCount).toBe(5);
    });

    it("derives redundantVerificationCalls explicitly from candidate usage, even when broker calls many", async () => {
      const baseline = mkUsage({ redundantToolCalls: 0 });
      const candidate = mkUsage({ redundantToolCalls: 3, toolCalls: 10, correct: true });
      const scenario: ReplayScenario = {
        ...baseScenario,
        workloadSize: "medium",
        baselineModelUsage: baseline,
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
      const baselineCost = calculateWeightedModelCost(baseline);
      const candidateCost = calculateWeightedModelCost(candidate);
      expect(candidateCost).toBeGreaterThan(baselineCost);

      const scenario: ReplayScenario = {
        ...baseScenario,
        workloadSize: "large",
        baselineModelUsage: baseline,
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
        return comparator.buildWorkloadBenchmark(size, baseline, candidate);
      };

      // Create scenario results unsorted: large, small, medium
      const makeResult = (size: WorkloadSize, baselineTokens: number, candidateTokens: number): ReplayScenarioExecutionResult => {
        const baseline = mkUsage({ inputTokens: baselineTokens, correct: true });
        const candidate = mkUsage({ inputTokens: candidateTokens, correct: true });
        const wb = comparator.buildWorkloadBenchmark(size, baseline, candidate);
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
      expect(() => comparator.buildWorkloadBenchmark("small", badBaseline, goodCandidate)).toThrow(/finite/);
      const badCandidate = mkUsage({ outputTokens: -10 });
      expect(() => comparator.buildWorkloadBenchmark("small", mkUsage(), badCandidate)).toThrow(/non-negative|finite/);
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

      // missing workloadSize
      const scenarioNoSize: ReplayScenario = {
        ...baseScenario,
        baselineModelUsage: baseline,
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
      };
      const resNoBaseline = await comparator.compareTrace(scenarioNoBaseline, traceWithUsage);
      expect(resNoBaseline.workloadBenchmark).toBeUndefined();

      // missing trace.modelUsage
      const scenarioFull: ReplayScenario = {
        ...baseScenario,
        workloadSize: "small",
        baselineModelUsage: baseline,
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
      const overall = comparator.compareOverall([resNoSize, resNoBaseline, resNoCandidate, resFabricated]);
      expect(overall.workloadBenchmarks).toBeUndefined();
    });
  });
});
