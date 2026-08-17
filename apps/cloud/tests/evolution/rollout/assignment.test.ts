import { describe, expect, it } from "vitest";
import {
  RolloutAssignmentRouter,
  MemoryAssignmentStore,
} from "../../../src/evolution/rollout/assignment.js";
import {
  type RolloutEntity,
  RolloutToolDisabledError,
} from "../../../src/evolution/rollout/types.js";
import { TEST_WORKSPACE_ID } from "./helpers.js";

describe("RolloutAssignmentRouter - Sticky Session Routing & Schema Isolation", () => {
  it("should maintain sticky version stability within the same session", async () => {
    const store = new MemoryAssignmentStore();
    const router = new RolloutAssignmentRouter(store);

    const activeRollout: RolloutEntity = {
      id: "rollout_001",
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "text_formatter",
      targetVersion: "1.2.0",
      previousVersion: "1.0.0",
      artifactDigest: "art_123",
      manifestDigest: "mnf_123",
      riskTier: "tier1_low",
      policyId: "policy_tier1_low_v1",
      state: "canary",
      canaryTrafficPercentage: 100, // force canary assignment
      invocationsCount: 0,
      failureCount: 0,
      consecutiveCleanWindows: 0,
      metrics: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // First invocation resolves assignment
    const assignment1 = await router.resolveAssignment({
      workspaceId: TEST_WORKSPACE_ID,
      sessionId: "session_sticky_abc",
      toolId: "text_formatter",
      activeRollout,
      baselineVersion: "1.0.0",
    });

    expect(assignment1.assignedVersion).toBe("1.2.0");
    expect(assignment1.isCanary).toBe(true);
    expect(assignment1.reason).toBe("canary_bucket");

    // Modify activeRollout traffic percentage to 0%
    const adjustedRollout: RolloutEntity = {
      ...activeRollout,
      canaryTrafficPercentage: 0,
    };

    // Second invocation in SAME session must still receive 1.2.0 (sticky!)
    const assignment2 = await router.resolveAssignment({
      workspaceId: TEST_WORKSPACE_ID,
      sessionId: "session_sticky_abc",
      toolId: "text_formatter",
      activeRollout: adjustedRollout,
      baselineVersion: "1.0.0",
    });

    expect(assignment2.assignedVersion).toBe("1.2.0");
    expect(assignment2.sessionId).toBe("session_sticky_abc");
  });

  it("should isolate breaking schema changes from ongoing sessions", async () => {
    const store = new MemoryAssignmentStore();
    const router = new RolloutAssignmentRouter(store);

    const breakingRollout: RolloutEntity = {
      id: "rollout_breaking_002",
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "sql_runner",
      targetVersion: "2.0.0",
      previousVersion: "1.5.0",
      artifactDigest: "art_breaking",
      manifestDigest: "mnf_breaking",
      riskTier: "tier3_high",
      policyId: "policy_tier3_high_v1",
      state: "canary",
      canaryTrafficPercentage: 100,
      invocationsCount: 0,
      failureCount: 0,
      consecutiveCleanWindows: 0,
      metrics: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Ongoing/existing session -> must be isolated from breaking schema
    const ongoingAssignment = await router.resolveAssignment({
      workspaceId: TEST_WORKSPACE_ID,
      sessionId: "session_ongoing_001",
      toolId: "sql_runner",
      activeRollout: breakingRollout,
      baselineVersion: "1.5.0",
      isBreakingSchema: true,
      isNewSession: false,
    });

    expect(ongoingAssignment.assignedVersion).toBe("1.5.0"); // Stays on baseline
    expect(ongoingAssignment.isBreakingSchemaIsolated).toBe(true);
    expect(ongoingAssignment.reason).toBe("breaking_schema_isolated");

    // Brand new session with opt-in can participate in canary
    const newSessionAssignment = await router.resolveAssignment({
      workspaceId: TEST_WORKSPACE_ID,
      sessionId: "session_brand_new_002",
      toolId: "sql_runner",
      activeRollout: breakingRollout,
      baselineVersion: "1.5.0",
      isBreakingSchema: true,
      isNewSession: true,
    });

    expect(newSessionAssignment.assignedVersion).toBe("2.0.0");
    expect(newSessionAssignment.isCanary).toBe(true);
  });

  it("should automatically fallback to baseline version when assigned version is rolled back", async () => {
    const store = new MemoryAssignmentStore();
    const router = new RolloutAssignmentRouter(store);

    // Initial sticky assignment to 1.1.0
    await store.saveSessionAssignment({
      id: "assign_1",
      workspaceId: TEST_WORKSPACE_ID,
      sessionId: "session_fallback_test",
      toolId: "image_processor",
      assignedVersion: "1.1.0",
      rolloutId: "rollout_failed",
      isCanary: true,
      isBreakingSchemaIsolated: false,
      reason: "canary_bucket",
      assignedAt: new Date().toISOString(),
    });

    // Rollout is now in rolled_back state
    const rolledBackRollout: RolloutEntity = {
      id: "rollout_failed",
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "image_processor",
      targetVersion: "1.1.0",
      previousVersion: "1.0.0",
      artifactDigest: "art_failed",
      manifestDigest: "mnf_failed",
      riskTier: "tier1_low",
      policyId: "policy_tier1_low_v1",
      state: "rolled_back",
      canaryTrafficPercentage: 0,
      invocationsCount: 15,
      failureCount: 5,
      consecutiveCleanWindows: 0,
      metrics: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Invocation should detect rollback and reassign safely to 1.0.0
    const fallbackAssignment = await router.resolveAssignment({
      workspaceId: TEST_WORKSPACE_ID,
      sessionId: "session_fallback_test",
      toolId: "image_processor",
      activeRollout: rolledBackRollout,
      baselineVersion: "1.0.0",
    });

    expect(fallbackAssignment.assignedVersion).toBe("1.0.0");
    expect(fallbackAssignment.reason).toBe("rollback_fallback");
  });

  it("should prioritize user pin override over active rollouts", async () => {
    const store = new MemoryAssignmentStore();
    const router = new RolloutAssignmentRouter(store);

    const activeRollout: RolloutEntity = {
      id: "rollout_pin_test",
      workspaceId: TEST_WORKSPACE_ID,
      toolId: "pdf_exporter",
      targetVersion: "2.1.0",
      previousVersion: "1.0.0",
      artifactDigest: "art_pin",
      manifestDigest: "mnf_pin",
      riskTier: "tier1_low",
      policyId: "policy_tier1_low_v1",
      state: "canary",
      canaryTrafficPercentage: 100,
      invocationsCount: 0,
      failureCount: 0,
      consecutiveCleanWindows: 0,
      metrics: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const assignment = await router.resolveAssignment({
      workspaceId: TEST_WORKSPACE_ID,
      sessionId: "session_pinned_user",
      toolId: "pdf_exporter",
      activeRollout,
      userOverride: {
        workspaceId: TEST_WORKSPACE_ID,
        toolId: "pdf_exporter",
        overrideType: "pinned",
        pinnedVersion: "1.0.0",
        reason: "User pinned version 1.0.0",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    expect(assignment.assignedVersion).toBe("1.0.0");
    expect(assignment.reason).toBe("user_pin_override");
  });

  it("should throw RolloutToolDisabledError when tool is disabled by user", async () => {
    const store = new MemoryAssignmentStore();
    const router = new RolloutAssignmentRouter(store);

    await expect(
      router.resolveAssignment({
        workspaceId: TEST_WORKSPACE_ID,
        sessionId: "session_disabled",
        toolId: "disabled_feature",
        userOverride: {
          workspaceId: TEST_WORKSPACE_ID,
          toolId: "disabled_feature",
          overrideType: "disabled",
          reason: "Explicitly disabled",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow(RolloutToolDisabledError);
  });

  it("should produce deterministic canary bucketing across repeated calls with identical keys", () => {
    const router = new RolloutAssignmentRouter();

    const bucket1 = router.computeCanaryBucket(
      "ws_1",
      "sess_abc",
      "tool_xyz",
      "1.0.0",
    );
    const bucket2 = router.computeCanaryBucket(
      "ws_1",
      "sess_abc",
      "tool_xyz",
      "1.0.0",
    );
    const bucket3 = router.computeCanaryBucket(
      "ws_1",
      "sess_different",
      "tool_xyz",
      "1.0.0",
    );

    expect(bucket1).toBe(bucket2);
    expect(bucket1).toBeGreaterThanOrEqual(0);
    expect(bucket1).toBeLessThan(100);
    expect(typeof bucket3).toBe("number");
  });
});
