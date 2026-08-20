import type { CapabilityManifest, ToolManifest } from "@tool-evolver/contracts";
import type {
  EvaluationPolicy,
  PolicyDimensionWeights,
  PolicyHardGates,
  RegressionPolicyThresholds,
  RiskTier,
  RiskTierThresholds,
  UncertaintyPolicyConfig,
} from "./types.js";

/**
 * Risk tier severity ranking from 0 (lowest) to 4 (highest).
 */
export const RISK_TIER_SEVERITY_ORDER: Record<RiskTier, number> = {
  read_only: 0,
  workspace_fs: 1,
  network_client: 2,
  command_exec: 3,
  secret_mediated: 4,
};

/**
 * Returns numeric severity rank for a risk tier.
 */
export function getRiskTierRank(tier: RiskTier): number {
  return RISK_TIER_SEVERITY_ORDER[tier] ?? 0;
}

/**
 * Checks if tierA is at least as risky as tierB.
 */
export function isRiskTierAtLeast(tierA: RiskTier, tierB: RiskTier): boolean {
  return getRiskTierRank(tierA) >= getRiskTierRank(tierB);
}

/**
 * Deterministically classifies the risk tier of a candidate tool given its manifest and capabilities.
 */
export function classifyRiskTier(
  manifest?: ToolManifest,
  capabilities?: CapabilityManifest,
): RiskTier {
  const cap = capabilities ?? manifest?.capabilities;
  if (!cap) {
    return "read_only";
  }

  // 1. Secret-mediated access (highest blast radius)
  if (
    (cap.secrets?.allowedSecretNames && cap.secrets.allowedSecretNames.length > 0) ||
    (cap.secrets?.allowedPrefixes && cap.secrets.allowedPrefixes.length > 0)
  ) {
    return "secret_mediated";
  }

  // 2. Command / shell execution
  if (cap.command?.allowedCommands && cap.command.allowedCommands.length > 0) {
    return "command_exec";
  }

  // 3. Network client
  if (
    cap.net?.allowOutbound === true ||
    (cap.net?.allowedDomains && cap.net.allowedDomains.length > 0)
  ) {
    return "network_client";
  }

  // 4. Workspace filesystem write
  if (cap.fs?.writePaths && cap.fs.writePaths.length > 0) {
    return "workspace_fs";
  }

  // 5. Default / read-only
  return "read_only";
}

/**
 * Standard Production Risk-Tier Thresholds.
 * Riskier capability classes enforce progressively stricter thresholds.
 */
export const STANDARD_RISK_TIER_THRESHOLDS: Record<RiskTier, RiskTierThresholds> = {
  read_only: {
    minCompositeScore: 0.7,
    minConfidence: 0.6,
    minTestPassRate: 1.0,
    minReplayPassRate: 0.8,
    minCoveragePercent: 70,
    maxAllowedStaticWarnings: 5,
    requireZeroStaticErrors: true,
    minReplayScenarioCount: 1,
  },
  workspace_fs: {
    minCompositeScore: 0.8,
    minConfidence: 0.7,
    minTestPassRate: 1.0,
    minReplayPassRate: 0.85,
    minCoveragePercent: 80,
    maxAllowedStaticWarnings: 3,
    requireZeroStaticErrors: true,
    minReplayScenarioCount: 2,
  },
  network_client: {
    minCompositeScore: 0.85,
    minConfidence: 0.8,
    minTestPassRate: 1.0,
    minReplayPassRate: 0.9,
    minCoveragePercent: 85,
    maxAllowedStaticWarnings: 2,
    requireZeroStaticErrors: true,
    minReplayScenarioCount: 2,
  },
  command_exec: {
    minCompositeScore: 0.9,
    minConfidence: 0.85,
    minTestPassRate: 1.0,
    minReplayPassRate: 1.0,
    minCoveragePercent: 90,
    maxAllowedStaticWarnings: 1,
    requireZeroStaticErrors: true,
    minReplayScenarioCount: 3,
  },
  secret_mediated: {
    minCompositeScore: 0.95,
    minConfidence: 0.9,
    minTestPassRate: 1.0,
    minReplayPassRate: 1.0,
    minCoveragePercent: 95,
    maxAllowedStaticWarnings: 0,
    requireZeroStaticErrors: true,
    minReplayScenarioCount: 3,
  },
};

/**
 * Standard Production Policy Weights (sum = 1.0).
 */
export const STANDARD_DIMENSION_WEIGHTS: PolicyDimensionWeights = {
  correctness: 0.25,
  replayCoverage: 0.2,
  securityPolicyFit: 0.15,
  reliability: 0.1,
  latencyResources: 0.08,
  tokenSavings: 0.08,
  timeSavings: 0.05,
  utilityRecurrence: 0.05,
  maintainability: 0.04,
};

/**
 * Standard Hard Gates configuration.
 */
export const STANDARD_HARD_GATES: PolicyHardGates = {
  requireTypecheck: true,
  forbidForbiddenImports: true,
  requireManifestParity: true,
  enforceEnvelopeBounds: true,
  forbidCriticalSecurityFindings: true,
  requireGeneratedTestsPass: true,
  forbidReplayDivergence: true,
  requireEvidenceCompleteness: true,
  requireWorkflowCoverage: true,
  requireWorkloadCostNonRegression: true,
  maxAllowedStaticWarnings: 10,
};

/**
 * Standard Minimum Coverage Requirements.
 */
export const STANDARD_COVERAGE_REQUIREMENTS = {
  statementCoveragePercent: 70,
  branchCoveragePercent: 60,
  functionCoveragePercent: 75,
};

/**
 * Standard Uncertainty Policy Configuration.
 */
export const STANDARD_UNCERTAINTY_CONFIG: UncertaintyPolicyConfig = {
  minReplayScenariosForFullConfidence: 3,
  penaltyPerMissingScenario: 0.15,
  minOccurrencesForFullConfidence: 2,
  minDistinctSessionsForFullConfidence: 2,
  untestedCodePathPenaltyWeight: 0.2,
};

/**
 * Standard Regression Thresholds.
 */
export const STANDARD_REGRESSION_THRESHOLDS: RegressionPolicyThresholds = {
  maxAllowedLatencyRegressionPercent: 20,
  maxAllowedTokenRegressionPercent: 15,
  allowBreakingSchemaChanges: false,
  requireStrictInvariantPreservation: true,
};

/**
 * Canonical Standard Evaluation Policy V1.
 */
export const STANDARD_EVALUATION_POLICY_V1: EvaluationPolicy = {
  policyId: "standard-policy",
  version: "1.0.0",
  name: "Standard Evaluation Policy v1",
  description:
    "Standard production evaluation policy enforcing risk-tiered safety gates and multi-dimensional scoring.",
  riskTierThresholds: STANDARD_RISK_TIER_THRESHOLDS,
  weights: STANDARD_DIMENSION_WEIGHTS,
  hardGates: STANDARD_HARD_GATES,
  minimumCoverageRequirements: STANDARD_COVERAGE_REQUIREMENTS,
  uncertaintyConfig: STANDARD_UNCERTAINTY_CONFIG,
  regressionThresholds: STANDARD_REGRESSION_THRESHOLDS,
  createdAt: "2026-01-01T00:00:00.000Z",
  isDefault: true,
};

/**
 * Strict Evaluation Policy V1 (High-assurance / sensitive workloads).
 */
export const STRICT_EVALUATION_POLICY_V1: EvaluationPolicy = {
  policyId: "strict-policy",
  version: "1.0.0",
  name: "Strict Evaluation Policy v1",
  description:
    "Zero-tolerance high-assurance evaluation policy requiring full test pass, high replay fidelity, and strict envelope compliance.",
  riskTierThresholds: {
    read_only: {
      minCompositeScore: 0.85,
      minConfidence: 0.8,
      minTestPassRate: 1.0,
      minReplayPassRate: 0.95,
      minCoveragePercent: 85,
      maxAllowedStaticWarnings: 1,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 2,
    },
    workspace_fs: {
      minCompositeScore: 0.9,
      minConfidence: 0.85,
      minTestPassRate: 1.0,
      minReplayPassRate: 1.0,
      minCoveragePercent: 90,
      maxAllowedStaticWarnings: 0,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 3,
    },
    network_client: {
      minCompositeScore: 0.95,
      minConfidence: 0.9,
      minTestPassRate: 1.0,
      minReplayPassRate: 1.0,
      minCoveragePercent: 95,
      maxAllowedStaticWarnings: 0,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 3,
    },
    command_exec: {
      minCompositeScore: 0.98,
      minConfidence: 0.95,
      minTestPassRate: 1.0,
      minReplayPassRate: 1.0,
      minCoveragePercent: 98,
      maxAllowedStaticWarnings: 0,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 4,
    },
    secret_mediated: {
      minCompositeScore: 0.99,
      minConfidence: 0.98,
      minTestPassRate: 1.0,
      minReplayPassRate: 1.0,
      minCoveragePercent: 100,
      maxAllowedStaticWarnings: 0,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 5,
    },
  },
  weights: {
    correctness: 0.3,
    replayCoverage: 0.25,
    securityPolicyFit: 0.2,
    reliability: 0.1,
    latencyResources: 0.05,
    tokenSavings: 0.04,
    timeSavings: 0.02,
    utilityRecurrence: 0.02,
    maintainability: 0.02,
  },
  hardGates: {
    ...STANDARD_HARD_GATES,
    maxAllowedStaticWarnings: 2,
  },
  minimumCoverageRequirements: {
    statementCoveragePercent: 85,
    branchCoveragePercent: 80,
    functionCoveragePercent: 90,
  },
  uncertaintyConfig: {
    minReplayScenariosForFullConfidence: 4,
    penaltyPerMissingScenario: 0.25,
    minOccurrencesForFullConfidence: 3,
    minDistinctSessionsForFullConfidence: 3,
    untestedCodePathPenaltyWeight: 0.35,
  },
  regressionThresholds: {
    maxAllowedLatencyRegressionPercent: 5,
    maxAllowedTokenRegressionPercent: 5,
    allowBreakingSchemaChanges: false,
    requireStrictInvariantPreservation: true,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  isDefault: false,
};

/**
 * Permissive / Development Policy V1.
 */
export const PERMISSIVE_EVALUATION_POLICY_V1: EvaluationPolicy = {
  policyId: "permissive-policy",
  version: "1.0.0",
  name: "Permissive Development Policy v1",
  description: "Relaxed policy for local development and rapid iterative experimentation.",
  riskTierThresholds: {
    read_only: {
      minCompositeScore: 0.5,
      minConfidence: 0.4,
      minTestPassRate: 0.9,
      minReplayPassRate: 0.5,
      minCoveragePercent: 50,
      maxAllowedStaticWarnings: 20,
      requireZeroStaticErrors: false,
      minReplayScenarioCount: 0,
    },
    workspace_fs: {
      minCompositeScore: 0.6,
      minConfidence: 0.5,
      minTestPassRate: 0.95,
      minReplayPassRate: 0.6,
      minCoveragePercent: 60,
      maxAllowedStaticWarnings: 15,
      requireZeroStaticErrors: false,
      minReplayScenarioCount: 1,
    },
    network_client: {
      minCompositeScore: 0.65,
      minConfidence: 0.55,
      minTestPassRate: 0.95,
      minReplayPassRate: 0.7,
      minCoveragePercent: 65,
      maxAllowedStaticWarnings: 10,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 1,
    },
    command_exec: {
      minCompositeScore: 0.75,
      minConfidence: 0.65,
      minTestPassRate: 1.0,
      minReplayPassRate: 0.8,
      minCoveragePercent: 75,
      maxAllowedStaticWarnings: 5,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 1,
    },
    secret_mediated: {
      minCompositeScore: 0.85,
      minConfidence: 0.75,
      minTestPassRate: 1.0,
      minReplayPassRate: 0.9,
      minCoveragePercent: 85,
      maxAllowedStaticWarnings: 2,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 2,
    },
  },
  weights: {
    correctness: 0.35,
    replayCoverage: 0.15,
    securityPolicyFit: 0.15,
    reliability: 0.1,
    latencyResources: 0.05,
    tokenSavings: 0.05,
    timeSavings: 0.05,
    utilityRecurrence: 0.05,
    maintainability: 0.05,
  },
  hardGates: {
    requireTypecheck: true,
    forbidForbiddenImports: true,
    requireManifestParity: true,
    enforceEnvelopeBounds: true,
    forbidCriticalSecurityFindings: true,
    requireGeneratedTestsPass: false,
    forbidReplayDivergence: false,
    requireEvidenceCompleteness: false,
    requireWorkflowCoverage: true,
    requireWorkloadCostNonRegression: true,
    maxAllowedStaticWarnings: 30,
  },
  minimumCoverageRequirements: {
    statementCoveragePercent: 40,
    branchCoveragePercent: 30,
    functionCoveragePercent: 40,
  },
  uncertaintyConfig: {
    minReplayScenariosForFullConfidence: 1,
    penaltyPerMissingScenario: 0.05,
    minOccurrencesForFullConfidence: 1,
    minDistinctSessionsForFullConfidence: 1,
    untestedCodePathPenaltyWeight: 0.05,
  },
  regressionThresholds: {
    maxAllowedLatencyRegressionPercent: 50,
    maxAllowedTokenRegressionPercent: 40,
    allowBreakingSchemaChanges: true,
    requireStrictInvariantPreservation: false,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  isDefault: false,
};

/**
 * Shadow Calibration Policy V1.
 */
export const SHADOW_CALIBRATION_POLICY_V1: EvaluationPolicy = {
  policyId: "shadow-calibration-policy",
  version: "1.0.0",
  name: "Shadow Calibration Policy v1",
  description:
    "Candidate calibration policy testing prospective threshold elevations in shadow mode.",
  riskTierThresholds: {
    read_only: {
      minCompositeScore: 0.75,
      minConfidence: 0.65,
      minTestPassRate: 1.0,
      minReplayPassRate: 0.85,
      minCoveragePercent: 75,
      maxAllowedStaticWarnings: 3,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 1,
    },
    workspace_fs: {
      minCompositeScore: 0.85,
      minConfidence: 0.75,
      minTestPassRate: 1.0,
      minReplayPassRate: 0.9,
      minCoveragePercent: 85,
      maxAllowedStaticWarnings: 2,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 2,
    },
    network_client: {
      minCompositeScore: 0.9,
      minConfidence: 0.85,
      minTestPassRate: 1.0,
      minReplayPassRate: 0.95,
      minCoveragePercent: 90,
      maxAllowedStaticWarnings: 1,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 2,
    },
    command_exec: {
      minCompositeScore: 0.92,
      minConfidence: 0.88,
      minTestPassRate: 1.0,
      minReplayPassRate: 1.0,
      minCoveragePercent: 92,
      maxAllowedStaticWarnings: 0,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 3,
    },
    secret_mediated: {
      minCompositeScore: 0.96,
      minConfidence: 0.92,
      minTestPassRate: 1.0,
      minReplayPassRate: 1.0,
      minCoveragePercent: 96,
      maxAllowedStaticWarnings: 0,
      requireZeroStaticErrors: true,
      minReplayScenarioCount: 3,
    },
  },
  weights: STANDARD_DIMENSION_WEIGHTS,
  hardGates: STANDARD_HARD_GATES,
  minimumCoverageRequirements: {
    statementCoveragePercent: 75,
    branchCoveragePercent: 65,
    functionCoveragePercent: 80,
  },
  uncertaintyConfig: STANDARD_UNCERTAINTY_CONFIG,
  regressionThresholds: STANDARD_REGRESSION_THRESHOLDS,
  createdAt: "2026-01-01T00:00:00.000Z",
  isDefault: false,
};

/**
 * Registry managing versioned evaluation policies.
 */
export class EvaluationPolicyRegistry {
  private policies = new Map<string, EvaluationPolicy>();
  private defaultPolicyId = "standard-policy";

  constructor() {
    this.register(STANDARD_EVALUATION_POLICY_V1);
    this.register(STRICT_EVALUATION_POLICY_V1);
    this.register(PERMISSIVE_EVALUATION_POLICY_V1);
    this.register(SHADOW_CALIBRATION_POLICY_V1);
  }

  /**
   * Registers or updates a policy in the registry.
   */
  register(policy: EvaluationPolicy): void {
    const key = this.getKey(policy.policyId, policy.version);
    this.policies.set(key, policy);
    // Also store latest unversioned lookup
    this.policies.set(policy.policyId, policy);
    if (policy.isDefault) {
      this.defaultPolicyId = policy.policyId;
    }
  }

  /**
   * Retrieves a policy by ID and optional version.
   */
  get(policyId: string, version?: string): EvaluationPolicy | undefined {
    if (version) {
      return this.policies.get(this.getKey(policyId, version));
    }
    return this.policies.get(policyId);
  }

  /**
   * Resolves a policy object or policyId to an EvaluationPolicy, falling back to default.
   */
  resolve(policyOrId?: EvaluationPolicy | string): EvaluationPolicy {
    if (typeof policyOrId === "object" && policyOrId !== null) {
      return policyOrId;
    }
    if (typeof policyOrId === "string") {
      const found = this.get(policyOrId);
      if (found) return found;
    }
    const defaultPolicy = this.get(this.defaultPolicyId);
    if (!defaultPolicy) {
      return STANDARD_EVALUATION_POLICY_V1;
    }
    return defaultPolicy;
  }

  /**
   * Returns all registered unique policies.
   */
  list(): EvaluationPolicy[] {
    const unique = new Map<string, EvaluationPolicy>();
    for (const [k, p] of this.policies.entries()) {
      if (k.includes("@")) {
        unique.set(k, p);
      }
    }
    return Array.from(unique.values());
  }

  /**
   * Sets default policy ID.
   */
  setDefaultPolicy(policyId: string): void {
    if (this.policies.has(policyId)) {
      this.defaultPolicyId = policyId;
    }
  }

  private getKey(id: string, version: string): string {
    return `${id}@${version}`;
  }
}

/**
 * Global default policy registry instance.
 */
export const defaultPolicyRegistry = new EvaluationPolicyRegistry();
