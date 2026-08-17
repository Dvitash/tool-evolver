import { createHash, randomUUID } from "node:crypto";
import {
  type RolloutEntity,
  type RolloutOverrideRecord,
  type RolloutSessionAssignment,
  RolloutSessionAssignmentSchema,
  RolloutToolDisabledError,
} from "./types.js";

/**
 * Context parameters for resolving session version assignment.
 */
export interface AssignmentResolutionContext {
  workspaceId: string;
  sessionId: string;
  toolId: string;
  activeRollout?: RolloutEntity | null;
  baselineVersion?: string;
  userOverride?: RolloutOverrideRecord | null;
  isBreakingSchema?: boolean;
  isNewSession?: boolean;
  ttlMs?: number;
}

/**
 * Storage interface required by the assignment router.
 */
export interface AssignmentStore {
  getSessionAssignment(
    workspaceId: string,
    sessionId: string,
    toolId: string,
  ): Promise<RolloutSessionAssignment | null>;
  saveSessionAssignment(assignment: RolloutSessionAssignment): Promise<RolloutSessionAssignment>;
  clearSessionAssignment(workspaceId: string, sessionId: string, toolId?: string): Promise<void>;
}

/**
 * In-memory assignment store for lightweight / isolated execution.
 */
export class MemoryAssignmentStore implements AssignmentStore {
  private assignments = new Map<string, RolloutSessionAssignment>();

  private makeKey(workspaceId: string, sessionId: string, toolId: string): string {
    return `${workspaceId}:${sessionId}:${toolId}`;
  }

  async getSessionAssignment(
    workspaceId: string,
    sessionId: string,
    toolId: string,
  ): Promise<RolloutSessionAssignment | null> {
    const key = this.makeKey(workspaceId, sessionId, toolId);
    const existing = this.assignments.get(key);
    if (!existing) return null;

    if (existing.expiresAt && new Date(existing.expiresAt) < new Date()) {
      this.assignments.delete(key);
      return null;
    }
    return existing;
  }

  async saveSessionAssignment(
    assignment: RolloutSessionAssignment,
  ): Promise<RolloutSessionAssignment> {
    const key = this.makeKey(assignment.workspaceId, assignment.sessionId, assignment.toolId);
    this.assignments.set(key, assignment);
    return assignment;
  }

  async clearSessionAssignment(
    workspaceId: string,
    sessionId: string,
    toolId?: string,
  ): Promise<void> {
    if (toolId) {
      this.assignments.delete(this.makeKey(workspaceId, sessionId, toolId));
      return;
    }

    const prefix = `${workspaceId}:${sessionId}:`;
    for (const key of this.assignments.keys()) {
      if (key.startsWith(prefix)) {
        this.assignments.delete(key);
      }
    }
  }
}

/**
 * Sticky Session Version Assignment Router.
 *
 * Guarantees:
 * 1. Sticky version stability within each session to prevent runtime inconsistencies.
 * 2. Strict isolation of breaking schema changes to protect ongoing sessions.
 * 3. Deterministic hash-based canary bucketing for candidate rollouts.
 * 4. Priority honoring of user pin and disable overrides.
 * 5. Automatic fallback to previous known good versions if assigned candidate fails.
 */
export class RolloutAssignmentRouter {
  constructor(private store: AssignmentStore = new MemoryAssignmentStore()) {}

  /**
   * Compute a deterministic bucket percentage (0..99) for a session and rollout candidate.
   */
  computeCanaryBucket(
    workspaceId: string,
    sessionId: string,
    toolId: string,
    targetVersion: string,
  ): number {
    const hash = createHash("sha256")
      .update(`${workspaceId}:${sessionId}:${toolId}:${targetVersion}`)
      .digest("hex");
    const num = Number.parseInt(hash.slice(0, 8), 16);
    return num % 100;
  }

  /**
   * Resolves or assigns the appropriate tool version for a session invocation.
   */
  async resolveAssignment(context: AssignmentResolutionContext): Promise<RolloutSessionAssignment> {
    const now = new Date().toISOString();
    const expiresAt = context.ttlMs
      ? new Date(Date.now() + context.ttlMs).toISOString()
      : undefined;
    const baseline = context.baselineVersion ?? "1.0.0";

    // 1. Check user pin/disable override first (highest priority)
    if (context.userOverride) {
      if (context.userOverride.overrideType === "disabled") {
        throw new RolloutToolDisabledError(context.toolId, context.workspaceId);
      }

      if (context.userOverride.overrideType === "pinned" && context.userOverride.pinnedVersion) {
        const pinnedAssignment: RolloutSessionAssignment = {
          id: randomUUID(),
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          toolId: context.toolId,
          assignedVersion: context.userOverride.pinnedVersion,
          isCanary: false,
          isBreakingSchemaIsolated: false,
          reason: "user_pin_override",
          assignedAt: now,
          expiresAt,
        };
        return this.store.saveSessionAssignment(pinnedAssignment);
      }
    }

    // 2. Check existing sticky assignment for this session
    const existing = await this.store.getSessionAssignment(
      context.workspaceId,
      context.sessionId,
      context.toolId,
    );

    if (existing) {
      // If the currently assigned version was rolled back or failed in the active rollout, fallback!
      if (
        context.activeRollout &&
        context.activeRollout.targetVersion === existing.assignedVersion &&
        (context.activeRollout.state === "rolled_back" ||
          context.activeRollout.state === "failed" ||
          context.activeRollout.state === "suspended")
      ) {
        const fallbackAssignment: RolloutSessionAssignment = {
          id: randomUUID(),
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          toolId: context.toolId,
          assignedVersion: context.activeRollout.previousVersion ?? baseline,
          rolloutId: context.activeRollout.id,
          isCanary: false,
          isBreakingSchemaIsolated: false,
          reason: "rollback_fallback",
          assignedAt: now,
          expiresAt,
        };
        return this.store.saveSessionAssignment(fallbackAssignment);
      }

      // Preserve existing assignment to guarantee stickiness
      return existing;
    }

    // 3. If no active rollout, default to baseline
    if (!context.activeRollout) {
      const defaultAssignment: RolloutSessionAssignment = {
        id: randomUUID(),
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        toolId: context.toolId,
        assignedVersion: baseline,
        isCanary: false,
        isBreakingSchemaIsolated: false,
        reason: "default_baseline",
        assignedAt: now,
        expiresAt,
      };
      return this.store.saveSessionAssignment(defaultAssignment);
    }

    const rollout = context.activeRollout;

    // 4. If rollout is already promoted, assign target version as default
    if (rollout.state === "promoted") {
      const promotedAssignment: RolloutSessionAssignment = {
        id: randomUUID(),
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        toolId: context.toolId,
        assignedVersion: rollout.targetVersion,
        rolloutId: rollout.id,
        isCanary: false,
        isBreakingSchemaIsolated: false,
        reason: "promoted_default",
        assignedAt: now,
        expiresAt,
      };
      return this.store.saveSessionAssignment(promotedAssignment);
    }

    // 5. If rollout is rolled_back, failed, or suspended, route to previous version
    if (
      rollout.state === "rolled_back" ||
      rollout.state === "failed" ||
      rollout.state === "suspended"
    ) {
      const fallbackAssignment: RolloutSessionAssignment = {
        id: randomUUID(),
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        toolId: context.toolId,
        assignedVersion: rollout.previousVersion ?? baseline,
        rolloutId: rollout.id,
        isCanary: false,
        isBreakingSchemaIsolated: false,
        reason: "rollback_fallback",
        assignedAt: now,
        expiresAt,
      };
      return this.store.saveSessionAssignment(fallbackAssignment);
    }

    // 6. Handle Breaking Schema Change Isolation
    // Ongoing/existing sessions MUST NEVER receive breaking schema updates
    if (context.isBreakingSchema && !context.isNewSession) {
      const isolatedAssignment: RolloutSessionAssignment = {
        id: randomUUID(),
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        toolId: context.toolId,
        assignedVersion: rollout.previousVersion ?? baseline,
        rolloutId: rollout.id,
        isCanary: false,
        isBreakingSchemaIsolated: true,
        reason: "breaking_schema_isolated",
        assignedAt: now,
        expiresAt,
      };
      return this.store.saveSessionAssignment(isolatedAssignment);
    }

    // 7. Canary / Observing Traffic Bucketing
    if (rollout.state === "canary" || rollout.state === "observing") {
      const bucket = this.computeCanaryBucket(
        context.workspaceId,
        context.sessionId,
        context.toolId,
        rollout.targetVersion,
      );

      const targetPercentage =
        rollout.state === "observing"
          ? Math.max(rollout.canaryTrafficPercentage, 20) // observing maintains or expands canary exposure
          : rollout.canaryTrafficPercentage;

      if (bucket < targetPercentage) {
        const canaryAssignment: RolloutSessionAssignment = {
          id: randomUUID(),
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          toolId: context.toolId,
          assignedVersion: rollout.targetVersion,
          rolloutId: rollout.id,
          isCanary: true,
          isBreakingSchemaIsolated: false,
          reason: "canary_bucket",
          assignedAt: now,
          expiresAt,
        };
        return this.store.saveSessionAssignment(canaryAssignment);
      }
    }

    // 8. Fallback to baseline for sessions not placed in canary bucket
    const baselineAssignment: RolloutSessionAssignment = {
      id: randomUUID(),
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      toolId: context.toolId,
      assignedVersion: rollout.previousVersion ?? baseline,
      rolloutId: rollout.id,
      isCanary: false,
      isBreakingSchemaIsolated: false,
      reason: "default_baseline",
      assignedAt: now,
      expiresAt,
    };
    return this.store.saveSessionAssignment(baselineAssignment);
  }

  async getSessionAssignment(
    workspaceId: string,
    sessionId: string,
    toolId: string,
  ): Promise<RolloutSessionAssignment | null> {
    return this.store.getSessionAssignment(workspaceId, sessionId, toolId);
  }

  async clearSessionAssignment(
    workspaceId: string,
    sessionId: string,
    toolId?: string,
  ): Promise<void> {
    return this.store.clearSessionAssignment(workspaceId, sessionId, toolId);
  }
}
