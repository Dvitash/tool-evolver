import { randomUUID } from "node:crypto";
import {
  type CapabilityEnvelope,
  type CapabilityManifest,
  type EvaluationDecision as ContractEvaluationDecision,
  type EvaluationDimension as ContractEvaluationDimension,
  type EvaluationDimensionName as ContractEvaluationDimensionName,
  type EvaluationResult as ContractEvaluationResult,
  type EvaluationVerdict,
  type EvolutionCandidate,
  type ToolManifest,
  hashCanonical,
} from "@tool-evolver/contracts";
import type { CandidateRevision } from "../generator/types.js";
import type { OpportunityDetection } from "../opportunity/types.js";
import type { HistoricalReplayResult } from "../replay/types.js";
import type { CandidateValidationResult, CandidateValidationTarget } from "../testing/types.js";
import { HardGateEvaluator } from "./hard-gates.js";
import {
  type EvaluationPolicyRegistry,
  classifyRiskTier,
  defaultPolicyRegistry,
} from "./policy.js";
import { CandidateScorer } from "./scorer.js";
import { ShadowCalibrationAggregator, ShadowPolicyEvaluator } from "./shadow.js";
import type {
  ActiveToolBaseline,
  CandidateEvaluationInput,
  CandidateEvaluationOptions,
  DimensionScore,
  EvaluationDecision,
  EvaluationDecisionRecord,
  EvaluationDimensionKey,
  EvaluationPolicy,
  EvaluationRepairGuidance,
  EvaluationResult,
  HardGateResult,
  RiskTier,
  ShadowCalibrationReport,
  ShadowEvaluationResult,
  UpdateRegressionResult,
} from "./types.js";
import { UpdateComparator } from "./update-comparator.js";

/**
 * Options for configuring CandidateEvaluationService.
 */
export interface CandidateEvaluationServiceOptions {
  policyRegistry?: EvaluationPolicyRegistry;
  onEligibilityDecision?: (result: EvaluationResult) => Promise<void> | void;
  onRepairRequested?: (result: EvaluationResult) => Promise<void> | void;
}

/**
 * Mapping from internal dimension keys to contracts dimension names.
 */
const DIMENSION_TO_CONTRACT_NAME: Record<
  EvaluationDimensionKey,
  ContractEvaluationDimensionName | undefined
> = {
  correctness: "test",
  replay_coverage: "replay",
  security_policy_fit: "security",
  maintainability: "quality",
  latency_resources: "latency",
  reliability: "reliability",
  token_savings: "token_savings",
  time_savings: undefined,
  utility_recurrence: undefined,
};

/**
 * Core Evaluation and Eligibility Decision Service for Tool Evolver Candidates.
 */
export class CandidateEvaluationService {
  private policyRegistry: EvaluationPolicyRegistry;
  private hardGateEvaluator = new HardGateEvaluator();
  private scorer = new CandidateScorer();
  private updateComparator = new UpdateComparator();
  private shadowEvaluator = new ShadowPolicyEvaluator();
  private shadowCalibrationAggregator = new ShadowCalibrationAggregator();

  private evaluationStore = new Map<string, EvaluationResult>();
  private candidateEvaluations = new Map<string, string[]>();

  private onEligibilityDecision?: (result: EvaluationResult) => Promise<void> | void;
  private onRepairRequested?: (result: EvaluationResult) => Promise<void> | void;

  constructor(options: CandidateEvaluationServiceOptions = {}) {
    this.policyRegistry = options.policyRegistry ?? defaultPolicyRegistry;
    this.onEligibilityDecision = options.onEligibilityDecision;
    this.onRepairRequested = options.onRepairRequested;
  }

  /**
   * Evaluates a candidate tool revision, executes hard gates, computes dimensional scores,
   * detects regressions, renders deterministic eligibility decisions, and generates repeatability digests.
   */
  async evaluateCandidate(input: CandidateEvaluationInput): Promise<EvaluationResult> {
    const startTime = Date.now();
    const evaluationId = input.options?.evaluationId ?? `eval-${randomUUID()}`;
    const evaluatedAt = new Date().toISOString();

    // 1. Resolve candidate metadata, manifest, and source code
    const candidateInfo = this.extractCandidateInfo(input.candidate);
    const { candidateId, revisionId, manifest, sourceCode, requiredCapabilities } = candidateInfo;

    // Resolve authoritative workflow contract/coverage (explicit input preferred, fallback to CandidateRevision plan)
    const candidateAsRevision = input.candidate as unknown as CandidateRevision & {
      artifacts?: CandidateRevision["artifacts"];
    };
    const revisionPlan = candidateAsRevision?.artifacts?.plan;
    const workflowContract = input.workflowContract ?? revisionPlan?.workflowContract;
    const workflowCoverage = input.workflowCoverage ?? revisionPlan?.workflowCoverage;

    // 2. Resolve active evaluation policy
    const policy = this.policyRegistry.resolve(input.policy);

    // 3. Classify risk tier
    const riskTier =
      input.options?.forceRiskTier ?? classifyRiskTier(manifest, requiredCapabilities);
    const tierThresholds = policy.riskTierThresholds[riskTier];

    // 4. Evaluate non-negotiable hard safety gates
    const hardGateResult = this.hardGateEvaluator.evaluate({
      manifest,
      sourceCode,
      requiredCapabilities,
      validationResult: input.validationResult,
      replayResult: input.replayResult,
      envelope: input.envelope,
      policy,
      riskTier,
      workflowContract,
      workflowCoverage,
    } as unknown as Parameters<HardGateEvaluator["evaluate"]>[0]);


    // 5. Multi-dimensional scoring
    const scoringResult = this.scorer.score({
      manifest,
      sourceCode,
      requiredCapabilities,
      validationResult: input.validationResult,
      replayResult: input.replayResult,
      opportunity: input.opportunity,
      policy,
      riskTier,
    });

    // 6. Update regression detection against active baseline
    let regressionResult: UpdateRegressionResult | undefined;
    if (input.activeVersionBaseline && !input.options?.skipRegressionCheck) {
      const baselineObj = this.resolveActiveBaseline(input.activeVersionBaseline);
      if (baselineObj) {
        regressionResult = this.updateComparator.compare({
          candidateManifest: manifest,
          candidateSourceCode: sourceCode,
          candidateCapabilities: requiredCapabilities,
          candidateValidation: input.validationResult,
          candidateReplay: input.replayResult,
          baseline: baselineObj,
          policy,
          allowBreakingChanges: input.options?.allowBreakingChanges,
        });
      }
    }

    // 7. Render deterministic evaluation decision
    const decision = this.renderDecision({
      validationResult: input.validationResult,
      replayResult: input.replayResult,
      hardGateResult,
      scoringResult,
      regressionResult,
    });

    // 8. Map to contract verdict ("pass" | "fail" | "conditional")
    const verdict: EvaluationVerdict =
      decision === "eligible_for_artifact"
        ? "pass"
        : decision === "rejected"
          ? "fail"
          : "conditional";

    // 9. Formulate structured repair guidance if repair requested
    let repairGuidance: EvaluationRepairGuidance | undefined;
    if (decision === "repair_requested") {
      repairGuidance = this.formulateRepairGuidance({
        hardGateResult,
        validationResult: input.validationResult,
        replayResult: input.replayResult,
        regressionResult,
      });
    }

    let deferralReason: string | undefined;
    if (decision === "deferred_for_more_evidence") {
      deferralReason = `Confidence score (${scoringResult.confidenceScore}) below risk-tier '${riskTier}' requirement (${tierThresholds.minConfidence}). Additional historical replay sessions needed.`;
    }

    const durationMs = Date.now() - startTime;

    // 10. Generate deterministic SHA-256 digest of decision inputs and outputs
    const digest = this.computeDecisionDigest({
      candidateId,
      toolId: manifest.id,
      toolVersion: manifest.version,
      policyId: policy.policyId,
      policyVersion: policy.version,
      riskTier,
      decision,
      compositeScore: scoringResult.compositeScore,
      confidenceScore: scoringResult.confidenceScore,
      hardGates: hardGateResult.gateResults.map((g) => ({ gate: g.gate, passed: g.passed })),
      dimensionScores: scoringResult.dimensionScores.map((d) => ({
        dimension: d.dimension,
        adjustedScore: d.adjustedScore,
        passed: d.passed,
      })),
    });

    // 11. Build full EvaluationDecisionRecord
    const decisionRecord: EvaluationDecisionRecord = {
      evaluationId,
      candidateId,
      revisionId,
      toolId: manifest.id,
      toolVersion: manifest.version,
      policyId: policy.policyId,
      policyVersion: policy.version,
      riskTier,
      decision,
      verdict,
      compositeScore: scoringResult.compositeScore,
      confidenceScore: scoringResult.confidenceScore,
      thresholdScore: tierThresholds.minCompositeScore,
      hardGateResult,
      dimensionScores: scoringResult.dimensionScores,
      regressionResult,
      digest,
      repairGuidance,
      deferralReason,
      notes: input.options?.notes,
      evaluatedAt,
      durationMs,
    };

    // 12. Evaluate shadow policies if requested
    let shadowResults: ShadowEvaluationResult[] | undefined;
    if (input.shadowPolicyIds && input.shadowPolicyIds.length > 0) {
      const shadowPolicies = input.shadowPolicyIds
        .map((pid) => this.policyRegistry.get(pid))
        .filter((p): p is EvaluationPolicy => p !== undefined);

      if (shadowPolicies.length > 0) {
        shadowResults = this.shadowEvaluator.evaluateShadowPolicies(
          input,
          decisionRecord,
          shadowPolicies,
        );

        for (const sr of shadowResults) {
          this.shadowCalibrationAggregator.record(candidateId, decisionRecord, sr);
        }
      }
    }

    // 13. Map to contract dimensions
    const contractDimensions = this.mapToContractDimensions(scoringResult.dimensionScores);

    // 14. Build security checklist summary
    const securityChecklist = this.buildSecurityChecklist(hardGateResult, input.validationResult);

    // 15. Formulate final EvaluationResult
    const evaluationResult: EvaluationResult = {
      evaluationId,
      candidateId,
      toolId: manifest.id,
      toolVersion: manifest.version,
      overallDecision: {
        verdict,
        score: scoringResult.compositeScore,
        confidence: scoringResult.confidenceScore,
        threshold: tierThresholds.minCompositeScore,
        notes:
          decisionRecord.notes ??
          (hardGateResult.passed ? "All hard gates passed." : hardGateResult.rejectionReason),
        evaluatedBy: input.options?.evaluatedBy ?? "CandidateEvaluationService",
        evaluatedAt,
      },
      dimensions: contractDimensions,
      replayTestCount: input.replayResult?.totalScenarioCount ?? 0,
      replaySuccessCount: input.replayResult?.passedScenarioCount ?? 0,
      securityChecklist,
      completedAt: evaluatedAt,
      durationMs,
      decisionRecord,
      shadowResults,
    };

    // 16. Store evaluation result
    this.evaluationStore.set(evaluationId, evaluationResult);
    const existingCandidateEvals = this.candidateEvaluations.get(candidateId) ?? [];
    existingCandidateEvals.push(evaluationId);
    this.candidateEvaluations.set(candidateId, existingCandidateEvals);

    // 17. Notify handlers if registered
    if (decision === "eligible_for_artifact" && this.onEligibilityDecision) {
      await this.onEligibilityDecision(evaluationResult);
    } else if (decision === "repair_requested" && this.onRepairRequested) {
      await this.onRepairRequested(evaluationResult);
    }

    return evaluationResult;
  }

  /**
   * Retrieves an EvaluationResult by evaluationId.
   */
  getEvaluation(evaluationId: string): EvaluationResult | undefined {
    return this.evaluationStore.get(evaluationId);
  }

  /**
   * Lists all evaluation results, optionally filtered by candidateId.
   */
  listEvaluations(candidateId?: string): EvaluationResult[] {
    if (candidateId) {
      const evalIds = this.candidateEvaluations.get(candidateId) ?? [];
      return evalIds
        .map((id) => this.evaluationStore.get(id))
        .filter((r): r is EvaluationResult => r !== undefined);
    }
    return Array.from(this.evaluationStore.values());
  }

  /**
   * Retrieves the full decision record for an evaluation.
   */
  getDecisionRecord(evaluationId: string): EvaluationDecisionRecord | undefined {
    return this.evaluationStore.get(evaluationId)?.decisionRecord;
  }

  /**
   * Generates a shadow policy calibration report.
   */
  getCalibrationReport(
    shadowPolicyId: string,
    shadowPolicyVersion = "1.0.0",
  ): ShadowCalibrationReport {
    return this.shadowCalibrationAggregator.generateReport(shadowPolicyId, shadowPolicyVersion);
  }

  /**
   * Registers a new or updated policy in the service registry.
   */
  registerPolicy(policy: EvaluationPolicy): void {
    this.policyRegistry.register(policy);
  }

  /**
   * Retrieves a policy by ID and version.
   */
  getPolicy(policyId: string, version?: string): EvaluationPolicy | undefined {
    return this.policyRegistry.get(policyId, version);
  }

  /**
   * Lists all available evaluation policies.
   */
  listPolicies(): EvaluationPolicy[] {
    return this.policyRegistry.list();
  }

  /**
   * Determines deterministic evaluation decision from gates, scores, and regressions.
   */
  private renderDecision(params: {
    validationResult: CandidateValidationResult;
    replayResult?: HistoricalReplayResult;
    hardGateResult: HardGateResult;
    scoringResult: {
      passed: boolean;
      compositeScore: number;
      confidenceScore: number;
      minRequiredConfidence: number;
      thresholdScore: number;
    };
    regressionResult?: UpdateRegressionResult;
  }): EvaluationDecision {
    const { validationResult, replayResult, hardGateResult, scoringResult, regressionResult } =
      params;

    // 1. Infrastructure failures trigger retry
    if (
      validationResult.status === "infrastructure_fail" ||
      replayResult?.status === "infrastructure_failure"
    ) {
      return "infrastructure_retry";
    }

    // 2. Non-negotiable hard gate check (Hard gate failures prevent eligibility regardless of soft scores)
    if (!hardGateResult.passed) {
      if (
        hardGateResult.failedGates.length === 1 &&
        hardGateResult.failedGates[0] === "evidence_completeness"
      ) {
        return "deferred_for_more_evidence";
      }
      return hardGateResult.canRepair ? "repair_requested" : "rejected";
    }

    // 3. Update regression check (Blocks regressive updates)
    if (regressionResult && !regressionResult.passed) {
      return "repair_requested";
    }
    // 4. Low evidence confidence check
    if (scoringResult.confidenceScore < scoringResult.minRequiredConfidence) {
      return "deferred_for_more_evidence";
    }

    // 5. Soft score qualification
    if (scoringResult.passed) {
      return "eligible_for_artifact";
    }

    // 6. Soft score failure below threshold
    return "repair_requested";
  }

  /**
   * Formulates structured repair targets and actionable guidance.
   */
  private formulateRepairGuidance(params: {
    hardGateResult: HardGateResult;
    validationResult: CandidateValidationResult;
    replayResult?: HistoricalReplayResult;
    regressionResult?: UpdateRegressionResult;
  }): EvaluationRepairGuidance {
    const { hardGateResult, validationResult, replayResult, regressionResult } = params;

    const repairTargets = new Set<string>();
    const suggestedFixes: string[] = [];

    if (hardGateResult.repairTargets) {
      for (const t of hardGateResult.repairTargets) {
        repairTargets.add(t);
      }
    }

    if (validationResult.repairFeedback) {
      for (const fix of validationResult.repairFeedback.suggestedFixes) {
        suggestedFixes.push(fix);
      }
    }

    const failedTestNames: string[] = [];
    if (validationResult.testReport) {
      for (const r of validationResult.testReport.results) {
        if (!r.passed) {
          failedTestNames.push(r.name);
          repairTargets.add(`Fix failing test: ${r.name}`);
        }
      }
    }

    const divergenceFindings = replayResult?.divergenceFindings ?? [];
    for (const div of divergenceFindings) {
      repairTargets.add(`Resolve replay divergence: ${div.message}`);
    }

    if (regressionResult && !regressionResult.passed) {
      for (const finding of regressionResult.findings) {
        if (finding.severity === "critical") {
          repairTargets.add(`Resolve baseline regression: ${finding.message}`);
          suggestedFixes.push(finding.message);
        }
      }
    }

    const primaryBlocker =
      hardGateResult.rejectionReason ??
      (regressionResult?.summary || "Candidate did not satisfy minimum evaluation thresholds.");

    return {
      canRepair: hardGateResult.canRepair,
      primaryBlocker,
      repairTargets: Array.from(repairTargets),
      suggestedFixes,
      staticFindings: validationResult.staticFindings,
      failedTestNames,
      divergenceFindings,
      suggestedCapabilities: validationResult.repairFeedback?.recommendedChanges.capabilities,
    };
  }

  /**
   * Computes a canonical SHA-256 digest for deterministic repeatability.
   */
  private computeDecisionDigest(summary: {
    candidateId: string;
    toolId: string;
    toolVersion: string;
    policyId: string;
    policyVersion: string;
    riskTier: RiskTier;
    decision: EvaluationDecision;
    compositeScore: number;
    confidenceScore: number;
    hardGates: Array<{ gate: string; passed: boolean }>;
    dimensionScores: Array<{ dimension: string; adjustedScore: number; passed: boolean }>;
  }): string {
    const sortedGates = [...summary.hardGates].sort((a, b) => a.gate.localeCompare(b.gate));
    const sortedDims = [...summary.dimensionScores].sort((a, b) =>
      a.dimension.localeCompare(b.dimension),
    );

    return hashCanonical({
      candidateId: summary.candidateId,
      toolId: summary.toolId,
      toolVersion: summary.toolVersion,
      policyId: summary.policyId,
      policyVersion: summary.policyVersion,
      riskTier: summary.riskTier,
      decision: summary.decision,
      compositeScore: summary.compositeScore,
      confidenceScore: summary.confidenceScore,
      hardGates: sortedGates,
      dimensionScores: sortedDims,
    });
  }

  /**
   * Maps 9 internal dimension scores to the contract's standard EvaluationDimension array.
   */
  private mapToContractDimensions(
    dimensionScores: DimensionScore[],
  ): ContractEvaluationDimension[] {
    const results: ContractEvaluationDimension[] = [];

    for (const d of dimensionScores) {
      const contractName = DIMENSION_TO_CONTRACT_NAME[d.dimension];
      if (contractName) {
        results.push({
          name: contractName,
          weight: d.weight,
          score: d.adjustedScore,
          threshold: d.threshold,
          passed: d.passed,
          metrics: d.metrics,
          details: d.details,
        });
      }
    }

    return results;
  }

  /**
   * Builds boolean security checklist based on static analysis findings and gates.
   */
  private buildSecurityChecklist(
    hardGateResult: HardGateResult,
    validationResult: CandidateValidationResult,
  ): Record<string, boolean> {
    const errors = validationResult.staticFindings.filter((f) => f.severity === "error");
    const warnings = validationResult.staticFindings.filter((f) => f.severity === "warning");

    return {
      typecheckPassed: validationResult.typecheckPassed,
      noForbiddenImports: !hardGateResult.failedGates.includes("no_forbidden_imports"),
      manifestParity: !hardGateResult.failedGates.includes("manifest_capability_parity"),
      envelopeCompliant: !hardGateResult.failedGates.includes("envelope_bounds"),
      zeroStaticErrors: errors.length === 0,
      staticWarningsAcceptable: warnings.length <= 5,
    };
  }

  private extractCandidateInfo(candidate: CandidateEvaluationInput["candidate"]): {
    candidateId: string;
    revisionId?: string;
    manifest: ToolManifest;
    sourceCode: string;
    requiredCapabilities?: CapabilityManifest;
  } {
    return extractCandidateInfo(candidate);
  }
  resolveActiveBaseline(
    baseline: ActiveToolBaseline | CandidateRevision | EvolutionCandidate,
  ): ActiveToolBaseline | undefined {
    return resolveActiveBaseline(baseline);
  }
}

/**
 * Helper extracting uniform metadata from various candidate target representations.
 */
export function extractCandidateInfo(candidate: CandidateEvaluationInput["candidate"]): {
  candidateId: string;
  revisionId?: string;
  manifest: ToolManifest;
  sourceCode: string;
  requiredCapabilities?: CapabilityManifest;
} {
  if ("artifacts" in candidate && candidate.artifacts) {
    const rev = candidate as CandidateRevision;
    return {
      candidateId: rev.candidateId,
      revisionId: rev.revisionId,
      manifest: rev.artifacts.manifest,
      sourceCode: rev.artifacts.sourceCode,
      requiredCapabilities: rev.artifacts.capabilities,
    };
  }

  if ("proposedTool" in candidate && candidate.proposedTool) {
    const ec = candidate as EvolutionCandidate;
    return {
      candidateId: ec.id,
      manifest: ec.proposedTool,
      sourceCode: ec.sourceCode ?? "",
      requiredCapabilities: ec.requiredCapabilities,
    };
  }

  const custom = candidate as {
    id?: string;
    candidateId?: string;
    revisionId?: string;
    manifest: ToolManifest;
    sourceCode: string;
    requiredCapabilities?: CapabilityManifest;
  };

  return {
    candidateId: custom.candidateId ?? custom.id ?? "unknown-candidate",
    revisionId: custom.revisionId,
    manifest: custom.manifest,
    sourceCode: custom.sourceCode,
    requiredCapabilities: custom.requiredCapabilities,
  };
}

/**
 * Helper extracting baseline object from various forms.
 */
export function resolveActiveBaseline(
  baseline: ActiveToolBaseline | CandidateRevision | EvolutionCandidate,
): ActiveToolBaseline | undefined {
  if ("manifest" in baseline && "toolVersion" in baseline) {
    return baseline as ActiveToolBaseline;
  }

  if ("artifacts" in baseline && baseline.artifacts) {
    const rev = baseline as CandidateRevision;
    return {
      toolId: rev.artifacts.manifest.id,
      toolVersion: rev.artifacts.manifest.version,
      manifest: rev.artifacts.manifest,
      sourceCode: rev.artifacts.sourceCode,
      capabilities: rev.artifacts.capabilities,
    };
  }

  if ("proposedTool" in baseline && baseline.proposedTool) {
    const ec = baseline as EvolutionCandidate;
    return {
      toolId: ec.proposedTool.id,
      toolVersion: ec.proposedTool.version,
      manifest: ec.proposedTool,
      sourceCode: ec.sourceCode ?? "",
      capabilities: ec.requiredCapabilities,
    };
  }

  return undefined;
}

/**
 * Factory function creating a CandidateEvaluationService instance.
 */
export function createCandidateEvaluationService(
  options: CandidateEvaluationServiceOptions = {},
): CandidateEvaluationService {
  return new CandidateEvaluationService(options);
}
