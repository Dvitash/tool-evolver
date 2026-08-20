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
import { hashCanonical } from "@tool-evolver/contracts";
import type { ToolPlan } from "../../../src/evolution/generator/types.js";
import { createMockWorkflowContract } from "../generator/helpers.js";
import type {
  ModelUsageMetrics,
  WorkloadBenchmarkComparison,
} from "../../../src/evolution/replay/types.js";
import {
  calculateWeightedModelCost,
  MODEL_COST_SCHEDULE_ID_V1,
} from "../../../src/evolution/replay/types.js";
import {
  HmacBenchmarkEvidenceVerifier,
  signWorkloadBenchmark,
} from "../../../src/evolution/replay/benchmark-attestation.js";

const TEST_BENCHMARK_ISSUER = "test-issuer";
const TEST_BENCHMARK_KEY_ID = "test-key-1";
const TEST_BENCHMARK_SECRET = "super-secret-for-tests-32bytes!!";

function createTestBenchmarkVerifier(): HmacBenchmarkEvidenceVerifier {
  return new HmacBenchmarkEvidenceVerifier({
    issuer: TEST_BENCHMARK_ISSUER,
    keyId: TEST_BENCHMARK_KEY_ID,
    secret: TEST_BENCHMARK_SECRET,
  });
}
function createToolPlanForContract(contract: ReturnType<typeof createMockWorkflowContract>, overrides: Partial<ToolPlan> = {}): ToolPlan {
  const steps = contract.operations.map((op, idx) => {
    const outputsForOp = contract.outputRequirements
      .filter((r) => r.sourceOperationId === op.id)
      .reduce((acc, r) => ({ ...acc, [r.name]: { type: r.type } }), {} as Record<string, unknown>);
    const hasOutputs = Object.keys(outputsForOp).length > 0;
    return {
      id: `step_${op.id}`,
      name: `step for ${op.id}`,
      toolClass: op.toolClass as string,
      action: op.id,
      inputs: {},
      outputs: hasOutputs ? outputsForOp : undefined,
      dependsOn: idx > 0 ? [`step_${contract.operations[idx - 1].id}`] : [],
      coveredOperationIds: [op.id],
    };
  });
  const outputSchema: Record<string, unknown> = {
    type: "object",
    properties: Object.fromEntries(
      contract.outputRequirements.map((r) => [r.name, { type: r.type, description: r.description }]),
    ),
    required: contract.outputRequirements.filter((r) => r.required).map((r) => r.name),
  };
  return {
    id: "plan-1",
    opportunityId: "opp-1",
    name: "test-plan",
    description: "Test plan for workflow contract",
    variableInputs: [],
    invariantInputs: [],
    inputSchema: { type: "object", properties: {}, required: [] } as any,
    outputSchema: outputSchema as any,
    steps: steps as any,
    capabilities: {} as any,
    capabilityRequirements: {} as any,
    runtime: { runtime: "node", memoryLimitMb: 128, timeoutMs: 5000, cpuLimitPercent: 100 } as any,
    workflowContract: contract,
    metadata: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as ToolPlan;
}

function makeBenchmarkWithBindings(
  workloadSize: WorkloadBenchmarkComparison["workloadSize"],
  candidateRevisionId: string,
  artifactDigest: string,
  baselineOverrides: Partial<ModelUsageMetrics> = {},
  candidateOverrides: Partial<ModelUsageMetrics> = {},
  overrides: Partial<WorkloadBenchmarkComparison> = {},
): WorkloadBenchmarkComparison {
  const baseline: ModelUsageMetrics = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    turns: 2,
    toolCalls: 3,
    redundantToolCalls: 0,
    wallTimeMs: 1200,
    correct: true,
    ...baselineOverrides,
  };
  const candidate: ModelUsageMetrics = {
    inputTokens: 800,
    outputTokens: 400,
    cacheReadTokens: 100,
    turns: 1,
    toolCalls: 2,
    redundantToolCalls: 0,
    wallTimeMs: 1000,
    correct: true,
    ...candidateOverrides,
  };
  const scheduleIdForCost = MODEL_COST_SCHEDULE_ID_V1;
  const baselineCostUsd = calculateWeightedModelCost(baseline, scheduleIdForCost);
  const candidateCostUsd = calculateWeightedModelCost(candidate, scheduleIdForCost);
  const idx = workloadSize === "small" ? "1" : workloadSize === "medium" ? "2" : "3";
  const rowWithoutAttestation = {
    workloadSize,
    baseline,
    candidate,
    baselineCostUsd,
    candidateCostUsd,
    costDeltaPercent: baselineCostUsd > 0 ? ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100 : 0,
    correctnessPassed: candidate.correct,
    redundantVerificationCalls: candidate.redundantToolCalls,
    benchmarkId: `bench-${workloadSize}-${idx}`,
    baselineRunId: `base-run-${workloadSize}-${idx}`,
    candidateRunId: `cand-run-${workloadSize}-${idx}`,
    workloadInputDigest: hashCanonical(`workload-input-${workloadSize}-${idx}`),
    candidateRevisionId,
    artifactDigest,
    modelProvider: "openai",
    modelId: "gpt-4o-mini",
    observedAt: new Date().toISOString(),
    scheduleId: scheduleIdForCost,
    ...overrides,
  } as unknown as Omit<WorkloadBenchmarkComparison, "attestation">;
  const { attestation: _ignored, ...cleanRow } = rowWithoutAttestation as unknown as Record<string, unknown>;
  return signWorkloadBenchmark(cleanRow as Omit<WorkloadBenchmarkComparison, "attestation">, {
    issuer: TEST_BENCHMARK_ISSUER,
    keyId: TEST_BENCHMARK_KEY_ID,
    secret: TEST_BENCHMARK_SECRET,
  });
}

describe("CandidateEvaluationService (Candidate Scoring, Evaluation, and Eligibility Decisions)", () => {
  it("renders 'eligible_for_artifact' on a clean, high-scoring candidate", async () => {
    const eligibilityCallback = vi.fn();
    const service = createCandidateEvaluationService({ onEligibilityDecision: eligibilityCallback, benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ onRepairRequested: repairCallback, benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });

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
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const toolPlan = createToolPlanForContract(contract);
    const validationResult = createMockValidationResult();
    const replayResult = createMockReplayResult(); // no workloadBenchmarks

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      toolPlan,
      workflowContract: contract,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.passed).toBe(false);
    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workload_cost_non_regression");
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(false);
    expect(result.decisionRecord.decision).toBe("rejected");
    expect(result.overallDecision.verdict).toBe("fail");
  });

  it("routes incomplete workflow coverage to repair (repairable gate)", async () => {
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const artifactDigest = hashCanonical(candidate.artifacts.sourceCode);
    const revisionId = candidate.revisionId;
    const incompletePlan = createToolPlanForContract(contract, {
      steps: contract.operations.slice(0, 1).map((op) => ({
        id: `step_${op.id}`,
        name: `step for ${op.id}`,
        toolClass: op.toolClass as string,
        action: op.id,
        inputs: {},
        dependsOn: [],
        coveredOperationIds: [op.id],
      })) as any,
      outputSchema: { type: "object", properties: {}, required: [] } as any,
    });
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      makeBenchmarkWithBindings("small", revisionId, artifactDigest, { inputTokens: 1000 }, { inputTokens: 800 }),
      makeBenchmarkWithBindings("medium", revisionId, artifactDigest, { inputTokens: 2000 }, { inputTokens: 1200 }),
      makeBenchmarkWithBindings("large", revisionId, artifactDigest, { inputTokens: 3000 }, { inputTokens: 1500 }),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      toolPlan: incompletePlan,
      workflowContract: contract,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });
    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workflow_coverage");
    expect(result.decisionRecord.decision).toBe("repair_requested");
  });

  it("terminally rejects large-workload cost regression", async () => {
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const artifactDigest = hashCanonical(candidate.artifacts.sourceCode);
    const revisionId = candidate.revisionId;
    const toolPlan = createToolPlanForContract(contract);
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      makeBenchmarkWithBindings("small", revisionId, artifactDigest, { inputTokens: 1000 }, { inputTokens: 800 }),
      makeBenchmarkWithBindings("medium", revisionId, artifactDigest, { inputTokens: 2000 }, { inputTokens: 1200 }),
      makeBenchmarkWithBindings("large", revisionId, artifactDigest, { inputTokens: 1000 }, { inputTokens: 3000 }),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      toolPlan,
      workflowContract: contract,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.passed).toBe(false);
    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workload_cost_non_regression");
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(false);
    expect(result.decisionRecord.decision).toBe("rejected");
    expect(result.overallDecision.verdict).toBe("fail");
  });

  it("permits eligible with complete small/medium/large evidence and leaves legacy without contract eligible", async () => {
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const artifactDigest = hashCanonical(candidate.artifacts.sourceCode);
    const revisionId = candidate.revisionId;
    const toolPlan = createToolPlanForContract(contract);
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      makeBenchmarkWithBindings("small", revisionId, artifactDigest, { inputTokens: 1000 }, { inputTokens: 800 }),
      makeBenchmarkWithBindings("medium", revisionId, artifactDigest, { inputTokens: 2000 }, { inputTokens: 1200 }),
      makeBenchmarkWithBindings("large", revisionId, artifactDigest, { inputTokens: 3000 }, { inputTokens: 1500 }),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      toolPlan,
      workflowContract: contract,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.passed).toBe(true);
    expect(result.decisionRecord.decision).toBe("eligible_for_artifact");
    expect(result.overallDecision.verdict).toBe("pass");

    // Legacy candidate without workflowContract should remain eligible (no workflow gates)
    const legacyCandidate = createMockCandidateRevision();
    const legacyReplay = createMockReplayResult();
    const legacyResult = await service.evaluateCandidate({
      candidate: legacyCandidate,
      validationResult,
      replayResult: legacyReplay,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });
    expect(legacyResult.decisionRecord.hardGateResult.passed).toBe(true);
    expect(legacyResult.decisionRecord.decision).toBe("eligible_for_artifact");
  });

  it("threads CandidateRevision.plan workflowContract/coverage via candidate fallback when not explicitly passed", async () => {
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidateWithPlan = createMockCandidateRevision();
    const artifactDigest = hashCanonical(candidateWithPlan.artifacts.sourceCode);
    const revisionId = candidateWithPlan.revisionId;
    const incompletePlan = createToolPlanForContract(contract, {
      steps: contract.operations.slice(0, 1).map((op) => ({
        id: `step_${op.id}`,
        name: `step for ${op.id}`,
        toolClass: op.toolClass as string,
        action: op.id,
        inputs: {},
        dependsOn: [],
        coveredOperationIds: [op.id],
      })) as any,
      outputSchema: { type: "object", properties: {}, required: [] } as any,
    });
    // Attach to artifacts.plan directly to test fallback threading
    (candidateWithPlan as unknown as { artifacts: { plan: ToolPlan } }).artifacts.plan = incompletePlan as unknown as typeof candidateWithPlan.artifacts.plan;
    const validationResult = createMockValidationResult();
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      makeBenchmarkWithBindings("small", revisionId, artifactDigest, { inputTokens: 1000 }, { inputTokens: 800 }),
      makeBenchmarkWithBindings("medium", revisionId, artifactDigest, { inputTokens: 2000 }, { inputTokens: 1200 }),
      makeBenchmarkWithBindings("large", revisionId, artifactDigest, { inputTokens: 3000 }, { inputTokens: 1500 }),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);

    const result = await service.evaluateCandidate({
      candidate: candidateWithPlan,
      validationResult,
      replayResult,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workflow_coverage");
    expect(result.decisionRecord.decision).toBe("repair_requested");
  });


  it("ignores fabricated empty complete coverage summary and fails via authoritative plan", async () => {
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const artifactDigest = hashCanonical(candidate.artifacts.sourceCode);
    const revisionId = candidate.revisionId;
    const emptyPlan = createToolPlanForContract(contract, {
      steps: [] as any,
      outputSchema: { type: "object", properties: {}, required: [] } as any,
    });
    const fabricatedCoverage = {
      complete: true as const,
      uncoveredOperationIds: [] as string[],
      uncoveredOutputNames: [] as string[],
      operationCoverage: contract.operations.map((op) => ({ operationId: op.id, stepIds: [`step_${op.id}`] })),
      outputCoverage: contract.outputRequirements.map((r) => ({
        outputName: r.name,
        schemaPaths: [`properties.${r.name}`],
        sourceOperationIds: [r.sourceOperationId],
      })),
    };
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      makeBenchmarkWithBindings("small", revisionId, artifactDigest),
      makeBenchmarkWithBindings("medium", revisionId, artifactDigest),
      makeBenchmarkWithBindings("large", revisionId, artifactDigest),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      toolPlan: emptyPlan,
      workflowContract: contract,
      workflowCoverage: fabricatedCoverage as any,
      policy: STANDARD_EVALUATION_POLICY_V1,
    } as any);

    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workflow_coverage");
    expect(result.decisionRecord.decision).toBe("repair_requested");
  });

  it("stale coverage summary cannot override real plan — still passes when plan is complete", async () => {
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const artifactDigest = hashCanonical(candidate.artifacts.sourceCode);
    const revisionId = candidate.revisionId;
    const completePlan = createToolPlanForContract(contract);
    const staleIncompleteCoverage = {
      complete: false as const,
      uncoveredOperationIds: [contract.operations[0].id],
      uncoveredOutputNames: [] as string[],
      operationCoverage: [],
      outputCoverage: [],
    };
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      makeBenchmarkWithBindings("small", revisionId, artifactDigest),
      makeBenchmarkWithBindings("medium", revisionId, artifactDigest),
      makeBenchmarkWithBindings("large", revisionId, artifactDigest),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      toolPlan: completePlan,
      workflowContract: contract,
      workflowCoverage: staleIncompleteCoverage as any,
      policy: STANDARD_EVALUATION_POLICY_V1,
    } as any);

    expect(result.decisionRecord.hardGateResult.passed).toBe(true);
    expect(result.decisionRecord.decision).toBe("eligible_for_artifact");
  });

  it("fails terminally when workload evidence repeats benchmarkId / mismatched artifact", async () => {
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const artifactDigest = hashCanonical(candidate.artifacts.sourceCode);
    const revisionId = candidate.revisionId;
    const toolPlan = createToolPlanForContract(contract);
    const duplicateId = "bench-duplicate";
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      makeBenchmarkWithBindings("small", revisionId, artifactDigest, {}, {}, { benchmarkId: duplicateId }),
      makeBenchmarkWithBindings("medium", revisionId, artifactDigest, {}, {}, { benchmarkId: duplicateId }),
      makeBenchmarkWithBindings("large", revisionId, artifactDigest),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      toolPlan,
      workflowContract: contract,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workload_cost_non_regression");
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(false);
    expect(result.decisionRecord.decision).toBe("rejected");
  });

  it("fails terminally when workload candidateRevisionId does not match candidate", async () => {
    const service = createCandidateEvaluationService({ benchmarkEvidenceVerifier: createTestBenchmarkVerifier() });
    const contract = createMockWorkflowContract();
    const candidate = createMockCandidateRevision();
    const artifactDigest = hashCanonical(candidate.artifacts.sourceCode);
    const toolPlan = createToolPlanForContract(contract);
    const workloadBenchmarks: WorkloadBenchmarkComparison[] = [
      makeBenchmarkWithBindings("small", "wrong-rev", artifactDigest),
      makeBenchmarkWithBindings("medium", "wrong-rev", artifactDigest),
      makeBenchmarkWithBindings("large", "wrong-rev", artifactDigest),
    ];
    const replayResult = createMockReplayResult({ workloadBenchmarks } as unknown as Record<string, unknown>);
    const validationResult = createMockValidationResult();

    const result = await service.evaluateCandidate({
      candidate,
      validationResult,
      replayResult,
      toolPlan,
      workflowContract: contract,
      policy: STANDARD_EVALUATION_POLICY_V1,
    });

    expect(result.decisionRecord.hardGateResult.failedGates).toContain("workload_cost_non_regression");
    expect(result.decisionRecord.hardGateResult.canRepair).toBe(false);
    expect(result.decisionRecord.decision).toBe("rejected");
  });

});
