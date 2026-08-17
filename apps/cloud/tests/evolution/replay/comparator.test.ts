import { describe, expect, it } from "vitest";
import { ReplayTraceComparator } from "../../../src/evolution/replay/comparator.js";
import type {
  ReplayExecutionTrace,
  ReplayScenario,
  ReplayScenarioExecutionResult,
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
      expect(result.divergenceFindings.some((f) => f.category === "unauthorized_side_effect")).toBe(true);
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
      expect(resFailing.divergenceFindings.some((f) => f.category === "unhandled_negative_case")).toBe(true);
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
});
