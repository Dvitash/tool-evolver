import { describe, expect, it } from "vitest";
import {
  STANDARD_EVALUATION_POLICY_V1,
  STRICT_EVALUATION_POLICY_V1,
} from "../../../src/evolution/evaluation/policy.js";
import { CandidateScorer } from "../../../src/evolution/evaluation/scorer.js";
import {
  createMockCandidateRevision,
  createMockOpportunity,
  createMockReplayResult,
  createMockToolManifest,
  createMockValidationResult,
} from "./helpers.js";

describe("CandidateScorer (Multi-Dimensional Quality, Safety & Economics Scoring)", () => {
  const scorer = new CandidateScorer();
  const policy = STANDARD_EVALUATION_POLICY_V1;

  it("evaluates all 9 required scoring dimensions", () => {
    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult();
    const replayResult = createMockReplayResult();
    const opportunity = createMockOpportunity();

    const result = scorer.score({
      manifest: candidate.artifacts.manifest,
      sourceCode: candidate.artifacts.sourceCode,
      requiredCapabilities: candidate.artifacts.capabilities,
      validationResult,
      replayResult,
      opportunity,
      policy,
    });

    const dimensionKeys = result.dimensionScores.map((d) => d.dimension);
    expect(dimensionKeys).toContain("correctness");
    expect(dimensionKeys).toContain("replay_coverage");
    expect(dimensionKeys).toContain("security_policy_fit");
    expect(dimensionKeys).toContain("reliability");
    expect(dimensionKeys).toContain("latency_resources");
    expect(dimensionKeys).toContain("token_savings");
    expect(dimensionKeys).toContain("time_savings");
    expect(dimensionKeys).toContain("utility_recurrence");
    expect(dimensionKeys).toContain("maintainability");

    expect(result.compositeScore).toBeGreaterThanOrEqual(0.85);
    expect(result.confidenceScore).toBeGreaterThanOrEqual(0.7);
    expect(result.passed).toBe(true);
  });

  it("applies uncertainty penalties when replay scenario count is small", () => {
    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult();
    const opportunity = createMockOpportunity();

    // Replay with only 1 scenario
    const replay1 = createMockReplayResult({
      totalScenarioCount: 1,
      passedScenarioCount: 1,
      scenarioResults: [
        {
          scenarioId: "sc-1",
          scenarioName: "sc1",
          type: "identical_inputs",
          status: "pass",
          passed: true,
          executionTrace: { steps: [], totalDurationMs: 40, totalTokens: 100 },
          invariantEvaluations: [],
          metricsComparison: {
            baselineStepCount: 2,
            candidateStepCount: 1,
            stepReductionCount: 1,
            baselineDurationMs: 100,
            candidateDurationMs: 40,
            latencyReductionMs: 60,
            baselineTokens: 400,
            candidateTokens: 100,
            tokenReductionCount: 300,
            baselineToolCalls: 2,
            candidateToolCalls: 1,
          },
          divergenceFindings: [],
          durationMs: 40,
          seed: "1",
        },
      ],
    });

    // Replay with 5 scenarios
    const replay5 = createMockReplayResult({
      totalScenarioCount: 5,
      passedScenarioCount: 5,
    });

    const result1 = scorer.score({
      manifest: candidate.artifacts.manifest,
      sourceCode: candidate.artifacts.sourceCode,
      requiredCapabilities: candidate.artifacts.capabilities,
      validationResult,
      replayResult: replay1,
      opportunity,
      policy,
    });

    const result5 = scorer.score({
      manifest: candidate.artifacts.manifest,
      sourceCode: candidate.artifacts.sourceCode,
      requiredCapabilities: candidate.artifacts.capabilities,
      validationResult,
      replayResult: replay5,
      opportunity,
      policy,
    });

    const replayDim1 = result1.dimensionScores.find((d) => d.dimension === "replay_coverage");
    const replayDim5 = result5.dimensionScores.find((d) => d.dimension === "replay_coverage");

    expect(replayDim1?.confidence).toBeLessThan(replayDim5?.confidence ?? 1.0);
    expect(result1.confidenceScore).toBeLessThan(result5.confidenceScore);
  });

  it("penalizes security score and enforces stricter thresholds for higher risk tiers", () => {
    const readOnlyManifest = createMockToolManifest(); // read_only
    const secretManifest = createMockToolManifest({
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: false,
          allowTemp: false,
          denyPaths: [],
          maxFileSizeBytes: 1048576,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedPorts: [],
          allowInsecureHttp: false,
          denyDomains: [],
          denyPrivateRanges: true,
        },
        command: {
          allowedCommands: [],
          allowEnvInheritance: false,
          denyCommands: [],
          allowPipes: false,
          maxExecutionTimeMs: 1000,
        },
        secrets: {
          allowedSecretNames: ["PROD_DB_SECRET"],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 1000,
          maxOutputSizeBytes: 1048576,
        },
      },
    }); // secret_mediated

    const validationWithWarnings = createMockValidationResult({
      staticFindings: [
        {
          severity: "warning",
          category: "static_flaw",
          message: "Potential unchecked array indexing",
        },
      ],
    });

    const replay = createMockReplayResult();

    const readOnlyResult = scorer.score({
      manifest: readOnlyManifest,
      sourceCode: "export default {}",
      requiredCapabilities: readOnlyManifest.capabilities,
      validationResult: validationWithWarnings,
      replayResult: replay,
      policy,
    });

    const secretResult = scorer.score({
      manifest: secretManifest,
      sourceCode: "export default {}",
      requiredCapabilities: secretManifest.capabilities,
      validationResult: validationWithWarnings,
      replayResult: replay,
      policy,
    });

    expect(readOnlyResult.riskTier).toBe("read_only");
    expect(secretResult.riskTier).toBe("secret_mediated");

    // Secret-mediated tier has higher required threshold score and min confidence
    expect(secretResult.thresholdScore).toBeGreaterThan(readOnlyResult.thresholdScore);
    expect(secretResult.minRequiredConfidence).toBeGreaterThan(
      readOnlyResult.minRequiredConfidence,
    );

    // Secret-mediated tier applies heavier penalty for static warnings
    const readOnlySec = readOnlyResult.dimensionScores.find(
      (d) => d.dimension === "security_policy_fit",
    );
    const secretSec = secretResult.dimensionScores.find(
      (d) => d.dimension === "security_policy_fit",
    );
    expect(secretSec?.adjustedScore).toBeLessThan(readOnlySec?.adjustedScore ?? 1.0);
  });

  it("penalizes maintainability score for bloated code lines and low coverage", () => {
    const candidate = createMockCandidateRevision({
      sourceCode: Array.from({ length: 1200 }, (_, i) => `// Line ${i}`).join("\n"),
    });

    const validationResult = createMockValidationResult({
      coverage: {
        statementCount: 100,
        coveredStatements: 45,
        statementCoveragePercent: 45,
        branchCount: 30,
        coveredBranches: 10,
        branchCoveragePercent: 33.3,
        functionCount: 20,
        coveredFunctions: 10,
        functionCoveragePercent: 50,
      },
    });

    const result = scorer.score({
      manifest: candidate.artifacts.manifest,
      sourceCode: candidate.artifacts.sourceCode,
      requiredCapabilities: candidate.artifacts.capabilities,
      validationResult,
      selfReviewIssuesCount: 3,
      policy,
    });

    const maintainability = result.dimensionScores.find((d) => d.dimension === "maintainability");
    expect(maintainability?.passed).toBe(false);
    expect(maintainability?.adjustedScore).toBeLessThan(0.5);
  });
});
