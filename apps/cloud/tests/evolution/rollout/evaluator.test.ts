import { describe, expect, it } from "vitest";
import {
  RolloutEvaluator,
  aggregateTelemetryEvents,
  computeLatencyPercentiles,
} from "../../../src/evolution/rollout/evaluator.js";
import { DEFAULT_ROLLOUT_POLICIES } from "../../../src/evolution/rollout/policy.js";
import {
  type CanaryMetricsWindow,
  type RolloutEntity,
} from "../../../src/evolution/rollout/types.js";
import { TEST_WORKSPACE_ID } from "./helpers.js";

describe("RolloutEvaluator - Metrics & Rollback Evaluation", () => {
  const evaluator = new RolloutEvaluator();
  const defaultPolicy = DEFAULT_ROLLOUT_POLICIES.tier1_low;

  function createBaseRollout(
    state: RolloutEntity["state"] = "canary",
    consecutiveCleanWindows = 0,
  ): RolloutEntity {
    return {
      id: "rollout_eval_001",
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "math_calculator",
      targetVersion: "2.0.0",
      previousVersion: "1.0.0",
      artifactDigest: "art_digest_1",
      manifestDigest: "mnf_digest_1",
      riskTier: "tier1_low",
      policyId: "policy_tier1_low_v1",
      state,
      canaryTrafficPercentage: 10,
      invocationsCount: 10,
      failureCount: 0,
      consecutiveCleanWindows,
      metrics: null,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function createBaseMetrics(
    overrides?: Partial<CanaryMetricsWindow>,
  ): CanaryMetricsWindow {
    return {
      windowStart: new Date(Date.now() - 60000).toISOString(),
      windowEnd: new Date().toISOString(),
      totalInvocations: 10,
      successCount: 10,
      failureCount: 0,
      successRate: 1.0,
      errorRate: 0.0,
      latenciesMs: [20, 25, 30, 35, 40],
      p50LatencyMs: 30,
      p95LatencyMs: 40,
      p99LatencyMs: 40,
      policyViolations: 0,
      securityViolations: 0,
      quarantineSignals: 0,
      capabilityBreaches: 0,
      schemaMismatches: 0,
      signatureValid: true,
      activeDevicesCount: 2,
      offlineDevicesCount: 0,
      deviceReportingRate: 1.0,
      quarantineReasons: [],
      securityViolationDetails: [],
      ...overrides,
    };
  }

  it("should trigger immediate rollback on security violation", () => {
    const rollout = createBaseRollout("canary");
    const metrics = createBaseMetrics({
      securityViolations: 1,
      securityViolationDetails: [
        {
          type: "security_violation",
          reason: "Unauthorized socket connection to unauthorized host",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const decision = evaluator.evaluateCanaryMetrics({
      rollout,
      policy: defaultPolicy,
      metrics,
    });

    expect(decision.action).toBe("trigger_rollback");
    expect(decision.toState).toBe("rollback_pending");
    expect(decision.confidence).toBe(1.0);
    expect(decision.triggers).toContain("security_violation");
    expect(decision.targetRollbackVersion).toBe("1.0.0");
  });

  it("should trigger immediate rollback on local quarantine signal from TE-024", () => {
    const rollout = createBaseRollout("canary");
    const metrics = createBaseMetrics({
      quarantineSignals: 1,
      quarantineReasons: ["decompression_bomb"],
    });

    const decision = evaluator.evaluateCanaryMetrics({
      rollout,
      policy: defaultPolicy,
      metrics,
    });

    expect(decision.action).toBe("trigger_rollback");
    expect(decision.toState).toBe("rollback_pending");
    expect(decision.triggers).toContain("quarantine_signal");
    expect(decision.reason).toContain("decompression_bomb");
  });

  it("should trigger immediate rollback on signature verification tampering", () => {
    const rollout = createBaseRollout("canary");
    const metrics = createBaseMetrics({
      signatureValid: false,
    });

    const decision = evaluator.evaluateCanaryMetrics({
      rollout,
      policy: defaultPolicy,
      metrics,
    });

    expect(decision.action).toBe("trigger_rollback");
    expect(decision.triggers).toContain("signature_tamper");
  });

  it("should trigger rollback on failure threshold or error rate exceedance", () => {
    const rollout = createBaseRollout("canary");
    const metrics = createBaseMetrics({
      totalInvocations: 20,
      failureCount: 5,
      successCount: 15,
      errorRate: 0.25, // 25% > 2% maxFailureRate
      successRate: 0.75,
    });

    const decision = evaluator.evaluateCanaryMetrics({
      rollout,
      policy: defaultPolicy,
      metrics,
    });

    expect(decision.action).toBe("trigger_rollback");
    expect(decision.triggers).toContain("max_failures_exceeded");
    expect(decision.triggers).toContain("max_error_rate_exceeded");
  });

  it("should trigger rollback on P95 latency ceiling breach or latency regression exceedance", () => {
    const rollout = createBaseRollout("canary");
    // P95 latency ceiling is 3000ms in defaultPolicy
    const metrics = createBaseMetrics({
      totalInvocations: 15,
      p95LatencyMs: 3500, // 3500ms > 3000ms
      latencyRegressionPercent: 40, // 40% > 25% tolerance
    });

    const decision = evaluator.evaluateCanaryMetrics({
      rollout,
      policy: defaultPolicy,
      metrics,
    });

    expect(decision.action).toBe("trigger_rollback");
    expect(decision.triggers).toContain("p95_latency_ceiling_breach");
    expect(decision.triggers).toContain("latency_regression_exceeded");
  });

  it("should suspend rollout when devices are offline or reporting rate is insufficient", () => {
    const rollout = createBaseRollout("canary");
    const metrics = createBaseMetrics({
      activeDevicesCount: 0,
      offlineDevicesCount: 4,
      deviceReportingRate: 0.0,
    });

    const decision = evaluator.evaluateCanaryMetrics({
      rollout,
      policy: defaultPolicy,
      metrics,
    });

    expect(decision.action).toBe("suspend");
    expect(decision.toState).toBe("suspended");
    expect(decision.triggers).toContain("offline_devices");
  });

  it("should advance canary to observation and then auto-promote upon clean observation windows", () => {
    // 1. Canary with minInvocations satisfied -> advances to observing
    const canaryRollout = createBaseRollout("canary", 0);
    const healthyMetrics = createBaseMetrics({
      totalInvocations: 10,
    });

    const decision1 = evaluator.evaluateCanaryMetrics({
      rollout: canaryRollout,
      policy: defaultPolicy,
      metrics: healthyMetrics,
    });

    expect(decision1.action).toBe("observe");
    expect(decision1.toState).toBe("observing");

    // 2. Observing with requiredCleanWindows satisfied -> advances to promoted
    const observingRollout = createBaseRollout("observing", 0);
    const decision2 = evaluator.evaluateCanaryMetrics({
      rollout: observingRollout,
      policy: defaultPolicy, // requiredCleanWindows: 1
      metrics: healthyMetrics,
    });

    expect(decision2.action).toBe("promote");
    expect(decision2.toState).toBe("promoted");
  });

  it("should accurately compute p50, p95, and p99 percentiles", () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const { p50, p95, p99 } = computeLatencyPercentiles(latencies);

    expect(p50).toBe(55);
    expect(p95).toBe(96);
    expect(p99).toBe(99);

    const empty = computeLatencyPercentiles([]);
    expect(empty).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  it("should aggregate telemetry events into structured metrics window", () => {
    const now = new Date().toISOString();
    const events = [
      {
        workspaceId: "ws_1",
        toolId: "tool_1",
        version: "1.0.0",
        success: true,
        durationMs: 50,
        securityViolation: false,
        quarantineSignal: false,
        capabilityBreach: false,
        signatureValid: true,
        timestamp: now,
      },
      {
        workspaceId: "ws_1",
        toolId: "tool_1",
        version: "1.0.0",
        success: false,
        durationMs: 150,
        securityViolation: false,
        quarantineSignal: true,
        quarantineReason: "corrupted_archive",
        capabilityBreach: false,
        signatureValid: true,
        timestamp: now,
      },
    ];

    const window = aggregateTelemetryEvents(
      events,
      now,
      now,
      50,
      { activeCount: 2, offlineCount: 0 },
    );

    expect(window.totalInvocations).toBe(2);
    expect(window.successCount).toBe(1);
    expect(window.failureCount).toBe(1);
    expect(window.errorRate).toBe(0.5);
    expect(window.quarantineSignals).toBe(1);
    expect(window.quarantineReasons).toContain("corrupted_archive");
  });
});
