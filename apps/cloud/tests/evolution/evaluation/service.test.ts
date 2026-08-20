import { describe, expect, it, vi } from "vitest";
import {
  PERMISSIVE_EVALUATION_POLICY_V1,
  SHADOW_CALIBRATION_POLICY_V1,
  STANDARD_EVALUATION_POLICY_V1,
  STRICT_EVALUATION_POLICY_V1,
} from "../../../src/evolution/evaluation/policy.js";
import {
  CandidateEvaluationService,
  createCandidateEvaluationService,
} from "../../../src/evolution/evaluation/service.js";
import {
  createMockActiveBaseline,
  createMockCandidateRevision,
  createMockEnvelope,
  createMockOpportunity,
  createMockReplayResult,
  createMockToolManifest,
  createMockValidationResult,
} from "./helpers.js";
import { createMockWorkflowContract } from "../generator/helpers.js";
import type {
  ModelUsageMetrics,
  WorkloadBenchmarkComparison,
} from "../../../src/evolution/replay/types.js";
import { calculateWeightedModelCost } from "../../../src/evolution/replay/types.js";

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
    expect(result.decisionRecord.compositeScore).toBeGreaterThanOrEqual(0.7);
    expect(result.decisionRecord.confidenceScore).toBeGreaterThanOrEqual(0.6);
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
      "Add optional 'foo' property to input parameter schema",
    );

    expect(repairCallback).toHaveBeenCalledTimes(1);
    expect(repairCallback).toHaveBeenCalledWith(result);
  });

  it("renders 'deferred_for_more_evidence' when confidence is low due to insufficient replay coverage", async () => {
    const service = createCandidateEvaluationService();

    const candidate = createMockCandidateRevision({
      manifest: {
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
            allowOutbound: true,
            allowedDomains: ["api.example.com"],
            allowedPorts: [443],
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
            allowedSecretNames: [],
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
    expect(
      result.decisionRecord.repairGuidance?.repairTargets.some((t) =>
        t.includes("baseline regression"),
      ),
    ).toBe(true);
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
            allowedSecretNames: ["SECRET_KEY"],
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
        {
          severity: "warning",
          category: "static_flaw",
          message: "Potential unchecked array access",
        },
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
  it("terminally rejects contract candidate missing workload benchmarks", async () => {
    const service = createCandidateEvaluationService();
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    // Attach contract/coverage to candidate plan to simulate persisted revision (also test direct threading)
    const completeCoverage = {
      complete: true,
      uncoveredOperationIds: [] as string[],
      uncoveredOutputNames: [] as string[],
      operationCoverage: contract.operations.map((op) => ({ operationId: op.id, stepIds: [`step_${op.id}`] })),
      outputCoverage: contract.outputRequirements.map((r) => ({
        outputName: r.name,
        schemaPaths: [`properties.${r.name}`],
        sourceOperationIds: [r.sourceOperationId],
      })),
    };
    // Use explicit workflow fields (also covered via candidate fallback)
    const validationResult = createMockValidationResult();
    const replayResult = createMockReplayResult(); // no workloadBenchmarks

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      workflowContract: contract,
      workflowCoverage: completeCoverage,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.passed).toBe(false);
    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workload_cost_non_regression");
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(false);
    expect(result.decisionRecord.decision).toBe("rejected");
    expect(result.overallDecision.verdict).toBe("fail");
  });

  it("routes incomplete workflow coverage to repair (repairable gate)", async () => {
    const service = createCandidateEvaluationService();
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const incompleteCoverage = {
      complete: false,
      uncoveredOperationIds: [contract.operations[0].id],
      uncoveredOutputNames: [contract.outputRequirements[0].name],
      operationCoverage: [],
      outputCoverage: [],
    };
    // Provide complete workload benchmarks to isolate coverage gate
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
    const mkBenchmark = (
      workloadSize: WorkloadBenchmarkComparison["workloadSize"],
      baselineOverrides: Partial<ModelUsageMetrics> = {},
      candidateOverrides: Partial<ModelUsageMetrics> = {},
    ): WorkloadBenchmarkComparison => {
      const baseline = makeMetrics(baselineOverrides);
      const candidateMetrics = makeMetrics({ ...candidateOverrides, correct: true, redundantToolCalls: 0 });
      const baselineCostUsd = calculateWeightedModelCost(baseline);
      const candidateCostUsd = calculateWeightedModelCost(candidateMetrics);
      return {
        workloadSize,
        baseline,
        candidate: candidateMetrics,
        baselineCostUsd,
        candidateCostUsd,
        costDeltaPercent: ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100,
        correctnessPassed: candidateMetrics.correct,
        redundantVerificationCalls: candidateMetrics.redundantToolCalls,
      };
    };
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      mkBenchmark("small", { inputTokens: 1000 }, { inputTokens: 800 }),
      mkBenchmark("medium", { inputTokens: 2000 }, { inputTokens: 1200 }),
      mkBenchmark("large", { inputTokens: 3000 }, { inputTokens: 1500 }),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      workflowContract: contract,
      workflowCoverage: incompleteCoverage,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.passed).toBe(false);
    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workflow_coverage");
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(true);
    expect(result.decisionRecord.decision).toBe("repair_requested");
  });

  it("terminally rejects large-workload cost regression", async () => {
    const service = createCandidateEvaluationService();
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const completeCoverage = {
      complete: true,
      uncoveredOperationIds: [] as string[],
      uncoveredOutputNames: [] as string[],
      operationCoverage: contract.operations.map((op) => ({ operationId: op.id, stepIds: [`step_${op.id}`] })),
      outputCoverage: contract.outputRequirements.map((r) => ({
        outputName: r.name,
        schemaPaths: [`properties.${r.name}`],
        sourceOperationIds: [r.sourceOperationId],
      })),
    };
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
    const mkBenchmark = (
      workloadSize: WorkloadBenchmarkComparison["workloadSize"],
      baselineOverrides: Partial<ModelUsageMetrics> = {},
      candidateOverrides: Partial<ModelUsageMetrics> = {},
    ): WorkloadBenchmarkComparison => {
      const baseline = makeMetrics(baselineOverrides);
      const candidateMetrics = makeMetrics({ ...candidateOverrides, correct: true, redundantToolCalls: 0 });
      const baselineCostUsd = calculateWeightedModelCost(baseline);
      const candidateCostUsd = calculateWeightedModelCost(candidateMetrics);
      return {
        workloadSize,
        baseline,
        candidate: candidateMetrics,
        baselineCostUsd,
        candidateCostUsd,
        costDeltaPercent: ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100,
        correctnessPassed: candidateMetrics.correct,
        redundantVerificationCalls: candidateMetrics.redundantToolCalls,
      };
    };
    // Large regression: candidate costs more than baseline
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      mkBenchmark("small", { inputTokens: 1000 }, { inputTokens: 800 }),
      mkBenchmark("medium", { inputTokens: 2000 }, { inputTokens: 1200 }),
      mkBenchmark("large", { inputTokens: 1000 }, { inputTokens: 3000 }),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      workflowContract: contract,
      workflowCoverage: completeCoverage,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.passed).toBe(false);
    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workload_cost_non_regression");
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(false);
    expect(result.decisionRecord.decision).toBe("rejected");
  });

  it("permits eligible with complete small/medium/large evidence and leaves legacy without contract eligible", async () => {
    const service = createCandidateEvaluationService();
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const completeCoverage = {
      complete: true,
      uncoveredOperationIds: [] as string[],
      uncoveredOutputNames: [] as string[],
      operationCoverage: contract.operations.map((op) => ({ operationId: op.id, stepIds: [`step_${op.id}`] })),
      outputCoverage: contract.outputRequirements.map((r) => ({
        outputName: r.name,
        schemaPaths: [`properties.${r.name}`],
        sourceOperationIds: [r.sourceOperationId],
      })),
    };
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
    const mkBenchmark = (
      workloadSize: WorkloadBenchmarkComparison["workloadSize"],
      baselineOverrides: Partial<ModelUsageMetrics> = {},
      candidateOverrides: Partial<ModelUsageMetrics> = {},
    ): WorkloadBenchmarkComparison => {
      const baseline = makeMetrics(baselineOverrides);
      const candidateMetrics = makeMetrics({ ...candidateOverrides, correct: true, redundantToolCalls: 0 });
      const baselineCostUsd = calculateWeightedModelCost(baseline);
      const candidateCostUsd = calculateWeightedModelCost(candidateMetrics);
      return {
        workloadSize,
        baseline,
        candidate: candidateMetrics,
        baselineCostUsd,
        candidateCostUsd,
        costDeltaPercent: ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100,
        correctnessPassed: candidateMetrics.correct,
        redundantVerificationCalls: candidateMetrics.redundantToolCalls,
      };
    };
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      mkBenchmark("small", { inputTokens: 1000 }, { inputTokens: 800 }),
      mkBenchmark("medium", { inputTokens: 2000 }, { inputTokens: 1200 }),
      mkBenchmark("large", { inputTokens: 3000 }, { inputTokens: 1500 }),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const contractResult = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      workflowContract: contract,
      workflowCoverage: completeCoverage,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(contractResult.decisionRecord.hardGateResult.passed).toBe(true);
    expect(contractResult.decisionRecord.decision).toBe("eligible_for_artifact");
    expect(contractResult.overallDecision.verdict).toBe("pass");

    // Legacy candidate without workflowContract should remain eligible even without benchmarks (existing publication path)
    const legacyReplay = createMockReplayResult(); // no benchmarks
    const legacyResult = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult: legacyReplay,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });
    expect(legacyResult.decisionRecord.hardGateResult.passed).toBe(true);
    expect(legacyResult.decisionRecord.decision).toBe("eligible_for_artifact");
  });

  it("threads CandidateRevision.plan workflowContract/coverage via candidate fallback when not explicitly passed", async () => {
    const service = createCandidateEvaluationService();
    const contract = createMockWorkflowContract();
    const incompleteCoverage = {
      complete: false,
      uncoveredOperationIds: [contract.operations[0].id],
      uncoveredOutputNames: [],
      operationCoverage: [],
      outputCoverage: [],
    };
    const candidateWithPlan = createMockCandidateRevision();
    // Attach to artifacts.plan directly to test fallback threading
    (candidateWithPlan as unknown as { artifacts: { plan: Record<string, unknown> } }).artifacts.plan = {
      ...(candidateWithPlan.artifacts.plan as unknown as Record<string, unknown>),
      workflowContract: contract,
      workflowCoverage: incompleteCoverage,
    } as unknown as typeof candidateWithPlan.artifacts.plan;
    const validationResult = createMockValidationResult();
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
    const mkBenchmark = (
      workloadSize: WorkloadBenchmarkComparison["workloadSize"],
      baselineOverrides: Partial<ModelUsageMetrics> = {},
      candidateOverrides: Partial<ModelUsageMetrics> = {},
    ): WorkloadBenchmarkComparison => {
      const baseline = makeMetrics(baselineOverrides);
      const candidateMetrics = makeMetrics({ ...candidateOverrides, correct: true, redundantToolCalls: 0 });
      const baselineCostUsd = calculateWeightedModelCost(baseline);
      const candidateCostUsd = calculateWeightedModelCost(candidateMetrics);
      return {
        workloadSize,
        baseline,
        candidate: candidateMetrics,
        baselineCostUsd,
        candidateCostUsd,
        costDeltaPercent: ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100,
        correctnessPassed: candidateMetrics.correct,
        redundantVerificationCalls: candidateMetrics.redundantToolCalls,
      };
    };
    const benchmarks: WorkloadBenchmarkComparison[] = [
      mkBenchmark("small", { inputTokens: 1000 }, { inputTokens: 800 }),
      mkBenchmark("medium", { inputTokens: 2000 }, { inputTokens: 1200 }),
      mkBenchmark("large", { inputTokens: 3000 }, { inputTokens: 1500 }),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks: benchmarks } as unknown as Record<string, unknown>);

    const result = await service.evaluateCandidate({
      candidate: candidateWithPlan,
      validationResult,
      replayResult,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workflow_coverage");
    expect(result.decisionRecord.decision).toBe("repair_requested");
  });

});
