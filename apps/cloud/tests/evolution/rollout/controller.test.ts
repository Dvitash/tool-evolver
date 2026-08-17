import { describe, expect, it } from "vitest";
import {
  createMockRolloutParams,
  createMockTelemetryBatch,
  createTestRolloutEnvironment,
  TEST_TENANT,
  TEST_WORKSPACE_ID,
} from "./helpers.js";
import {
  RolloutCooldownActiveError,
  RolloutPinnedVersionConflictError,
  RolloutToolDisabledError,
} from "../../../src/evolution/rollout/types.js";

describe("RolloutController - Autonomous Canary, Promotion & Rollback Lifecycle", () => {
  it("should execute full canary -> observation -> promotion lifecycle on healthy metrics", async () => {
    const env = await createTestRolloutEnvironment();
    const params = createMockRolloutParams("data_transformer", "2.0.0", {
      previousVersion: "1.0.0",
      riskTier: "tier1_low",
    });

    // 1. Create rollout for eligible published version
    const rollout = await env.controller.createRolloutForPublishedVersion(
      TEST_TENANT,
      params,
    );

    expect(rollout.state).toBe("canary");
    expect(rollout.targetVersion).toBe("2.0.0");
    expect(rollout.previousVersion).toBe("1.0.0");
    expect(rollout.canaryTrafficPercentage).toBe(10);

    // Verify initial decision recorded
    const decisions0 = await env.controller.getDecisionLineage(rollout.id);
    expect(decisions0.length).toBe(1);
    expect(decisions0[0].action).toBe("start_canary");

    // 2. Ingest healthy canary telemetry (10 invocations, 0 failures)
    const healthyEvents = createMockTelemetryBatch(
      TEST_WORKSPACE_ID,
      "data_transformer",
      "2.0.0",
      10,
      { failureCount: 0, baseDurationMs: 40 },
    );

    for (const event of healthyEvents) {
      await env.controller.recordTelemetry(event);
    }

    // 3. Evaluate canary metrics -> should advance to observing
    const evalDecision1 = await env.controller.evaluateRollout(rollout.id);
    expect(evalDecision1.action).toBe("observe");
    expect(evalDecision1.toState).toBe("observing");

    const updated1 = await env.controller.getRollout(rollout.id);
    expect(updated1?.state).toBe("observing");
    expect(updated1?.consecutiveCleanWindows).toBe(1);

    // 4. Ingest additional healthy observation telemetry & evaluate -> should auto-promote!
    const observationEvents = createMockTelemetryBatch(
      TEST_WORKSPACE_ID,
      "data_transformer",
      "2.0.0",
      10,
      { failureCount: 0, baseDurationMs: 45 },
    );
    for (const event of observationEvents) {
      await env.controller.recordTelemetry(event);
    }

    const evalDecision2 = await env.controller.evaluateRollout(rollout.id);
    expect(evalDecision2.action).toBe("promote");
    expect(evalDecision2.toState).toBe("promoted");

    const finalRollout = await env.controller.getRollout(rollout.id);
    expect(finalRollout?.state).toBe("promoted");
    expect(finalRollout?.canaryTrafficPercentage).toBe(100);
    expect(finalRollout?.promotedAt).toBeDefined();

    // Verify full decision lineage
    const lineage = await env.controller.getDecisionLineage(rollout.id);
    expect(lineage.length).toBe(3);
    expect(lineage[0].action).toBe("start_canary");
    expect(lineage[1].action).toBe("observe");
    expect(lineage[2].action).toBe("promote");
  });

  it("should trigger immediate automatic rollback on security violation", async () => {
    const env = await createTestRolloutEnvironment();
    const params = createMockRolloutParams("file_indexer", "1.5.0");

    const rollout = await env.controller.createRolloutForPublishedVersion(
      TEST_TENANT,
      params,
    );
    expect(rollout.state).toBe("canary");

    // Ingest telemetry with security breach
    const breachEvent = {
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "file_indexer",
      version: "1.5.0",
      success: false,
      durationMs: 30,
      securityViolation: true,
      securityViolationReason: "Unauthorized filesystem escape beyond /workspace",
      timestamp: new Date().toISOString(),
    };

    const decision = await env.controller.recordTelemetry(breachEvent);
    expect(decision).toBeDefined();
    expect(decision?.action).toBe("trigger_rollback");
    expect(decision?.toState).toBe("rolled_back");
    expect(decision?.triggers).toContain("security_violation");

    // Verify rollout state is rolled_back
    const rolledBack = await env.controller.getRollout(rollout.id);
    expect(rolledBack?.state).toBe("rolled_back");
    expect(rolledBack?.cooldownUntil).toBeDefined();

    // Verify incident record created
    const incidents = await env.controller.getIncidents(TEST_WORKSPACE_ID, {
      rolloutId: rollout.id,
    });
    expect(incidents.length).toBe(1);
    expect(incidents[0].severity).toBe("critical");
    expect(incidents[0].incidentType).toBe("security_violation");
    expect(incidents[0].triggeredRollback).toBe(true);
  });

  it("should trigger immediate automatic rollback on local quarantine signal from TE-024", async () => {
    const env = await createTestRolloutEnvironment();
    const params = createMockRolloutParams("crypto_tool", "2.1.0");

    const rollout = await env.controller.createRolloutForPublishedVersion(
      TEST_TENANT,
      params,
    );

    // Ingest local quarantine signal
    const quarantineEvent = {
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "crypto_tool",
      version: "2.1.0",
      success: false,
      durationMs: 25,
      quarantineSignal: true,
      quarantineReason: "signature_mismatch",
      timestamp: new Date().toISOString(),
    };

    const decision = await env.controller.recordTelemetry(quarantineEvent);
    expect(decision?.action).toBe("trigger_rollback");
    expect(decision?.triggers).toContain("quarantine_signal");

    const incidents = await env.controller.getIncidents(TEST_WORKSPACE_ID, {
      rolloutId: rollout.id,
    });
    expect(incidents.length).toBe(1);
    expect(incidents[0].incidentType).toBe("quarantine_signal");
    expect(incidents[0].triggeredRollback).toBe(true);
  });

  it("should trigger immediate automatic rollback on capability boundary breach", async () => {
    const env = await createTestRolloutEnvironment();
    const params = createMockRolloutParams("network_fetcher", "3.0.0");

    const rollout = await env.controller.createRolloutForPublishedVersion(
      TEST_TENANT,
      params,
    );

    const capabilityEvent = {
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "network_fetcher",
      version: "3.0.0",
      success: false,
      durationMs: 40,
      capabilityBreach: true,
      timestamp: new Date().toISOString(),
    };

    const decision = await env.controller.recordTelemetry(capabilityEvent);
    expect(decision?.action).toBe("trigger_rollback");
    expect(decision?.triggers).toContain("capability_breach");
  });

  it("should enforce cooldown preventing auto-redeployment of failed artifact digest", async () => {
    const env = await createTestRolloutEnvironment();
    const params = createMockRolloutParams("unstable_worker", "1.2.0", {
      artifactDigest: "art_failed_digest_999",
    });

    const rollout = await env.controller.createRolloutForPublishedVersion(
      TEST_TENANT,
      params,
    );

    // Trigger rollback
    await env.controller.executeRollback(
      rollout,
      "Simulated deployment failure",
      ["error_spike"],
    );

    const failedRollout = await env.controller.getRollout(rollout.id);
    expect(failedRollout?.state).toBe("rolled_back");
    expect(failedRollout?.cooldownUntil).toBeDefined();

    // Attempt to redeploy same artifact digest -> must throw RolloutCooldownActiveError
    await expect(
      env.controller.createRolloutForPublishedVersion(TEST_TENANT, params),
    ).rejects.toThrow(RolloutCooldownActiveError);
  });

  it("should suspend rollout when target devices are offline or reporting rate is insufficient", async () => {
    const env = await createTestRolloutEnvironment();
    const params = createMockRolloutParams("sensor_hub", "1.0.1");

    const rollout = await env.controller.createRolloutForPublishedVersion(
      TEST_TENANT,
      params,
    );

    // Ingest some events
    const events = createMockTelemetryBatch(
      TEST_WORKSPACE_ID,
      "sensor_hub",
      "1.0.1",
      5,
      { failureCount: 0 },
    );
    for (const e of events) {
      await env.controller.recordTelemetry(e);
    }

    // Evaluate with devices offline
    const decision = await env.controller.evaluateRollout(rollout.id, {
      deviceStatus: { activeCount: 0, offlineCount: 3 },
    });

    expect(decision.action).toBe("suspend");
    expect(decision.toState).toBe("suspended");
    expect(decision.triggers).toContain("offline_devices");

    const suspended = await env.controller.getRollout(rollout.id);
    expect(suspended?.state).toBe("suspended");
  });

  it("should preserve user pin and disable overrides", async () => {
    const env = await createTestRolloutEnvironment();

    // 1. Set user pin override
    await env.controller.setUserOverride(TEST_TENANT, {
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "custom_analyzer",
      overrideType: "pinned",
      pinnedVersion: "1.0.0",
      reason: "Pinned by ops engineer for audit stability",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Attempting rollout with 1.1.0 should throw RolloutPinnedVersionConflictError
    const params = createMockRolloutParams("custom_analyzer", "1.1.0");
    await expect(
      env.controller.createRolloutForPublishedVersion(TEST_TENANT, params),
    ).rejects.toThrow(RolloutPinnedVersionConflictError);

    // 2. Set user disable override
    await env.controller.setUserOverride(TEST_TENANT, {
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "disabled_tool",
      overrideType: "disabled",
      reason: "Disabled due to company compliance policy",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const paramsDisabled = createMockRolloutParams("disabled_tool", "1.0.0");
    await expect(
      env.controller.createRolloutForPublishedVersion(
        TEST_TENANT,
        paramsDisabled,
      ),
    ).rejects.toThrow(RolloutToolDisabledError);
  });

  it("should allow manual operator promotion and rollback", async () => {
    const env = await createTestRolloutEnvironment();
    const params = createMockRolloutParams("manual_ops_tool", "2.0.0");

    const rollout = await env.controller.createRolloutForPublishedVersion(
      TEST_TENANT,
      params,
    );
    expect(rollout.state).toBe("canary");

    // Operator triggers manual promotion
    const promoDecision = await env.controller.executeManualPromotion(
      TEST_TENANT,
      rollout.id,
      "Approved in staging review",
    );
    expect(promoDecision.action).toBe("promote");
    expect(promoDecision.toState).toBe("promoted");

    const promoted = await env.controller.getRollout(rollout.id);
    expect(promoted?.state).toBe("promoted");

    // Later operator triggers manual rollback
    const rollbackDecision = await env.controller.executeManualRollback(
      TEST_TENANT,
      rollout.id,
      "Post-deployment anomaly detected in upstream service",
    );
    expect(rollbackDecision.action).toBe("trigger_rollback");
    expect(rollbackDecision.toState).toBe("rolled_back");

    const rolledBack = await env.controller.getRollout(rollout.id);
    expect(rolledBack?.state).toBe("rolled_back");
  });
});
