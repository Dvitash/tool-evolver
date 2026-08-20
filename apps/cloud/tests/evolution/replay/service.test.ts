import { describe, expect, it } from "vitest";
import {
  HistoricalReplayService,
  createHistoricalReplayService,
} from "../../../src/evolution/replay/service.js";
import type { TenantContext } from "../../../src/tenant.js";
import type {
  ModelUsageMetrics,
  WorkloadBenchmarkComparison,
} from "../../../src/evolution/replay/types.js";
import {
  FS_SEARCH_CANDIDATE_SOURCE,
  PURE_COMPUTE_CANDIDATE_SOURCE,
  UNAUTHORIZED_FS_CANDIDATE_SOURCE,
  createMockCandidateRevision,
  createMockEpisode,
  createMockResolvedEvidenceSet,
} from "./helpers.js";

describe("HistoricalReplayService (End-to-End Replay Engine)", () => {
  const tenant: TenantContext = {
    accountId: "acc-test",
    workspaceId: "ws-test",
  };

  const service = createHistoricalReplayService();

  describe("End-to-End Historical Replay Execution", () => {
    it("replays filesystem search candidate against evidence set and returns pass with metrics savings", async () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const result = await service.replayCandidate(tenant, {
        candidate,
        evidence,
        options: {
          includeCounterfactualScenarios: true,
          includeNegativeScenarios: true,
          seed: 42,
        },
      });
      expect(result.status).toBe("pass");
      expect(result.passed).toBe(true);
      expect(result.totalScenarioCount).toBeGreaterThanOrEqual(2);
      expect(result.passedScenarioCount).toBe(result.totalScenarioCount);

      // Verify metrics comparison
      expect(result.overallMetrics.stepReductionCount).toBeGreaterThan(0);
      expect(result.overallMetrics.stepReductionPercent).toBeGreaterThan(0);
      expect(result.overallMetrics.tokenSavingsPercent).toBeGreaterThan(0);
      expect(result.summary).toContain("Replay completed with status 'pass'");
    });

    it("replays pure compute candidate against an episode", async () => {
      const episode = createMockEpisode();
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE, {
        name: "compute_stats",
        parameters: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
        },
        outputSchema: {
          type: "object",
          properties: { sum: { type: "number" }, product: { type: "number" } },
        },
      });

      const result = await service.replayCandidate(tenant, {
        candidate,
        evidence: episode,
      });
      expect(result.status).toBe("pass");
      expect(result.scenarioResults.length).toBeGreaterThan(0);
    });

    it("flags terminal divergence on unauthorized candidate side effects", async () => {
      const evidence = createMockResolvedEvidenceSet();
      const unauthorizedCandidate = createMockCandidateRevision(
        UNAUTHORIZED_FS_CANDIDATE_SOURCE,
        { name: "unauthorized_writer" },
        {
          fs: {
            readPaths: ["/workspace/.*"],
            writePaths: ["/workspace/.*"], // Forbidden to write /etc/shadow
            allowWorkspaceRoot: true,
            allowTemp: false,
            denyPaths: ["/etc/.*"],
            maxFileSizeBytes: 1048576,
          },
        },
      );

      const result = await service.replayCandidate(tenant, {
        candidate: unauthorizedCandidate,
        evidence,
      });

      expect(result.status).toBe("terminal_divergence");
      expect(result.passed).toBe(false);
      expect(result.divergenceFindings.some((f) => f.category === "unauthorized_side_effect")).toBe(
        true,
      );
    });

    it("throws clear error when neither evidence nor valid evidenceSetId is supplied", async () => {
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      await expect(
        service.replayCandidate(tenant, {
          candidate,
        }),
      ).rejects.toThrow("No evidence source provided");
    });
  });

  describe("Scenario Building & Single Scenario Execution Helpers", () => {
    it("builds scenarios without executing them", () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = service.buildScenarios(evidence, candidate);
      expect(scenarios.length).toBeGreaterThan(0);
      expect(scenarios[0]!.type).toBe("observed_episode");
    });

    it("executes single pre-built scenario", async () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const scenarios = service.buildScenarios(evidence, candidate);
      const singleScenario = scenarios[0]!;

      const executionResult = await service.executeSingleScenario(candidate, singleScenario);
      expect(executionResult.status).toBe("pass");
      expect(executionResult.passed).toBe(true);
    });
  });

  describe("Workload Benchmark External & Legacy Handling via Service", () => {
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
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);

      const large = makeBenchmark("large", { inputTokens: 3000 }, { inputTokens: 1500 });
      const small = makeBenchmark("small", { inputTokens: 1000 }, { inputTokens: 800 });
      const medium = makeBenchmark("medium", { inputTokens: 2000 }, { inputTokens: 1200 });
      const unsorted = [large, small, medium];

      const result = await service.replayCandidate(tenant, {
        candidate,
        evidence,
        options: {
          workloadBenchmarks: unsorted,
        } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] },
      });

      expect(result.workloadBenchmarks).toBeDefined();
      expect(result.workloadBenchmarks!.length).toBe(3);
      expect(result.workloadBenchmarks!.map((b) => b.workloadSize)).toEqual([
        "small",
        "medium",
        "large",
      ]);
      expect(result.workloadBenchmarks![0]!.baseline.inputTokens).toBe(1000);
      expect(result.workloadBenchmarks![2]!.baseline.inputTokens).toBe(3000);
    });

    it("invalid external rows fail closed (negative tokens) via service", async () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const invalid = makeBenchmark("small");
      (invalid.baseline as unknown as { inputTokens: number }).inputTokens = -10;

      await expect(
        service.replayCandidate(tenant, {
          candidate,
          evidence,
          options: {
            workloadBenchmarks: [invalid],
          } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] },
        }),
      ).rejects.toThrow(/inputTokens/);
    });

    it("invalid external rows fail closed (non-finite cost) via service", async () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const invalid = makeBenchmark("small");
      (invalid as unknown as { candidateCostUsd: number }).candidateCostUsd = NaN;

      await expect(
        service.replayCandidate(tenant, {
          candidate,
          evidence,
          options: {
            workloadBenchmarks: [invalid],
          } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] },
        }),
      ).rejects.toThrow(/candidateCostUsd/);
    });

    it("duplicate external rows fail closed via service", async () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const b1 = makeBenchmark("small");
      const b2 = makeBenchmark("small", { inputTokens: 5000 }, { inputTokens: 1000 });

      await expect(
        service.replayCandidate(tenant, {
          candidate,
          evidence,
          options: {
            workloadBenchmarks: [b1, b2],
          } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] },
        }),
      ).rejects.toThrow(/duplicate/i);
    });

    it("ordinary legacy replay via service remains unchanged (no workloadBenchmarks)", async () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(FS_SEARCH_CANDIDATE_SOURCE);

      const result = await service.replayCandidate(tenant, {
        candidate,
        evidence,
      });

      expect(result.workloadBenchmarks).toBeUndefined();
      expect(result.status).toBe("pass");
      expect(result.scenarioResults.length).toBeGreaterThan(0);
    });

    it("does not fabricate missing workload benchmarks when only one size provided", async () => {
      const evidence = createMockResolvedEvidenceSet();
      const candidate = createMockCandidateRevision(PURE_COMPUTE_CANDIDATE_SOURCE);
      const single = makeBenchmark("medium");

      const result = await service.replayCandidate(tenant, {
        candidate,
        evidence,
        options: {
          workloadBenchmarks: [single],
        } as unknown as { workloadBenchmarks: WorkloadBenchmarkComparison[] },
      });

      expect(result.workloadBenchmarks).toBeDefined();
      expect(result.workloadBenchmarks!.length).toBe(1);
      expect(result.workloadBenchmarks![0]!.workloadSize).toBe("medium");
    });
  });
});
