import type {
  CapabilityEnvelope,
  CapabilityManifest,
  EvaluationDecision as ContractEvaluationDecision,
  EvaluationDimension as ContractEvaluationDimension,
  EvaluationDimensionName as ContractEvaluationDimensionName,
  EvaluationResult as ContractEvaluationResult,
  EvaluationVerdict,
  EvolutionCandidate,
  NormalizedSessionEvent,
  ToolManifest,
} from "@tool-evolver/contracts";
import type { CandidateRevision, GeneratedArtifactSet } from "../generator/types.js";
import type { OpportunityDetection } from "../opportunity/types.js";
import type {
  DivergenceFinding,
  HistoricalReplayResult,
  ReplayMetricsComparison,
} from "../replay/types.js";
import type { CandidateValidationResult, StaticAnalysisFinding } from "../testing/types.js";

/**
 * Risk tier categorization for candidate tools based on requested capabilities and potential blast radius.
 * Ordered by increasing severity / blast radius.
 */
export type RiskTier =
  | "read_only"
  | "workspace_fs"
  | "network_client"
  | "command_exec"
  | "secret_mediated";

/**
 * High-level eligibility decision rendered for an evolution candidate.
 */
export type EvaluationDecision =
  | "eligible_for_artifact"
  | "repair_requested"
  | "rejected"
  | "deferred_for_more_evidence"
  | "infrastructure_retry";

/**
 * Dimension keys evaluated by the candidate scoring engine.
 */
export type EvaluationDimensionKey =
  | "correctness"
  | "replay_coverage"
  | "security_policy_fit"
  | "reliability"
  | "latency_resources"
  | "token_savings"
  | "time_savings"
  | "utility_recurrence"
  | "maintainability";

/**
 * Risk-tier specific threshold requirements.
 */
export interface RiskTierThresholds {
  minCompositeScore: number;
  minConfidence: number;
  minTestPassRate: number;
  minReplayPassRate: number;
  minCoveragePercent: number;
  maxAllowedStaticWarnings: number;
  requireZeroStaticErrors: boolean;
  minReplayScenarioCount: number;
}

/**
 * Dimension weighting distribution for an evaluation policy.
 */
export interface PolicyDimensionWeights {
  correctness: number;
  replayCoverage: number;
  securityPolicyFit: number;
  reliability: number;
  latencyResources: number;
  tokenSavings: number;
  timeSavings: number;
  utilityRecurrence: number;
  maintainability: number;
}

/**
 * Hard gate configuration flags for an evaluation policy.
 */
export interface PolicyHardGates {
  requireTypecheck: boolean;
  forbidForbiddenImports: boolean;
  requireManifestParity: boolean;
  enforceEnvelopeBounds: boolean;
  forbidCriticalSecurityFindings: boolean;
  requireGeneratedTestsPass: boolean;
  forbidReplayDivergence: boolean;
  requireEvidenceCompleteness: boolean;
  maxAllowedStaticWarnings?: number;
}

/**
 * Minimum test coverage thresholds.
 */
export interface MinimumCoverageRequirements {
  statementCoveragePercent: number;
  branchCoveragePercent: number;
  functionCoveragePercent: number;
}

/**
 * Uncertainty and confidence adjustment configuration.
 */
export interface UncertaintyPolicyConfig {
  minReplayScenariosForFullConfidence: number;
  penaltyPerMissingScenario: number;
  minOccurrencesForFullConfidence: number;
  minDistinctSessionsForFullConfidence: number;
  untestedCodePathPenaltyWeight: number;
}

/**
 * Regression tolerance thresholds for update candidates.
 */
export interface RegressionPolicyThresholds {
  maxAllowedLatencyRegressionPercent: number;
  maxAllowedTokenRegressionPercent: number;
  allowBreakingSchemaChanges: boolean;
  requireStrictInvariantPreservation: boolean;
}

/**
 * Versioned, immutable evaluation policy definition.
 */
export interface EvaluationPolicy {
  policyId: string;
  version: string;
  name: string;
  description: string;
  riskTierThresholds: Record<RiskTier, RiskTierThresholds>;
  weights: PolicyDimensionWeights;
  hardGates: PolicyHardGates;
  minimumCoverageRequirements: MinimumCoverageRequirements;
  uncertaintyConfig: UncertaintyPolicyConfig;
  regressionThresholds: RegressionPolicyThresholds;
  createdAt: string;
  isDefault?: boolean;
}

/**
 * Individual gate check outcome.
 */
export interface GateCheckResult {
  gate: string;
  passed: boolean;
  category: "compiler" | "security" | "manifest" | "envelope" | "tests" | "replay" | "evidence";
  message?: string;
  details?: Record<string, unknown>;
  canRepair?: boolean;
  repairHint?: string;
}

/**
 * Aggregate result of hard gate evaluation.
 */
export interface HardGateResult {
  passed: boolean;
  failedGates: string[];
  gateResults: GateCheckResult[];
  rejectionReason?: string;
  canRepair: boolean;
  repairTargets?: string[];
}

/**
 * Score and assessment for an individual evaluation dimension.
 */
export interface DimensionScore {
  dimension: EvaluationDimensionKey;
  rawScore: number;
  adjustedScore: number;
  weight: number;
  threshold: number;
  passed: boolean;
  confidence: number;
  metrics: Record<string, number | string | boolean>;
  details?: string;
}

/**
 * Structured repair target guidance for failed candidates that are repairable.
 */
export interface EvaluationRepairGuidance {
  canRepair: boolean;
  primaryBlocker: string;
  repairTargets: string[];
  suggestedFixes: string[];
  staticFindings: StaticAnalysisFinding[];
  failedTestNames: string[];
  divergenceFindings: DivergenceFinding[];
  suggestedCapabilities?: Partial<CapabilityManifest>;
}

/**
 * Regression detection result when comparing candidate against prior active version baseline.
 */
export interface UpdateRegressionFinding {
  dimension: string;
  severity: "critical" | "warning";
  baselineValue: number | string | boolean;
  candidateValue: number | string | boolean;
  percentChange?: number;
  message: string;
}

/**
 * Overall comparison outcome against prior baseline.
 */
export interface UpdateRegressionResult {
  hasPriorBaseline: boolean;
  baselineVersion?: string;
  passed: boolean;
  isBreakingChange: boolean;
  findings: UpdateRegressionFinding[];
  criticalRegressionCount: number;
  summary: string;
}

/**
 * Prior active baseline tool information.
 */
export interface ActiveToolBaseline {
  toolId: string;
  toolVersion: string;
  manifest: ToolManifest;
  sourceCode: string;
  capabilities?: CapabilityManifest;
  metrics?: {
    latencyMs?: number;
    tokenUsage?: number;
    successRate?: number;
  };
  validationReport?: CandidateValidationResult;
  replayReport?: HistoricalReplayResult;
}

/**
 * Full record of an evaluation decision.
 */
export interface EvaluationDecisionRecord {
  evaluationId: string;
  candidateId: string;
  revisionId?: string;
  toolId: string;
  toolVersion: string;
  policyId: string;
  policyVersion: string;
  riskTier: RiskTier;
  decision: EvaluationDecision;
  verdict: EvaluationVerdict;
  compositeScore: number;
  confidenceScore: number;
  thresholdScore: number;
  hardGateResult: HardGateResult;
  dimensionScores: DimensionScore[];
  regressionResult?: UpdateRegressionResult;
  digest: string;
  repairGuidance?: EvaluationRepairGuidance;
  deferralReason?: string;
  notes?: string;
  evaluatedAt: string;
  durationMs: number;
}

/**
 * Candidate evaluation input parameter bundle.
 */
export interface CandidateEvaluationInput {
  candidate:
    | EvolutionCandidate
    | CandidateRevision
    | {
        id?: string;
        candidateId?: string;
        revisionId?: string;
        manifest: ToolManifest;
        sourceCode: string;
        requiredCapabilities?: CapabilityManifest;
        workflowDefinition?: Record<string, unknown>;
      };
  validationResult: CandidateValidationResult;
  replayResult?: HistoricalReplayResult;
  opportunity?: OpportunityDetection;
  activeVersionBaseline?: ActiveToolBaseline | CandidateRevision | EvolutionCandidate;
  policy?: EvaluationPolicy | string;
  envelope?: CapabilityEnvelope;
  shadowPolicyIds?: string[];
  options?: CandidateEvaluationOptions;
}

/**
 * Execution options for candidate evaluation.
 */
export interface CandidateEvaluationOptions {
  evaluationId?: string;
  evaluatedBy?: string;
  dryRun?: boolean;
  skipRegressionCheck?: boolean;
  forceRiskTier?: RiskTier;
  allowBreakingChanges?: boolean;
  notes?: string;
}

/**
 * Result of evaluating candidate against a shadow policy.
 */
export interface ShadowEvaluationResult {
  shadowPolicyId: string;
  shadowPolicyVersion: string;
  decision: EvaluationDecision;
  verdict: EvaluationVerdict;
  compositeScore: number;
  confidenceScore: number;
  hardGatePassed: boolean;
  agreementWithActive: boolean;
  scoreDeltaWithActive: number;
  differingDimensions: EvaluationDimensionKey[];
  differingGates: string[];
}

/**
 * Calibration metrics aggregated across multiple shadow policy runs.
 */
export interface ShadowCalibrationReport {
  shadowPolicyId: string;
  shadowPolicyVersion: string;
  activePolicyId: string;
  sampleCount: number;
  agreementCount: number;
  agreementRate: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  meanScoreDelta: number;
  maxScoreDelta: number;
  disagreements: Array<{
    candidateId: string;
    activeDecision: EvaluationDecision;
    shadowDecision: EvaluationDecision;
    activeScore: number;
    shadowScore: number;
    reason: string;
  }>;
}

/**
 * Extended evaluation result conforming to contracts while carrying full decision details.
 */
export interface EvaluationResult extends ContractEvaluationResult {
  decisionRecord: EvaluationDecisionRecord;
  shadowResults?: ShadowEvaluationResult[];
}
