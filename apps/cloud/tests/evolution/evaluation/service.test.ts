import { describe, expect, it, vi } from "vitest";
import {
  CandidateEvaluationService,
  createCandidateEvaluationService,
} from "../../../src/evolution/evaluation/service.js";
import {
  PERMISSIVE_EVALUATION_POLICY_V1,
  SHADOW_CALIBRATION_POLICY_V1,
  STANDARD_EVALUATION_POLICY_V1,
  STRICT_EVALUATION_POLICY_V1,
} from "../../../src/evolution/evaluation/policy.js";
import {
  createMockActiveBaseline,
  createMockCandidateRevision,
  createMockEnvelope,
  createMockOpportunity,
  createMockReplayResult,
  createMockToolManifest,
  createMockValidationResult,
} from "./helpers.js";

describe("CandidateEvaluationService (Candidate Scoring, Evaluation, and Eligibility Decisions)", () => {
  it("renders 'eligible_for_artifact' on a clean, high-scoring candidate", async () => {
    const eligibilityCallback = vi.fn();
    const service = createCandidateEvaluationService({
      onEligibilityDecision: eligibilityCallback,
    });

    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult();
    const replayResult = createMockReplayResult();
    const opportunity = createMockOpportunity();
    const envelope = createMockEnvelope();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      opportunity,
      envelope,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.overallDecision.verdict).toBe("pass");
    expect(result.decisionRecord.decision).toBe("eligible_for_artifact");
    expect(result.decisionRecord.hardGateResult.passed).toBe(true);
    expect(result.decisionRecord.compositeScore).toBeGreaterThanOrEqual(0.70);
    expect(result.decisionRecord.confidenceScore).toBeGreaterThanOrEqual(0.60);
    expect(result.dimensions.length).toBeGreaterThan(0);
    expect(result.securityChecklist.typecheckPassed).toBe(true);
    expect(result.securityChecklist.noForbiddenImports).toBe(true);
    expect(result.decisionRecord.digest).toBeDefined();

    expect(eligibilityCallback).toHaveBeenCalledTimes(1);
    expect(eligibilityCallback).toHaveBeenCalledWith(result);

    // Stored in repository
    expect(service.getEvaluation(result.evaluationId)).toBeDefined();
    expect(service.listEvaluations(candidate.candidateId).length).toBe(1);
  });

  it("renders 'rejected' when non-repairable hard gates fail (e.g. terminal divergence or forbidden security breach)", async () => {
    const service = createCandidateEvaluationService();

    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult();
    const replayResult = createMockReplayResult({
      status: "terminal_divergence",
      passed: false,
      divergenceFindings: [
        {
          severity: "critical",
          category: "unauthorized_side_effect",
          scenarioId: "sc-1",
          message: "Candidate modified state outside permitted workspace boundary",
        },
      ],
    });

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.overallDecision.verdict).toBe("fail");
    expect(result.decisionRecord.decision).toBe("rejected");
    expect(result.decisionRecord.hardGateResult.passed).toBe(false);
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(false);
    expect(result.decisionRecord.hardGateResult.failedGates).toContain("replay_divergence_check");
  });

  it("renders 'repair_requested' with structured repair targets when repairable defects exist", async () => {
    const repairCallback = vi.fn();
    const service = createCandidateEvaluationService({
      onRepairRequested: repairCallback,
    });

    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult({
      typecheckPassed: false,
      typecheckErrors: ["Property 'foo' does not exist on type 'Input'"],
      repairFeedback: {
        canRepair: true,
        suggestedFixes: ["Add optional 'foo' property to input parameter schema"],
        findings: [],
        failedTestSummaries: [],
        recommendedChanges: {},
      },
    });

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.overallDecision.verdict).toBe("conditional");
    expect(result.decisionRecord.decision).toBe("repair_requested");
    expect(result.decisionRecord.hardGateResult.passed).toBe(false);
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(true);
    expect(result.decisionRecord.repairGuidance).toBeDefined();
    expect(result.decisionRecord.repairGuidance?.canRepair).toBe(true);
    expect(result.decisionRecord.repairGuidance?.repairTargets.length).toBeGreaterThan(0);
    expect(result.decisionRecord.repairGuidance?.suggestedFixes).toContain(
      "Add optional 'foo' property to input parameter schema"
    );

    expect(repairCallback).toHaveBeenCalledTimes(1);
    expect(repairCallback).toHaveBeenCalledWith(result);
  });

  it("renders 'deferred_for_more_evidence' when confidence is low due to insufficient replay coverage", async () => {
    const service = createCandidateEvaluationService();

    const candidate = createMockCandidateRevision({
      manifest: {
        capabilities: {
          fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 1048576 },
          net: { allowOutbound: true, allowedDomains: ["api.example.com"], allowedPorts: [443], allowInsecureHttp: false, denyDomains: [], denyPrivateRanges: true },
          command: { allowedCommands: [], allowEnvInheritance: false, denyCommands: [], allowPipes: false, maxExecutionTimeMs: 1000 },
          secrets: { allowedSecretNames: [], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
          limits: { maxConcurrentExecutions: 1, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 1000, maxOutputSizeBytes: 1048576 },
        },
      },
    }); // network_client requires minConfidence = 0.80

    const validationResult = createMockValidationResult();
    // Replay with only 2 scenarios, yielding lower confidence
    const replayResult = createMockReplayResult({
      totalScenarioCount: 2,
      passedScenarioCount: 2,
    });

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      policy: STRICT_EVALUATION_POLICY_V1, // Strict policy has higher min confidence (0.90)
    });

    expect(result.decisionRecord.decision).toBe("deferred_for_more_evidence");
    expect(result.decisionRecord.deferralReason).toContain("Confidence score");
    expect(result.overallDecision.verdict).toBe("conditional");
  });

  it("blocks regressive tool updates when candidate regresses prior active baseline", async () => {
    const service = createCandidateEvaluationService();

    const baseline = createMockActiveBaseline({
      manifest: {
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            format: { type: "string" },
          },
          required: ["id", "format"],
          additionalProperties: false,
        },
      },
      metrics: {
        latencyMs: 80,
        tokenUsage: 4,
        successRate: 1.0,
      },
    });

    // Candidate breaks backward compatibility by removing 'format' parameter
    const candidate = createMockCandidateRevision({
      manifest: {
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    });

    const validationResult = createMockValidationResult();
    const replayResult = createMockReplayResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      activeVersionBaseline: baseline,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.decision).toBe("repair_requested");
    expect(result.decisionRecord.regressionResult).toBeDefined();
    expect(result.decisionRecord.regressionResult?.passed).toBe(false);
    expect(result.decisionRecord.regressionResult?.isBreakingChange).toBe(true);
    expect(result.decisionRecord.repairGuidance?.repairTargets.some((t) => t.includes("baseline regression"))).toBe(true);
  });

  it("renders 'infrastructure_retry' when validation or replay experienced infrastructure failure", async () => {
    const service = createCandidateEvaluationService();

    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult({
      status: "infrastructure_fail",
      passed: false,
    });

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.decision).toBe("infrastructure_retry");
    expect(result.overallDecision.verdict).toBe("conditional");
  });

  it("produces deterministic scores and repeatable SHA-256 digest on identical inputs", async () => {
    const service = createCandidateEvaluationService();

    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult();
    const replayResult = createMockReplayResult();
    const opportunity = createMockOpportunity();
    const envelope = createMockEnvelope();

    const eval1 = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      opportunity,
      envelope,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    const eval2 = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      opportunity,
      envelope,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(eval1.decisionRecord.compositeScore).toBe(eval2.decisionRecord.compositeScore);
    expect(eval1.decisionRecord.confidenceScore).toBe(eval2.decisionRecord.confidenceScore);
    expect(eval1.decisionRecord.decision).toBe(eval2.decisionRecord.decision);
    expect(eval1.decisionRecord.digest).toBe(eval2.decisionRecord.digest);
    expect(eval1.decisionRecord.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("evaluates shadow policies and aggregates calibration data without affecting active decision", async () => {
    const service = createCandidateEvaluationService();

    const candidate = createMockCandidateRevision();
    const validationResult = createMockValidationResult();
    const replayResult = createMockReplayResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      policy: STANDARD_EVALUATION_POLICY_V1,
      shadowPolicyIds: [SHADOW_CALIBRATION_POLICY_V1.policyId],
    });

    expect(result.shadowResults).toBeDefined();
    expect(result.shadowResults?.length).toBe(1);
    expect(result.shadowResults?.[0].shadowPolicyId).toBe("shadow-calibration-policy");

    const report = service.getCalibrationReport(SHADOW_CALIBRATION_POLICY_V1.policyId);
    expect(report.sampleCount).toBeGreaterThanOrEqual(1);
    expect(report.shadowPolicyId).toBe("shadow-calibration-policy");
  });

  it("enforces stricter thresholds for higher risk tiers (e.g. secret_mediated vs read_only)", async () => {
    const service = createCandidateEvaluationService();

    const readOnlyCandidate = createMockCandidateRevision(); // read_only
    const secretCandidate = createMockCandidateRevision({
      manifest: {
        capabilities: {
          fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: false, allowTemp: false, denyPaths: [], maxFileSizeBytes: 1048576 },
          net: { allowOutbound: false, allowedDomains: [], allowedPorts: [], allowInsecureHttp: false, denyDomains: [], denyPrivateRanges: true },
          command: { allowedCommands: [], allowEnvInheritance: false, denyCommands: [], allowPipes: false, maxExecutionTimeMs: 1000 },
          secrets: { allowedSecretNames: ["SECRET_KEY"], allowedPrefixes: [], denyDirectRead: true, injectAsEnv: true },
          limits: { maxConcurrentExecutions: 1, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 1000, maxOutputSizeBytes: 1048576 },
        },
      },
    }); // secret_mediated

    // A validation result with 85% coverage and 1 static warning:
    // This passes read_only (threshold 0.70) but fails secret_mediated (threshold 0.95)!
    const validationResult = createMockValidationResult({
      coverage: {
        statementCount: 100,
        coveredStatements: 85,
        statementCoveragePercent: 85,
        branchCount: 20,
        coveredBranches: 16,
        branchCoveragePercent: 80,
        functionCount: 10,
        coveredFunctions: 9,
        functionCoveragePercent: 90,
      },
      staticFindings: [
        { severity: "warning", category: "static_flaw", message: "Potential unchecked array access" },
      ],
    });

    const replayResult = createMockReplayResult();

    const readOnlyEval = await service.evaluateCandidate({
      candidate: readOnlyCandidate,
      validationResult,
      replayResult,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    const secretEval = await service.evaluateCandidate({
      candidate: secretCandidate,
      validationResult,
      replayResult,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(readOnlyEval.decisionRecord.riskTier).toBe("read_only");
    expect(secretEval.decisionRecord.riskTier).toBe("secret_mediated");

    expect(readOnlyEval.decisionRecord.decision).toBe("eligible_for_artifact");
    expect(secretEval.decisionRecord.decision).toBe("repair_requested"); // Stricter threshold not satisfied
  });
});
