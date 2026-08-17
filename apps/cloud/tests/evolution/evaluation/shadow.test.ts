import { describe, expect, it } from "vitest";
import {
  PERMISSIVE_EVALUATION_POLICY_V1,
  SHADOW_CALIBRATION_POLICY_V1,
  STANDARD_EVALUATION_POLICY_V1,
  STRICT_EVALUATION_POLICY_V1,
} from "../../../src/evolution/evaluation/policy.js";
import {
  ShadowCalibrationAggregator,
  ShadowPolicyEvaluator,
} from "../../../src/evolution/evaluation/shadow.js";
import type { EvaluationDecisionRecord } from "../../../src/evolution/evaluation/types.js";
import {
  createMockCandidateRevision,
  createMockReplayResult,
  createMockValidationResult,
} from "./helpers.js";

describe("ShadowPolicyEvaluator & ShadowCalibrationAggregator", () => {
  const evaluator = new ShadowPolicyEvaluator();

  it("evaluates candidates under shadow policy and detects decision differences", () => {
    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult({
      testReport: {
        suiteId: "s1",
        totalTests: 10,
        passed: 10,
        failed: 0,
        timeouts: 0,
        durationMs: 100,
        results: [],
        coverage: {
          statementCount: 100,
          coveredStatements: 72,
          statementCoveragePercent: 72, // Below Strict's 85% requirement!
          branchCount: 20,
          coveredBranches: 14,
          branchCoveragePercent: 70,
          functionCount: 10,
          coveredFunctions: 8,
          functionCoveragePercent: 80,
        },
      },
      coverage: {
        statementCount: 100,
        coveredStatements: 72,
        statementCoveragePercent: 72,
        branchCount: 20,
        coveredBranches: 14,
        branchCoveragePercent: 70,
        functionCount: 10,
        coveredFunctions: 8,
        functionCoveragePercent: 80,
      },
    });

    const replayResult = createMockReplayResult({
      totalScenarioCount: 2,
      passedScenarioCount: 2,
    });

    const activeDecisionRecord: EvaluationDecisionRecord = {
      evaluationId: "eval-active-1",
      candidateId: candidate.candidateId,
      toolId: candidate.artifacts.manifest.id,
      toolVersion: candidate.artifacts.manifest.version,
      policyId: STANDARD_EVALUATION_POLICY_V1.policyId,
      policyVersion: STANDARD_EVALUATION_POLICY_V1.version,
      riskTier: "read_only",
      decision: "eligible_for_artifact",
      verdict: "pass",
      compositeScore: 0.88,
      confidenceScore: 0.8,
      thresholdScore: 0.7,
      hardGateResult: {
        passed: true,
        failedGates: [],
        gateResults: [],
        canRepair: true,
      },
      dimensionScores: [],
      digest: "sha-1",
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 50,
    };

    const shadowResults = evaluator.evaluateShadowPolicies(
      {
        candidate,
        validationResult,
        replayResult,
        policy: STANDARD_EVALUATION_POLICY_V1,
      },
      activeDecisionRecord,
      [STRICT_EVALUATION_POLICY_V1, PERMISSIVE_EVALUATION_POLICY_V1],
    );

    expect(shadowResults.length).toBe(2);

    const strictShadow = shadowResults.find(
      (s) => s.shadowPolicyId === STRICT_EVALUATION_POLICY_V1.policyId,
    );
    const permissiveShadow = shadowResults.find(
      (s) => s.shadowPolicyId === PERMISSIVE_EVALUATION_POLICY_V1.policyId,
    );

    expect(strictShadow).toBeDefined();
    expect(permissiveShadow).toBeDefined();
    expect(strictShadow?.shadowPolicyId).toBe("strict-policy");
  });

  it("aggregates multiple shadow runs and calculates agreement metrics and false rates", () => {
    const aggregator = new ShadowCalibrationAggregator();
    const shadowPolicy = SHADOW_CALIBRATION_POLICY_V1;

    // Run 1: Agreement
    const active1: EvaluationDecisionRecord = {
      evaluationId: "e1",
      candidateId: "c1",
      toolId: "t1",
      toolVersion: "1.0.0",
      policyId: "standard-policy",
      policyVersion: "1.0.0",
      riskTier: "read_only",
      decision: "eligible_for_artifact",
      verdict: "pass",
      compositeScore: 0.85,
      confidenceScore: 0.8,
      thresholdScore: 0.7,
      hardGateResult: { passed: true, failedGates: [], gateResults: [], canRepair: true },
      dimensionScores: [],
      digest: "d1",
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 20,
    };

    aggregator.record("c1", active1, {
      shadowPolicyId: shadowPolicy.policyId,
      shadowPolicyVersion: shadowPolicy.version,
      decision: "eligible_for_artifact",
      verdict: "pass",
      compositeScore: 0.86,
      confidenceScore: 0.82,
      hardGatePassed: true,
      agreementWithActive: true,
      scoreDeltaWithActive: 0.01,
      differingDimensions: [],
      differingGates: [],
    });

    // Run 2: Disagreement (Active passed, Shadow rejected due to stricter threshold -> False negative from shadow perspective)
    const active2: EvaluationDecisionRecord = {
      ...active1,
      evaluationId: "e2",
      candidateId: "c2",
      compositeScore: 0.72,
    };

    aggregator.record("c2", active2, {
      shadowPolicyId: shadowPolicy.policyId,
      shadowPolicyVersion: shadowPolicy.version,
      decision: "repair_requested",
      verdict: "conditional",
      compositeScore: 0.71,
      confidenceScore: 0.7,
      hardGatePassed: true,
      agreementWithActive: false,
      scoreDeltaWithActive: -0.01,
      differingDimensions: ["maintainability"],
      differingGates: [],
    });

    const report = aggregator.generateReport(shadowPolicy.policyId, shadowPolicy.version);

    expect(report.sampleCount).toBe(2);
    expect(report.agreementCount).toBe(1);
    expect(report.agreementRate).toBe(0.5);
    expect(report.falseNegativeCount).toBe(1);
    expect(report.falsePositiveCount).toBe(0);
    expect(report.disagreements.length).toBe(1);
    expect(report.disagreements[0].candidateId).toBe("c2");
  });
});
