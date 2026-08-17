import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLLOUT_POLICIES,
  RolloutPolicyRegistry,
} from "../../../src/evolution/rollout/policy.js";
import { type RolloutPolicy } from "../../../src/evolution/rollout/types.js";

describe("RolloutPolicyRegistry - Policy Management & Tiered Configurations", () => {
  it("should provide valid default policies across all risk tiers", () => {
    const registry = new RolloutPolicyRegistry();

    const low = registry.getPolicyForRiskTier("tier1_low");
    expect(low.riskTier).toBe("tier1_low");
    expect(low.canaryExposureRatio).toBe(0.1);
    expect(low.allowAutoPromotion).toBe(true);

    const medium = registry.getPolicyForRiskTier("tier2_medium");
    expect(medium.riskTier).toBe("tier2_medium");
    expect(medium.canaryExposureRatio).toBe(0.05);

    const high = registry.getPolicyForRiskTier("tier3_high");
    expect(high.riskTier).toBe("tier3_high");
    expect(high.canaryExposureRatio).toBe(0.02);

    const critical = registry.getPolicyForRiskTier("critical");
    expect(critical.riskTier).toBe("critical");
    expect(critical.canaryExposureRatio).toBe(0.01);
    expect(critical.allowAutoPromotion).toBe(false); // Critical requires manual approval
  });

  it("should register, retrieve, and version custom rollout policies", () => {
    const registry = new RolloutPolicyRegistry();

    const customPolicy: RolloutPolicy = {
      policyId: "custom_microservice_v1",
      version: 1,
      name: "Custom Microservice Policy",
      riskTier: "tier2_medium",
      canaryExposureRatio: 0.08,
      minInvocations: 25,
      maxFailures: 1,
      maxFailureRate: 0.01,
      latencyTolerances: {
        maxP95LatencyMs: 1800,
        maxP99LatencyMs: 3500,
        maxAllowedLatencyRegressionPercent: 12,
      },
      confidenceThreshold: 0.92,
      cooldownDurationMs: 45 * 60 * 1000,
      timeoutMs: 90 * 60 * 1000,
      minObservationDurationMs: 0,
      requiredCleanWindows: 2,
      allowAutoPromotion: true,
      allowAutoRollback: true,
    };

    registry.registerPolicy(customPolicy);

    const retrieved = registry.getPolicy("custom_microservice_v1");
    expect(retrieved).toEqual(customPolicy);

    // Register v2
    const customPolicyV2: RolloutPolicy = {
      ...customPolicy,
      version: 2,
      minInvocations: 50,
    };
    registry.registerPolicy(customPolicyV2);

    // Latest version returns v2
    expect(registry.getPolicy("custom_microservice_v1")?.version).toBe(2);
    // Explicit version lookup returns v1
    expect(registry.getPolicy("custom_microservice_v1", 1)?.minInvocations).toBe(25);
  });

  it("should allow creating custom policy with overrides", () => {
    const registry = new RolloutPolicyRegistry();

    const custom = registry.createCustomPolicy("tier1_low", {
      policyId: "fast_track_low_v1",
      minInvocations: 5,
      canaryExposureRatio: 0.2,
    });

    expect(custom.policyId).toBe("fast_track_low_v1");
    expect(custom.minInvocations).toBe(5);
    expect(custom.canaryExposureRatio).toBe(0.2);
    expect(registry.getPolicy("fast_track_low_v1")).toBeDefined();
  });

  it("should list all registered policy versions", () => {
    const registry = new RolloutPolicyRegistry();
    const list = registry.listPolicies();

    expect(list.length).toBeGreaterThanOrEqual(4);
    const policyIds = list.map((p) => p.policyId);
    expect(policyIds).toContain("policy_tier1_low_v1");
    expect(policyIds).toContain("policy_critical_v1");
  });
});
