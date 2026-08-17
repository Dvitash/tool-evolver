import { describe, expect, it } from "vitest";
import {
  HistoricalReplayService,
  createHistoricalReplayService,
} from "../../../src/evolution/replay/service.js";
import type { TenantContext } from "../../../src/tenant.js";
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
});
