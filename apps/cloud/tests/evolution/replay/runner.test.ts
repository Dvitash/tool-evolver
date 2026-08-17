import { describe, expect, it } from "vitest";
import { HistoricalReplayRunner } from "../../../src/evolution/replay/runner.js";
import type { ReplayScenario } from "../../../src/evolution/replay/types.js";
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
              "/workspace/src/app.ts": "const target1 = true;\nconst other = false;\nconst target2 = true;\n",
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
        }
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
        }
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
      expect(result.divergenceFindings.some((f) => f.category === "unauthorized_side_effect")).toBe(true);
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
          baselineMetrics: { stepCount: 2, totalTokens: 100, totalDurationMs: 300, toolCallsCount: 2, estimatedCostUsd: 0.0003 },
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
          baselineMetrics: { stepCount: 2, totalTokens: 100, totalDurationMs: 300, toolCallsCount: 2, estimatedCostUsd: 0.0003 },
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
});
