import { describe, expect, it } from "vitest";
import { ReplayScenarioBuilder } from "../../../src/evolution/replay/scenario-builder.js";
import {
  FS_SEARCH_CANDIDATE_SOURCE,
  PURE_COMPUTE_CANDIDATE_SOURCE,
  createMockCandidateRevision,
  createMockEpisode,
  createMockResolvedEvidenceSet,
  createMockWorkflowEvents,
} from "./helpers.js";

describe("ReplayScenarioBuilder", () => {
  const builder = new ReplayScenarioBuilder();

  describe("Deterministic Scenario Construction", () => {
    it("constructs replay scenarios referencing exact evidence event IDs and revision", () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = builder.buildScenarios(evidence, candidate);

      expect(scenarios.length).toBeGreaterThanOrEqual(1);

      // Verify primary scenario
      const primary = scenarios.find((s) => s.type === "observed_episode");
      expect(primary).toBeDefined();
      expect(primary!.evidenceEventIds).toEqual(["ev-01", "ev-02", "ev-03", "ev-04", "ev-05"]);
      expect(primary!.evidenceRevision).toBe(1);
      expect(primary!.sourceEpisodeId).toBe("ev-set-01");
    });

    it("constructs scenarios from an Episode source", () => {
      const episode = createMockEpisode();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = builder.buildScenarios(episode, candidate);

      expect(scenarios.length).toBeGreaterThan(0);
      const primary = scenarios[0]!;
      expect(primary.sourceEpisodeId).toBe("ep-workflow-01");
      expect(primary.evidenceEventIds.length).toBe(5);
    });

    it("produces identical scenarios given identical seeds", () => {
      const episode = createMockEpisode();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios1 = builder.buildScenarios(episode, candidate, { seed: 12345 });
      const scenarios2 = builder.buildScenarios(episode, candidate, { seed: 12345 });

      expect(scenarios1.length).toBe(scenarios2.length);
      for (let i = 0; i < scenarios1.length; i++) {
        expect(scenarios1[i]!.id).toBe(scenarios2[i]!.id);
        expect(scenarios1[i]!.type).toBe(scenarios2[i]!.type);
        expect(scenarios1[i]!.input).toEqual(scenarios2[i]!.input);
      }
    });
  });

  describe("Input Derivation from Variable Bindings", () => {
    it("derives inputs matching candidate parameters from observed events", () => {
      const events = createMockWorkflowEvents();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = builder.buildScenarios(events, candidate);
      const primary = scenarios.find((s) => s.type === "observed_episode")!;

      expect(primary.input).toEqual({
        filePath: "/workspace/src/index.ts",
        query: "export",
      });
    });

    it("populates virtual broker filesystem with observed file contents", () => {
      const events = createMockWorkflowEvents();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = builder.buildScenarios(events, candidate);
      const primary = scenarios.find((s) => s.type === "observed_episode")!;

      expect(primary.virtualState.fs?.files).toBeDefined();
      expect(primary.virtualState.fs?.files?.["/workspace/src/index.ts"]).toContain(
        "export const a = 1;",
      );
    });
  });

  describe("Baseline Metrics Calculation", () => {
    it("accurately extracts step count, duration, and token metrics from episode", () => {
      const events = createMockWorkflowEvents();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = builder.buildScenarios(events, candidate);
      const primary = scenarios[0]!;

      expect(primary.baselineMetrics.stepCount).toBeGreaterThanOrEqual(1);
      expect(primary.baselineMetrics.totalTokens).toBeGreaterThan(0);
      expect(primary.baselineMetrics.totalDurationMs).toBeGreaterThan(0);
      expect(primary.baselineMetrics.toolCallsCount).toBeGreaterThanOrEqual(1);
      expect(primary.baselineMetrics.estimatedCostUsd).toBeGreaterThan(0);
    });
  });

  describe("Invariants Formulation", () => {
    it("formulates output schema, side-effect containment, and semantic equality invariants", () => {
      const events = createMockWorkflowEvents();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = builder.buildScenarios(events, candidate);
      const primary = scenarios.find((s) => s.type === "observed_episode")!;

      const invariantTypes = primary.invariants.map((i) => i.type);
      expect(invariantTypes).toContain("output_schema");
      expect(invariantTypes).toContain("side_effect_containment");
      expect(invariantTypes).toContain("no_unauthorized_mutations");
      expect(invariantTypes).toContain("semantic_equality");
    });
  });

  describe("Counterfactual and Negative Scenario Synthesis", () => {
    it("synthesizes counterfactual scenario with perturbed input and state", () => {
      const events = createMockWorkflowEvents();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = builder.buildScenarios(events, candidate, {
        includeCounterfactualScenarios: true,
      });

      const cf = scenarios.find((s) => s.type === "counterfactual");
      expect(cf).toBeDefined();
      expect(cf!.input).toBeDefined();
      expect(cf!.invariants.some((i) => i.type === "output_schema")).toBe(true);
    });

    it("synthesizes negative scenarios (missing file, permission error, network, cmd, malformed input)", () => {
      const events = createMockWorkflowEvents();
      const candidate = createMockCandidateRevision(
        FS_SEARCH_CANDIDATE_SOURCE,
        {},
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
          command: {
            allowShellExecution: true,
            allowedCommands: [".*"],
            denyCommands: [],
            defaultTimeoutMs: 10000,
            maxOutputBytes: 1048576,
          },
        },
      );

      const scenarios = builder.buildScenarios(events, candidate, {
        includeNegativeScenarios: true,
      });

      const types = scenarios.map((s) => s.type);
      expect(types).toContain("negative_missing_file");
      expect(types).toContain("negative_permission_error");
      expect(types).toContain("negative_network_error");
      expect(types).toContain("negative_command_failure");
      expect(types).toContain("negative_malformed_input");

      const missingFileScenario = scenarios.find((s) => s.type === "negative_missing_file")!;
      expect(missingFileScenario.expectedOutcome).toBe("error");
      expect(missingFileScenario.virtualState.fs?.simulateErrors).toBeDefined();
    });

    it("respects exclusion flags for negative and counterfactual scenarios", () => {
      const events = createMockWorkflowEvents();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = builder.buildScenarios(events, candidate, {
        includeCounterfactualScenarios: false,
        includeNegativeScenarios: false,
      });

      expect(scenarios.length).toBe(1);
      expect(scenarios[0]!.type).toBe("observed_episode");
    });
  });
});

describe("command authorization pattern", () => {
  it("matches allowed binaries at a word boundary (regression: \\s in template literal)", () => {
    const builder = new ReplayScenarioBuilder();
    const candidate = createMockCandidateRevision(
      'import { defineTool } from "@tool-evolver/runtime"; export default defineTool(async (context) => { const r = await context.broker.cmd.exec("git", ["status", "--porcelain"]); return { success: r.exitCode === 0 }; });',
      {},
      {
        command: {
          allowShellExecution: false,
          allowedCommands: ["git log --oneline -5 && git status --porcelain"],
          allowedBinaries: ["git"],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
      },
    );
    const scenarios = builder.buildScenarios(createMockResolvedEvidenceSet(), candidate);
    const cmdOps = scenarios
      .flatMap((s) => s.allowedBrokerOperations)
      .filter((o) => o.service === "cmd");
    expect(cmdOps.length).toBeGreaterThan(0);
    const pattern = cmdOps[0]!.commandPattern!;
    // Must not contain a mangled escape ("(?:s|$)" instead of "(?:\\s|$)").
    expect(pattern).toContain("(?:\\s|$)");
    const re = new RegExp(pattern);
    expect(re.test("git log --oneline -5")).toBe(true);
    expect(re.test("git status --porcelain")).toBe(true);
    expect(re.test("git")).toBe(true);
    expect(re.test("gitsum")).toBe(false);
    expect(re.test("curl https://example.com")).toBe(false);
  });
});

describe("negative malformed-input scenario gating", () => {
  const builder2 = new ReplayScenarioBuilder();

  it("skips malformed-input scenario for zero-parameter tools", () => {
    const candidate = createMockCandidateRevision(
      'import { defineTool } from "@tool-evolver/runtime"; export default defineTool(async (context) => { const r = await context.broker.cmd.exec("git", ["status"]); return { success: r.exitCode === 0 }; });',
      { parameters: { type: "object", properties: {}, additionalProperties: false } },
    );
    const scenarios = builder2.buildScenarios(createMockResolvedEvidenceSet(), candidate);
    expect(scenarios.some((s) => s.type === "negative_malformed_input")).toBe(false);
  });

  it("keeps malformed-input scenario when inputs are declared", () => {
    const candidate = createMockCandidateRevision(
      'import { defineTool } from "@tool-evolver/runtime"; export default defineTool(async (context) => { const r = await context.broker.cmd.exec("git", ["status"]); return { success: r.exitCode === 0 }; });',
      {
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    );
    const scenarios = builder2.buildScenarios(createMockResolvedEvidenceSet(), candidate);
    expect(scenarios.some((s) => s.type === "negative_malformed_input")).toBe(true);
  });
});
