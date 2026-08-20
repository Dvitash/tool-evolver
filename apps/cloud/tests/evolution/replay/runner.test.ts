import { describe, expect, it } from "vitest";
import { HistoricalReplayRunner } from "../../../src/evolution/replay/runner.js";
import type {
  ModelUsageMetrics,
  ReplayScenario,
  WorkloadBenchmarkComparison,
} from "../../../src/evolution/replay/types.js";
import {
  CMD_RUN_CANDIDATE_SOURCE,
  FS_SEARCH_CANDIDATE_SOURCE,
  NET_FETCH_CANDIDATE_SOURCE,
  PURE_COMPUTE_CANDIDATE_SOURCE,
  UNAUTHORIZED_FS_CANDIDATE_SOURCE,
  createMockCandidateRevision,
} from "./helpers.js";

describe("HistoricalReplayRunner", () => {
  const runner = new HistoricalReplayRunner();

  describe("Candidate Execution Across Categories", () => {
    it("executes pure compute candidate in sandbox and verifies output invariants", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE, {
        name: "compute_stats",
        parameters: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
        },
      });

      const scenario: ReplayScenario = {
        id: "sc-pure-01",
        name: "Compute Stats Test",
        description: "Runs pure arithmetic compute",
        type: "observed_episode",
        evidenceEventIds: ["ev-01"],
        input: { a: 10, b: 5 },
        virtualState: {},
        invariants: [
          {
            id: "inv-output",
            name: "Output Schema",
            type: "output_schema",
            description: "Matches schema",
            severity: "critical",
          },
          {
            id: "inv-semantic",
            name: "Semantic Match",
            type: "semantic_equality",
            description: "Sum must equal 15",
            severity: "critical",
            expectedValue: { sum: 15, product: 50 },
          },
        ],
        allowedBrokerOperations: [],
        baselineMetrics: {
          stepCount: 2,
          totalTokens: 200,
          totalDurationMs: 500,
          toolCallsCount: 2,
          estimatedCostUsd: 0.0006,
        },
      };

      const result = await runner.runScenario(candidate, scenario);

      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
      expect(result.executionTrace.toolOutput).toEqual({ sum: 15, product: 50 });
      expect(result.executionTrace.operations.length).toBe(0); // Zero broker ops for pure compute
    });

    it("executes filesystem candidate against in-memory virtual state", async () => {
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE, {
        name: "fs_search_content",
      });

      const scenario: ReplayScenario = {
        id: "sc-fs-01",
        name: "FS Search Test",
        description: "Searches file lines",
        type: "observed_episode",
        evidenceEventIds: ["ev-01"],
        input: { filePath: "/workspace/src/app.ts", query: "target" },
        virtualState: {
          fs: {
            files: {
              "/workspace/src/app.ts":
                "const target1 = true;\nconst other = false;\nconst target2 = true;\n",
            },
          },
        },
        invariants: [
          {
            id: "inv-output",
            name: "Output Schema",
            type: "output_schema",
            description: "Matches schema",
            severity: "critical",
          },
          {
            id: "inv-semantic",
            name: "Semantic Match",
            type: "semantic_equality",
            description: "Match count must be 2",
            severity: "critical",
            expectedValue: { matchCount: 2, totalLines: 4 },
          },
        ],
        allowedBrokerOperations: [
          {
            service: "fs",
            operation: "readFile",
            pathPattern: "/workspace/.*",
          },
        ],
        baselineMetrics: {
          stepCount: 3,
          totalTokens: 300,
          totalDurationMs: 800,
          toolCallsCount: 3,
          estimatedCostUsd: 0.0009,
        },
      };

      const result = await runner.runScenario(candidate, scenario);

      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
      expect(result.executionTrace.operations.length).toBe(1);
      expect(result.executionTrace.operations[0]!.operation).toBe("readFile");
    });

    it("executes network candidate against mock routes", async () => {
      const candidate = createMockCandidateRevision(
        NET_FETCH_CANDIDATE_SOURCE,
        { name: "net_api_fetcher" },
        {
          net: {
            allowOutbound: true,
            allowedDomains: ["*"],
            allowedHosts: [".*"],
            allowedPorts: [80, 443],
            allowedProtocols: ["https", "http"],
            allowLocalhost: true,
            denyPrivateRanges: false,
          },
        },
      );

      const scenario: ReplayScenario = {
        id: "sc-net-01",
        name: "Net Fetch Test",
        description: "Fetches mock API data",
        type: "observed_episode",
        evidenceEventIds: ["ev-01"],
        input: { url: "https://api.github.com/repos/tool-evolver" },
        virtualState: {
          net: {
            routes: {
              "https://api.github.com/repos/tool-evolver": {
                status: 200,
                body: { name: "tool-evolver", stars: 100 },
              },
            },
          },
        },
        invariants: [
          {
            id: "inv-output",
            name: "Output Schema",
            type: "output_schema",
            description: "Matches schema",
            severity: "critical",
          },
        ],
        allowedBrokerOperations: [
          {
            service: "net",
            operation: "fetch",
            urlPattern: "https://api.github.com/.*",
          },
        ],
        baselineMetrics: {
          stepCount: 2,
          totalTokens: 250,
          totalDurationMs: 600,
          toolCallsCount: 2,
          estimatedCostUsd: 0.00075,
        },
      };

      const result = await runner.runScenario(candidate, scenario);

      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
      expect(result.executionTrace.toolOutput).toMatchObject({ status: 200, ok: true });
    });

    it("executes command candidate against simulated command outcomes", async () => {
      const candidate = createMockCandidateRevision(
        CMD_RUN_CANDIDATE_SOURCE,
        { name: "cmd_runner" },
        {
          command: {
            allowShellExecution: true,
            allowedCommands: [".*"],
            denyCommands: [],
            defaultTimeoutMs: 10000,
            maxOutputBytes: 1048576,
          },
        },
      );

      const scenario: ReplayScenario = {
        id: "sc-cmd-01",
        name: "Cmd Runner Test",
        description: "Executes mock command",
        type: "observed_episode",
        evidenceEventIds: ["ev-01"],
        input: { command: "pnpm test" },
        virtualState: {
          cmd: {
            commands: {
              "pnpm test": {
                stdout: "50 tests passed",
                stderr: "",
                exitCode: 0,
              },
            },
          },
        },
        invariants: [
          {
            id: "inv-output",
            name: "Output Schema",
            type: "output_schema",
            description: "Matches schema",
            severity: "critical",
          },
        ],
        allowedBrokerOperations: [
          {
            service: "cmd",
            operation: "exec",
            commandPattern: "pnpm test",
          },
        ],
        baselineMetrics: {
          stepCount: 2,
          totalTokens: 200,
          totalDurationMs: 700,
          toolCallsCount: 2,
          estimatedCostUsd: 0.0006,
        },
      };

      const result = await runner.runScenario(candidate, scenario);

      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
      expect(result.executionTrace.toolOutput).toMatchObject({ exitCode: 0, success: true });
    });
  });

  describe("Security & Side-Effect Containment", () => {
    it("flags hard terminal divergence when candidate attempts unauthorized operations", async () => {
      const unauthorizedCandidate = createMockCandidateRevision(UNAUTHORIZED_FS_CANDIDATE_SOURCE, {
        name: "unauthorized_writer",
      });

      const scenario: ReplayScenario = {
        id: "sc-sec-01",
        name: "Security Violation Test",
        description: "Tests detection of unauthorized file writes",
        type: "observed_episode",
        evidenceEventIds: ["ev-01"],
        input: { filePath: "/workspace/safe.txt" },
        virtualState: {
          fs: { files: { "/workspace/safe.txt": "data" } },
        },
        invariants: [
          {
            id: "inv-side-effects",
            name: "Side Effects",
            type: "side_effect_containment",
            description: "No unauthorized writes",
            severity: "critical",
          },
        ],
        allowedBrokerOperations: [
          {
            service: "fs",
            operation: "*",
            pathPattern: "/workspace/.*", // /etc/shadow is forbidden
          },
        ],
        baselineMetrics: {
          stepCount: 1,
          totalTokens: 100,
          totalDurationMs: 200,
          toolCallsCount: 1,
          estimatedCostUsd: 0.0003,
        },
      };

      const result = await runner.runScenario(unauthorizedCandidate, scenario);

      expect(result.status).toBe("terminal_divergence");
      expect(result.passed).toBe(false);
      expect(result.divergenceFindings.some((f) => f.category === "unauthorized_side_effect")).toBe(
        true,
      );
    });
  });

  describe("Idempotency & Seed Stability", () => {
    it("produces identical execution traces and metrics given deterministic seed", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const scenario: ReplayScenario = {
        id: "sc-idempotency-01",
        name: "Idempotency Test",
        description: "Verifies repeatable runs",
        type: "observed_episode",
        evidenceEventIds: ["ev-01"],
        input: { a: 7, b: 3 },
        virtualState: {},
        invariants: [],
        allowedBrokerOperations: [],
        baselineMetrics: {
          stepCount: 2,
          totalTokens: 200,
          totalDurationMs: 400,
          toolCallsCount: 2,
          estimatedCostUsd: 0.0006,
        },
      };

      const res1 = await runner.runScenario(candidate, scenario, { seed: 9999 });
      const res2 = await runner.runScenario(candidate, scenario, { seed: 9999 });

      expect(res1.executionTrace.toolOutput).toEqual(res2.executionTrace.toolOutput);
      expect(res1.executionTrace.operations).toEqual(res2.executionTrace.operations);
      expect(res1.status).toEqual(res2.status);
    });
  });

  describe("Parallel Execution & Fail-Fast", () => {
    it("runs multiple scenarios with bounded concurrency and summarizes results", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const scenarios: ReplayScenario[] = [
        {
          id: "sc-multi-01",
          name: "Scenario 1",
          description: "Multi 1",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 1, b: 2 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
        },
        {
          id: "sc-multi-02",
          name: "Scenario 2",
          description: "Multi 2",
          type: "counterfactual",
          evidenceEventIds: ["ev-01"],
          input: { a: 3, b: 4 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
        },
      ];

      const overall = await runner.runScenarios(candidate, scenarios, {
        maxParallelScenarios: 2,
        seed: 42,
      });

      expect(overall.status).toBe("pass");
      expect(overall.passed).toBe(true);
      expect(overall.passedScenarioCount).toBe(2);
      expect(overall.totalScenarioCount).toBe(2);
      expect(overall.overallMetrics.stepReductionCount).toBe(2);
    });
  });

  describe("Workload Benchmark Threading (external & scenario-derived)", () => {
    const makeMetrics = (overrides: Partial<ModelUsageMetrics> = {}): ModelUsageMetrics => ({
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

    const calcCost = (m: ModelUsageMetrics): number =>
      (m.inputTokens * 1 + m.outputTokens * 4 + m.cacheReadTokens * 0.25) / 1_000_000;

    const makeBenchmark = (
      workloadSize: "small" | "medium" | "large",
      baselineOverrides: Partial<ModelUsageMetrics> = {},
      candidateOverrides: Partial<ModelUsageMetrics> = {},
    ): WorkloadBenchmarkComparison => {
      const baseline = makeMetrics({ ...baselineOverrides });
      const candidate = makeMetrics({ ...candidateOverrides, correct: true, redundantToolCalls: 0 });
      const baselineCostUsd = calcCost(baseline);
      const candidateCostUsd = calcCost(candidate);
      return {
        workloadSize,
        baseline,
        candidate,
        baselineCostUsd,
        candidateCostUsd,
        costDeltaPercent:
          baselineCostUsd === 0 ? 0 : ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100,
        correctnessPassed: candidate.correct,
        redundantVerificationCalls: candidate.redundantToolCalls,
      };
    };

    it("valid external three-size benchmarks survive replay exactly and are sorted", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const scenarios: ReplayScenario[] = [
        {
          id: "sc-bench-ext-01",
          name: "Bench Ext",
          description: "ext bench",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 1, b: 1 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
        },
      ];

      // Provide unsorted externally measured benchmarks (large, small, medium) to test sorting
      const large = makeBenchmark("large", { inputTokens: 3000 }, { inputTokens: 1500 });
      const small = makeBenchmark("small", { inputTokens: 1000 }, { inputTokens: 800 });
      const medium = makeBenchmark("medium", { inputTokens: 2000 }, { inputTokens: 1200 });
      const unsorted = [large, small, medium];

      const result = await runner.runScenarios(candidate, scenarios, {
        workloadBenchmarks: unsorted,
      } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] });

      expect(result.workloadBenchmarks).toBeDefined();
      expect(result.workloadBenchmarks!.length).toBe(3);
      // Should be sorted small -> medium -> large deterministically
      expect(result.workloadBenchmarks!.map((b) => b.workloadSize)).toEqual([
        "small",
        "medium",
        "large",
      ]);
      // Should survive exactly (same values) without fabrication
      expect(result.workloadBenchmarks![0]!.baseline.inputTokens).toBe(1000);
      expect(result.workloadBenchmarks![1]!.baseline.inputTokens).toBe(2000);
      expect(result.workloadBenchmarks![2]!.baseline.inputTokens).toBe(3000);
      expect(result.workloadBenchmarks![0]!.candidate.inputTokens).toBe(800);
      // No extra fabrication: length stays 3
    });

    it("scenario-derived metrics produce comparisons via workloadSize/baselineModelUsage and trace modelUsage", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const baselineSmall = makeMetrics({ inputTokens: 2000, outputTokens: 1000, wallTimeMs: 2000 });
      const baselineMedium = makeMetrics({ inputTokens: 4000, outputTokens: 2000, wallTimeMs: 3000 });
      const candidateUsage = makeMetrics({ inputTokens: 800, outputTokens: 400, wallTimeMs: 900, toolCalls: 2, redundantToolCalls: 0 });
      const scenarios: ReplayScenario[] = [
        {
          id: "sc-derived-small",
          name: "Derived Small",
          description: "small workload",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 1, b: 2 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
          workloadSize: "small",
          baselineModelUsage: baselineSmall,
        },
        {
          id: "sc-derived-medium",
          name: "Derived Medium",
          description: "medium workload",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 3, b: 4 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
          workloadSize: "medium",
          baselineModelUsage: baselineMedium,
        },
      ];

      // Inject canonical trace.modelUsage via stubbed sandbox (explicit executor telemetry, no synthesis)
      const { ValidationSandbox } = await import("../../../src/evolution/testing/validation-sandbox.js");
      const realSandbox = new ValidationSandbox();
      const stubSandbox = {
        executeCandidate: async (...args: Parameters<ValidationSandbox["executeCandidate"]>) => {
          const res = await realSandbox.executeCandidate(...args);
          return { ...res, modelUsage: candidateUsage } as typeof res & { modelUsage: ModelUsageMetrics };
        },
      } as unknown as ValidationSandbox;
      const { ReplayTraceComparator } = await import("../../../src/evolution/replay/comparator.js");
      const stubRunner = new HistoricalReplayRunner({ sandbox: stubSandbox, comparator: new ReplayTraceComparator() });

      const result = await stubRunner.runScenarios(candidate, scenarios, {});

      expect(result.workloadBenchmarks).toBeDefined();
      expect(result.workloadBenchmarks!.length).toBe(2);
      const sizes = result.workloadBenchmarks!.map((b) => b.workloadSize).sort();
      expect(sizes).toEqual(["medium", "small"]);
      for (const bench of result.workloadBenchmarks!) {
        expect(bench.baseline).toBeDefined();
        expect(bench.candidate).toBeDefined();
        expect(typeof bench.baselineCostUsd).toBe("number");
        expect(typeof bench.candidateCostUsd).toBe("number");
        expect(Number.isFinite(bench.baselineCostUsd)).toBe(true);
        expect(Number.isFinite(bench.candidateCostUsd)).toBe(true);
        expect(typeof bench.correctnessPassed).toBe("boolean");
        expect(typeof bench.redundantVerificationCalls).toBe("number");
      }
    });

    it("invalid rows fail closed (negative tokens)", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const scenarios: ReplayScenario[] = [
        {
          id: "sc-invalid-01",
          name: "Invalid",
          description: "invalid",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 1, b: 1 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
        },
      ];
      const invalid = makeBenchmark("small");
      (invalid.baseline as unknown as { inputTokens: number }).inputTokens = -5;

      await expect(
        runner.runScenarios(candidate, scenarios, {
          workloadBenchmarks: [invalid],
        } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] }),
      ).rejects.toThrow(/inputTokens/);
    });

    it("invalid rows fail closed (non-finite cost)", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const scenarios: ReplayScenario[] = [
        {
          id: "sc-invalid-02",
          name: "Invalid2",
          description: "invalid2",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 1, b: 1 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
        },
      ];
      const invalid = makeBenchmark("small");
      (invalid as unknown as { baselineCostUsd: number }).baselineCostUsd = Infinity;

      await expect(
        runner.runScenarios(candidate, scenarios, {
          workloadBenchmarks: [invalid],
        } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] }),
      ).rejects.toThrow(/baselineCostUsd/);
    });

    it("duplicate rows fail closed within external", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const scenarios: ReplayScenario[] = [
        {
          id: "sc-dup-01",
          name: "Dup",
          description: "dup",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 1, b: 1 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
        },
      ];
      const b1 = makeBenchmark("small");
      const b2 = makeBenchmark("small", { inputTokens: 5000 }, { inputTokens: 1000 });

      await expect(
        runner.runScenarios(candidate, scenarios, {
          workloadBenchmarks: [b1, b2],
        } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] }),
      ).rejects.toThrow(/duplicate/i);
    });

    it("duplicate across scenario-derived and explicit fails closed", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const baseline = makeMetrics({ inputTokens: 2000 });
      const candidateUsage = makeMetrics({ inputTokens: 800, outputTokens: 400, wallTimeMs: 900 });
      const scenarios: ReplayScenario[] = [
        {
          id: "sc-dup-cross-01",
          name: "Dup Cross",
          description: "dup cross",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 1, b: 1 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
          workloadSize: "small",
          baselineModelUsage: baseline,
        },
      ];
      const externalSmall = makeBenchmark("small", { inputTokens: 9999 }, { inputTokens: 1111 });

      const { ValidationSandbox } = await import("../../../src/evolution/testing/validation-sandbox.js");
      const realSandbox = new ValidationSandbox();
      const stubSandbox = {
        executeCandidate: async (...args: Parameters<ValidationSandbox["executeCandidate"]>) => {
          const res = await realSandbox.executeCandidate(...args);
          return { ...res, modelUsage: candidateUsage } as typeof res & { modelUsage: ModelUsageMetrics };
        },
      } as unknown as ValidationSandbox;
      const { ReplayTraceComparator } = await import("../../../src/evolution/replay/comparator.js");
      const stubRunner = new HistoricalReplayRunner({ sandbox: stubSandbox, comparator: new ReplayTraceComparator() });

      await expect(
        stubRunner.runScenarios(candidate, scenarios, {
          workloadBenchmarks: [externalSmall],
        } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] }),
      ).rejects.toThrow(/duplicate/i);
    });

    it("ordinary legacy replay remains unchanged (no workloadBenchmarks)", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const scenarios: ReplayScenario[] = [
        {
          id: "sc-legacy-01",
          name: "Legacy",
          description: "legacy",
          type: "observed_episode",
          evidenceEventIds: ["ev-01"],
          input: { a: 2, b: 3 },
          virtualState: {},
          invariants: [],
          allowedBrokerOperations: [],
          baselineMetrics: {
            stepCount: 2,
            totalTokens: 100,
            totalDurationMs: 300,
            toolCallsCount: 2,
            estimatedCostUsd: 0.0003,
          },
        },
      ];

      const result = await runner.runScenarios(candidate, scenarios, {});
      expect(result.workloadBenchmarks).toBeUndefined();
      // Ensure existing contracts unchanged
      expect(result.status).toBe("pass");
      expect(result.overallMetrics).toBeDefined();
      expect(result.scenarioResults.length).toBe(1);
    });
  });
});
