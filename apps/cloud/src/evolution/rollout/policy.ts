import { type RolloutPolicy, RolloutPolicySchema, type RolloutRiskTier } from "./types.js";

/**
 * Built-in default rollout policies indexed by risk tier.
 */
export const DEFAULT_ROLLOUT_POLICIES: Record<RolloutRiskTier, RolloutPolicy> = {
  tier1_low: {
    policyId: "policy_tier1_low_v1",
    version: 1,
    name: "Low Risk Tier Policy",
    description: "Default policy for low-risk, internal, or pure read-only tool updates",
    riskTier: "tier1_low",
    canaryExposureRatio: 0.1, // 10% canary traffic
    minInvocations: 10,
    maxFailures: 1,
    maxFailureRate: 0.02, // 2% max error rate
    latencyTolerances: {
      maxP95LatencyMs: 3000,
      maxP99LatencyMs: 6000,
      maxAllowedLatencyRegressionPercent: 25,
    },
    confidenceThreshold: 0.85,
    cooldownDurationMs: 1800000, // 30 minutes cooldown
    timeoutMs: 3600000, // 1 hour timeout
    minObservationDurationMs: 0,
    requiredCleanWindows: 1,
    allowAutoPromotion: true,
    allowAutoRollback: true,
  },
  tier2_medium: {
    policyId: "policy_tier2_medium_v1",
    version: 1,
    name: "Medium Risk Tier Policy",
    description: "Policy for standard mutations and medium complexity updates",
    riskTier: "tier2_medium",
    canaryExposureRatio: 0.05, // 5% canary traffic
    minInvocations: 20,
    maxFailures: 2,
    maxFailureRate: 0.01, // 1% max error rate
    latencyTolerances: {
      maxP95LatencyMs: 2500,
      maxP99LatencyMs: 5000,
      maxAllowedLatencyRegressionPercent: 15,
    },
    confidenceThreshold: 0.9,
    cooldownDurationMs: 3600000, // 1 hour cooldown
    timeoutMs: 7200000, // 2 hours timeout
    minObservationDurationMs: 0,
    requiredCleanWindows: 2,
    allowAutoPromotion: true,
    allowAutoRollback: true,
  },
  tier3_high: {
    policyId: "policy_tier3_high_v1",
    version: 1,
    name: "High Risk Tier Policy",
    description: "Policy for broad system access, high-traffic or high-impact updates",
    riskTier: "tier3_high",
    canaryExposureRatio: 0.02, // 2% canary traffic
    minInvocations: 30,
    maxFailures: 1,
    maxFailureRate: 0.005, // 0.5% max error rate
    latencyTolerances: {
      maxP95LatencyMs: 2000,
      maxP99LatencyMs: 4000,
      maxAllowedLatencyRegressionPercent: 10,
    },
    confidenceThreshold: 0.95,
    cooldownDurationMs: 7200000, // 2 hours cooldown
    timeoutMs: 14400000, // 4 hours timeout
    minObservationDurationMs: 0,
    requiredCleanWindows: 3,
    allowAutoPromotion: true,
    allowAutoRollback: true,
  },
  critical: {
    policyId: "policy_critical_v1",
    version: 1,
    name: "Critical Risk Tier Policy",
    description: "Policy for security-critical, sensitive credentials or critical infrastructure",
    riskTier: "critical",
    canaryExposureRatio: 0.01, // 1% canary traffic
    minInvocations: 50,
    maxFailures: 0,
    maxFailureRate: 0.0,
    latencyTolerances: {
      maxP95LatencyMs: 1500,
      maxP99LatencyMs: 3000,
      maxAllowedLatencyRegressionPercent: 5,
    },
    confidenceThreshold: 0.99,
    cooldownDurationMs: 14400000, // 4 hours cooldown
    timeoutMs: 28800000, // 8 hours timeout
    minObservationDurationMs: 0,
    requiredCleanWindows: 3,
    allowAutoPromotion: false, // Critical tier requires explicit manual approval by default
    allowAutoRollback: true,
  },
};

/**
 * Registry for versioned rollout policies.
 */
export class RolloutPolicyRegistry {
  private policies = new Map<string, Map<number, RolloutPolicy>>();
  private tierDefaults = new Map<RolloutRiskTier, string>();

  constructor(initialPolicies?: RolloutPolicy[]) {
    // Seed default policies
    for (const [tier, policy] of Object.entries(DEFAULT_ROLLOUT_POLICIES)) {
      this.registerPolicy(policy);
      this.tierDefaults.set(tier as RolloutRiskTier, policy.policyId);
    }

    if (initialPolicies) {
      for (const policy of initialPolicies) {
        this.registerPolicy(policy);
      }
    }
  }

  /**
   * Register or update a versioned rollout policy.
   */
  registerPolicy(policy: RolloutPolicy): void {
    const validated = RolloutPolicySchema.parse(policy);
    let versionMap = this.policies.get(validated.policyId);
    if (!versionMap) {
      versionMap = new Map();
      this.policies.set(validated.policyId, versionMap);
    }
    versionMap.set(validated.version, validated);
  }

  /**
   * Get a policy by ID and optional version (defaults to highest version).
   */
  getPolicy(policyId: string, version?: number): RolloutPolicy | undefined {
    const versionMap = this.policies.get(policyId);
    if (!versionMap || versionMap.size === 0) {
      return undefined;
    }

    if (version !== undefined) {
      return versionMap.get(version);
    }

    // Return the latest version
    let latestVersion = 0;
    let latestPolicy: RolloutPolicy | undefined;
    for (const [v, pol] of versionMap.entries()) {
      if (v > latestVersion) {
        latestVersion = v;
        latestPolicy = pol;
      }
    }
    return latestPolicy;
  }

  /**
   * Get the default rollout policy for a risk tier.
   */
  getPolicyForRiskTier(tier: RolloutRiskTier): RolloutPolicy {
    const policyId = this.tierDefaults.get(tier);
    if (policyId) {
      const policy = this.getPolicy(policyId);
      if (policy) return policy;
    }
    return DEFAULT_ROLLOUT_POLICIES[tier] ?? DEFAULT_ROLLOUT_POLICIES.tier1_low;
  }

  /**
   * Set the default policy ID for a risk tier.
   */
  setTierDefaultPolicy(tier: RolloutRiskTier, policyId: string): void {
    if (!this.policies.has(policyId)) {
      throw new Error(`Policy ${policyId} is not registered in registry`);
    }
    this.tierDefaults.set(tier, policyId);
  }

  /**
   * List all latest policy versions.
   */
  listPolicies(): RolloutPolicy[] {
    const result: RolloutPolicy[] = [];
    for (const policyId of this.policies.keys()) {
      const latest = this.getPolicy(policyId);
      if (latest) {
        result.push(latest);
      }
    }
    return result;
  }

  /**
   * Helper to create and register a custom policy.
   */
  createCustomPolicy(
    baseTier: RolloutRiskTier,
    overrides: Partial<RolloutPolicy> & { policyId: string },
  ): RolloutPolicy {
    const base = this.getPolicyForRiskTier(baseTier);
    const policy: RolloutPolicy = {
      ...base,
      ...overrides,
      riskTier: overrides.riskTier ?? base.riskTier,
      version: overrides.version ?? base.version + 1,
      name: overrides.name ?? `${base.name} (Custom)`,
    };
    this.registerPolicy(policy);
    return policy;
  }
}
