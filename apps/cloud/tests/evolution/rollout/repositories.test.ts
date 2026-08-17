import { describe, expect, it } from "vitest";
import {
  createMockRolloutParams,
  createTestRolloutEnvironment,
  TEST_TENANT,
  TEST_WORKSPACE_ID,
} from "./helpers.js";
import {
  type RolloutDecision,
  type RolloutEntity,
  type RolloutIncidentRecord,
  type RolloutOverrideRecord,
  type RolloutSessionAssignment,
} from "../../../src/evolution/rollout/types.js";

describe("RolloutRepository - Database Persistence & Lineage Operations", () => {
  it("should persist, query, and update rollout entities", async () => {
    const env = await createTestRolloutEnvironment();
    const rolloutId = "rollout_repo_001";
    const now = new Date().toISOString();

    const rollout: RolloutEntity = {
      id: rolloutId,
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "log_parser",
      targetVersion: "1.2.0",
      previousVersion: "1.0.0",
      artifactDigest: "art_digest_abc",
      manifestDigest: "mnf_digest_abc",
      riskTier: "tier1_low",
      policyId: "policy_tier1_low_v1",
      state: "canary",
      canaryTrafficPercentage: 10,
      targetDeviceIds: ["dev_1"],
      activeDeviceIds: ["dev_1"],
      invocationsCount: 0,
      failureCount: 0,
      consecutiveCleanWindows: 0,
      metrics: null,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    // 1. Create rollout
    await env.rolloutRepo.createRollout(TEST_TENANT, rollout);

    // 2. Query by ID
    const retrieved = await env.rolloutRepo.getRollout(rolloutId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(rolloutId);
    expect(retrieved?.state).toBe("canary");

    // 3. Query active rollout for tool
    const active = await env.rolloutRepo.getActiveRolloutForTool(
      TEST_WORKSPACE_ID,
      "log_parser",
    );
    expect(active?.id).toBe(rolloutId);

    // 4. Update rollout state to promoted
    const promotedAt = new Date().toISOString();
    await env.rolloutRepo.updateRollout(rolloutId, {
      state: "promoted",
      promotedAt,
      canaryTrafficPercentage: 100,
    });

    const updated = await env.rolloutRepo.getRollout(rolloutId);
    expect(updated?.state).toBe("promoted");
    expect(updated?.canaryTrafficPercentage).toBe(100);

    // 5. Query latest promoted rollout
    const latestPromoted = await env.rolloutRepo.getLatestPromotedRollout(
      TEST_WORKSPACE_ID,
      "log_parser",
    );
    expect(latestPromoted?.id).toBe(rolloutId);
    expect(latestPromoted?.targetVersion).toBe("1.2.0");
  });

  it("should check artifact cooldown status and handle expiry", async () => {
    const env = await createTestRolloutEnvironment();
    const digest = "art_failed_cooldown_digest";
    const now = new Date();
    const futureDate = new Date(now.getTime() + 1800000).toISOString(); // +30m

    // Create rollout with active cooldown
    const rollout: RolloutEntity = {
      id: "rollout_cooldown_01",
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "failed_tool",
      targetVersion: "1.0.1",
      artifactDigest: digest,
      manifestDigest: "mnf_1",
      riskTier: "tier1_low",
      policyId: "policy_tier1_low_v1",
      state: "rolled_back",
      canaryTrafficPercentage: 0,
      invocationsCount: 5,
      failureCount: 5,
      consecutiveCleanWindows: 0,
      metrics: null,
      cooldownUntil: futureDate,
      failureReason: "Security boundary violation",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await env.rolloutRepo.createRollout(TEST_TENANT, rollout);

    // Check cooldown -> should be in cooldown
    const check1 = await env.rolloutRepo.isArtifactInCooldown(
      TEST_WORKSPACE_ID,
      digest,
    );
    expect(check1.inCooldown).toBe(true);
    expect(check1.cooldownUntil).toBe(futureDate);
    expect(check1.reason).toBe("Security boundary violation");

    // Past date cooldown -> should NOT be in cooldown
    const pastDigest = "art_past_cooldown_digest";
    const pastDate = new Date(now.getTime() - 60000).toISOString();
    await env.rolloutRepo.createRollout(TEST_TENANT, {
      ...rollout,
      id: "rollout_cooldown_02",
      artifactDigest: pastDigest,
      cooldownUntil: pastDate,
    });

    const check2 = await env.rolloutRepo.isArtifactInCooldown(
      TEST_WORKSPACE_ID,
      pastDigest,
    );
    expect(check2.inCooldown).toBe(false);
  });

  it("should record decision lineage and query in chronological order", async () => {
    const env = await createTestRolloutEnvironment();
    const rolloutId = "rollout_lineage_test";
    const now = new Date().toISOString();

    const decision1: RolloutDecision = {
      decisionId: "dec_1",
      rolloutId,
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "code_formatter",
      targetVersion: "1.1.0",
      fromState: "pending",
      toState: "canary",
      action: "start_canary",
      reason: "Initial canary start",
      confidence: 1.0,
      triggers: ["canary_initiated"],
      evaluatedAt: new Date(Date.now() - 2000).toISOString(),
    };

    const decision2: RolloutDecision = {
      decisionId: "dec_2",
      rolloutId,
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "code_formatter",
      targetVersion: "1.1.0",
      fromState: "canary",
      toState: "observing",
      action: "observe",
      reason: "Observation criteria met",
      confidence: 0.9,
      triggers: ["canary_threshold_satisfied"],
      evaluatedAt: new Date(Date.now() - 1000).toISOString(),
    };

    await env.rolloutRepo.saveDecision(decision1);
    await env.rolloutRepo.saveDecision(decision2);

    const lineage = await env.rolloutRepo.getDecisions(rolloutId);
    expect(lineage.length).toBe(2);
    expect(lineage[0].decisionId).toBe("dec_1");
    expect(lineage[1].decisionId).toBe("dec_2");
  });

  it("should record and query rollout incidents", async () => {
    const env = await createTestRolloutEnvironment();
    const incident: RolloutIncidentRecord = {
      id: "inc_001",
      rolloutId: "rollout_inc_01",
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "file_manager",
      version: "2.0.0",
      severity: "critical",
      incidentType: "quarantine_signal",
      description: "Local quarantine signal from observer",
      evidence: { signal: "quarantine_detected", code: "corrupted_archive" },
      triggeredRollback: true,
      createdAt: new Date().toISOString(),
    };

    await env.rolloutRepo.saveIncident(incident);

    const incidents = await env.rolloutRepo.getIncidents(TEST_WORKSPACE_ID, {
      toolId: "file_manager",
    });
    expect(incidents.length).toBe(1);
    expect(incidents[0].id).toBe("inc_001");
    expect(incidents[0].severity).toBe("critical");
    expect(incidents[0].triggeredRollback).toBe(true);
  });

  it("should persist and update sticky session assignments", async () => {
    const env = await createTestRolloutEnvironment();
    const assignment: RolloutSessionAssignment = {
      id: "assign_001",
      workspaceId: TEST_WORKSPACE_ID,
      sessionId: "session_user_42",
      toolId: "json_formatter",
      assignedVersion: "1.0.0",
      isCanary: false,
      reason: "sticky_session",
      assignedAt: new Date().toISOString(),
    };

    await env.rolloutRepo.saveSessionAssignment(assignment);

    const retrieved = await env.rolloutRepo.getSessionAssignment(
      TEST_WORKSPACE_ID,
      "session_user_42",
      "json_formatter",
    );
    expect(retrieved?.assignedVersion).toBe("1.0.0");

    // Upsert same session/tool with new version
    await env.rolloutRepo.saveSessionAssignment({
      ...assignment,
      assignedVersion: "1.1.0",
      isCanary: true,
    });

    const updated = await env.rolloutRepo.getSessionAssignment(
      TEST_WORKSPACE_ID,
      "session_user_42",
      "json_formatter",
    );
    expect(updated?.assignedVersion).toBe("1.1.0");
    expect(updated?.isCanary).toBe(true);

    // Clear session assignment
    await env.rolloutRepo.clearSessionAssignment(
      TEST_WORKSPACE_ID,
      "session_user_42",
      "json_formatter",
    );
    const cleared = await env.rolloutRepo.getSessionAssignment(
      TEST_WORKSPACE_ID,
      "session_user_42",
      "json_formatter",
    );
    expect(cleared).toBeNull();
  });

  it("should persist, query, and remove user configuration overrides", async () => {
    const env = await createTestRolloutEnvironment();
    const override: RolloutOverrideRecord = {
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "legacy_tool",
      overrideType: "pinned",
      pinnedVersion: "0.9.0",
      reason: "Compatibility with legacy pipeline",
      createdBy: "admin_user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await env.rolloutRepo.saveOverride(override);

    const retrieved = await env.rolloutRepo.getOverride(
      TEST_WORKSPACE_ID,
      "legacy_tool",
    );
    expect(retrieved).toBeDefined();
    expect(retrieved?.overrideType).toBe("pinned");
    expect(retrieved?.pinnedVersion).toBe("0.9.0");

    await env.rolloutRepo.removeOverride(TEST_WORKSPACE_ID, "legacy_tool");
    const removed = await env.rolloutRepo.getOverride(
      TEST_WORKSPACE_ID,
      "legacy_tool",
    );
    expect(removed).toBeNull();
  });

  it("should save telemetry events and calculate aggregated metrics window", async () => {
    const env = await createTestRolloutEnvironment();
    const now = new Date().toISOString();

    await env.rolloutRepo.saveTelemetryEvent({
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "metrics_tool",
      version: "1.0.0",
      success: true,
      durationMs: 40,
      timestamp: now,
    });

    await env.rolloutRepo.saveTelemetryEvent({
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "metrics_tool",
      version: "1.0.0",
      success: true,
      durationMs: 60,
      timestamp: now,
    });

    const window = await env.rolloutRepo.calculateMetricsWindow(
      TEST_WORKSPACE_ID,
      "metrics_tool",
      "1.0.0",
      {
        windowStart: new Date(Date.now() - 60000).toISOString(),
        baselineP95LatencyMs: 50,
      },
    );

    expect(window.totalInvocations).toBe(2);
    expect(window.successCount).toBe(2);
    expect(window.failureCount).toBe(0);
    expect(window.successRate).toBe(1.0);
    expect(window.p50LatencyMs).toBe(50);
  });
});
