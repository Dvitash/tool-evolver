import { randomUUID } from "node:crypto";
import type { DatabasePool, Queryable } from "../../../db/client.js";
import { TenantGuard, type TenantContext } from "../../../tenant.js";
import type { AssignmentStore } from "../assignment.js";
import { aggregateTelemetryEvents } from "../evaluator.js";
import {
  type CanaryMetricsWindow,
  type RolloutDecision,
  type RolloutEntity,
  type RolloutFilter,
  type RolloutIncidentRecord,
  type RolloutOverrideRecord,
  type RolloutSessionAssignment,
  type RolloutState,
  type RolloutTelemetryEvent,
} from "../types.js";

/**
 * Repository for managing Rollout lifecycles, decisions, session assignments,
 * incidents, user overrides, and telemetry metrics.
 */
export class RolloutRepository implements AssignmentStore {
  constructor(private pool: DatabasePool | Queryable) {}

  // -------------------------------------------------------------------------
  // 1. Rollout Lifecycle Management
  // -------------------------------------------------------------------------

  /**
   * Create a new Rollout entity.
   */
  async createRollout(
    tenant: { accountId?: string; workspaceId: string },
    rollout: RolloutEntity,
  ): Promise<RolloutEntity> {
    const accountId =
      tenant.accountId ??
      rollout.accountId ??
      "acc_default";
    const workspaceId = tenant.workspaceId;
    const now = new Date().toISOString();

    await this.pool.query(
      `INSERT INTO rollouts (
        id,
        account_id,
        workspace_id,
        tool_id,
        target_version,
        previous_version,
        artifact_digest,
        manifest_digest,
        risk_tier,
        policy_id,
        state,
        canary_traffic_percentage,
        target_device_ids,
        active_device_ids,
        invocations_count,
        failure_count,
        consecutive_clean_windows,
        metrics,
        cooldown_until,
        pinned_version_override,
        is_disabled,
        failure_reason,
        started_at,
        observing_at,
        promoted_at,
        rolled_back_at,
        suspended_at,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)`,
      [
        rollout.id,
        accountId,
        workspaceId,
        rollout.toolId,
        rollout.targetVersion,
        rollout.previousVersion ?? null,
        rollout.artifactDigest,
        rollout.manifestDigest,
        rollout.riskTier,
        rollout.policyId,
        rollout.state,
        rollout.canaryTrafficPercentage,
        JSON.stringify(rollout.targetDeviceIds ?? []),
        JSON.stringify(rollout.activeDeviceIds ?? []),
        rollout.invocationsCount ?? 0,
        rollout.failureCount ?? 0,
        rollout.consecutiveCleanWindows ?? 0,
        rollout.metrics ? JSON.stringify(rollout.metrics) : null,
        rollout.cooldownUntil ?? null,
        rollout.pinnedVersionOverride ?? null,
        rollout.isDisabled ?? false,
        rollout.failureReason ?? null,
        rollout.startedAt ?? now,
        rollout.observingAt ?? null,
        rollout.promotedAt ?? null,
        rollout.rolledBackAt ?? null,
        rollout.suspendedAt ?? null,
        rollout.createdAt ?? now,
        rollout.updatedAt ?? now,
      ],
    );

    return {
      ...rollout,
      accountId,
      workspaceId,
    };
  }

  /**
   * Retrieve a Rollout by ID.
   */
  async getRollout(rolloutId: string): Promise<RolloutEntity | null> {
    const res = await this.pool.query(
      `SELECT * FROM rollouts WHERE id = $1`,
      [rolloutId],
    );
    if (res.rows.length === 0) return null;
    return this.mapRolloutRow(res.rows[0]);
  }

  /**
   * Retrieve the active rollout (canary or observing) for a given tool.
   */
  async getActiveRolloutForTool(
    workspaceId: string,
    toolId: string,
  ): Promise<RolloutEntity | null> {
    const res = await this.pool.query(
      `SELECT * FROM rollouts
       WHERE workspace_id = $1 AND tool_id = $2 AND (state = 'canary' OR state = 'observing' OR state = 'pending')
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, toolId],
    );
    if (res.rows.length === 0) return null;
    return this.mapRolloutRow(res.rows[0]);
  }

  /**
   * Retrieve the latest promoted rollout for a tool to find the previous known good version.
   */
  async getLatestPromotedRollout(
    workspaceId: string,
    toolId: string,
  ): Promise<RolloutEntity | null> {
    const res = await this.pool.query(
      `SELECT * FROM rollouts
       WHERE workspace_id = $1 AND tool_id = $2 AND state = 'promoted'
       ORDER BY promoted_at DESC, updated_at DESC LIMIT 1`,
      [workspaceId, toolId],
    );
    if (res.rows.length === 0) return null;
    return this.mapRolloutRow(res.rows[0]);
  }

  /**
   * Update an existing Rollout.
   */
  async updateRollout(
    rolloutId: string,
    updates: Partial<RolloutEntity>,
  ): Promise<RolloutEntity> {
    const existing = await this.getRollout(rolloutId);
    if (!existing) {
      throw new Error(`Rollout not found: ${rolloutId}`);
    }

    const updated: RolloutEntity = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    await this.pool.query(
      `UPDATE rollouts SET
        state = $1,
        canary_traffic_percentage = $2,
        target_device_ids = $3,
        active_device_ids = $4,
        invocations_count = $5,
        failure_count = $6,
        consecutive_clean_windows = $7,
        metrics = $8,
        cooldown_until = $9,
        pinned_version_override = $10,
        is_disabled = $11,
        failure_reason = $12,
        started_at = $13,
        observing_at = $14,
        promoted_at = $15,
        rolled_back_at = $16,
        suspended_at = $17,
        updated_at = $18
       WHERE id = $19`,
      [
        updated.state,
        updated.canaryTrafficPercentage,
        JSON.stringify(updated.targetDeviceIds ?? []),
        JSON.stringify(updated.activeDeviceIds ?? []),
        updated.invocationsCount,
        updated.failureCount,
        updated.consecutiveCleanWindows,
        updated.metrics ? JSON.stringify(updated.metrics) : null,
        updated.cooldownUntil ?? null,
        updated.pinnedVersionOverride ?? null,
        updated.isDisabled ?? false,
        updated.failureReason ?? null,
        updated.startedAt ?? null,
        updated.observingAt ?? null,
        updated.promotedAt ?? null,
        updated.rolledBackAt ?? null,
        updated.suspendedAt ?? null,
        updated.updatedAt,
        rolloutId,
      ],
    );

    return updated;
  }

  /**
   * List rollouts matching filters.
   */
  async listRollouts(
    workspaceId: string,
    filter?: RolloutFilter,
  ): Promise<RolloutEntity[]> {
    let sql = `SELECT * FROM rollouts WHERE workspace_id = $1`;
    const params: unknown[] = [workspaceId];

    if (filter?.toolId) {
      params.push(filter.toolId);
      sql += ` AND tool_id = $${params.length}`;
    }

    if (filter?.state) {
      if (Array.isArray(filter.state)) {
        const stateList = filter.state.map((s) => `'${s}'`).join(", ");
        sql += ` AND state IN (${stateList})`;
      } else {
        params.push(filter.state);
        sql += ` AND state = $${params.length}`;
      }
    }

    if (filter?.targetVersion) {
      params.push(filter.targetVersion);
      sql += ` AND target_version = $${params.length}`;
    }

    if (filter?.artifactDigest) {
      params.push(filter.artifactDigest);
      sql += ` AND artifact_digest = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC`;

    if (filter?.limit) {
      params.push(filter.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const res = await this.pool.query(sql, params);
    return res.rows.map((r) => this.mapRolloutRow(r));
  }

  /**
   * Check whether an artifact digest is currently in active cooldown.
   */
  async isArtifactInCooldown(
    workspaceId: string,
    artifactDigest: string,
  ): Promise<{ inCooldown: boolean; cooldownUntil?: string; reason?: string }> {
    const res = await this.pool.query(
      `SELECT * FROM rollouts
       WHERE workspace_id = $1 AND artifact_digest = $2 AND cooldown_until IS NOT NULL
       ORDER BY cooldown_until DESC LIMIT 1`,
      [workspaceId, artifactDigest],
    );

    if (res.rows.length === 0) {
      return { inCooldown: false };
    }

    const row = res.rows[0];
    const cooldownUntil = String(row.cooldown_until);
    const inCooldown = new Date(cooldownUntil).getTime() > Date.now();

    return {
      inCooldown,
      cooldownUntil: inCooldown ? cooldownUntil : undefined,
      reason: row.failure_reason ? String(row.failure_reason) : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Rollout Decisions (Auditable Lineage)
  // -------------------------------------------------------------------------

  /**
   * Save a decision record.
   */
  async saveDecision(decision: RolloutDecision): Promise<RolloutDecision> {
    await this.pool.query(
      `INSERT INTO rollout_decisions (
        id,
        rollout_id,
        workspace_id,
        tool_id,
        target_version,
        from_state,
        to_state,
        action,
        reason,
        confidence,
        triggers,
        metrics,
        metadata,
        evaluated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        decision.decisionId,
        decision.rolloutId,
        decision.workspaceId,
        decision.toolId,
        decision.targetVersion,
        decision.fromState,
        decision.toState,
        decision.action,
        decision.reason,
        decision.confidence,
        JSON.stringify(decision.triggers ?? []),
        decision.metrics ? JSON.stringify(decision.metrics) : null,
        JSON.stringify(decision.metadata ?? {}),
        decision.evaluatedAt,
      ],
    );

    return decision;
  }

  /**
   * Get decision lineage for a rollout.
   */
  async getDecisions(rolloutId: string): Promise<RolloutDecision[]> {
    const res = await this.pool.query(
      `SELECT * FROM rollout_decisions WHERE rollout_id = $1 ORDER BY evaluated_at ASC`,
      [rolloutId],
    );

    return res.rows.map((row) => ({
      decisionId: String(row.id),
      rolloutId: String(row.rollout_id),
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      targetVersion: String(row.target_version),
      fromState: row.from_state as RolloutState,
      toState: row.to_state as RolloutState,
      action: row.action as RolloutDecision["action"],
      reason: String(row.reason),
      confidence: Number(row.confidence),
      triggers:
        typeof row.triggers === "string"
          ? JSON.parse(row.triggers)
          : (row.triggers ?? []),
      metrics: row.metrics
        ? typeof row.metrics === "string"
          ? JSON.parse(row.metrics)
          : (row.metrics as CanaryMetricsWindow)
        : undefined,
      metadata:
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : (row.metadata ?? {}),
      evaluatedAt: String(row.evaluated_at),
    }));
  }

  // -------------------------------------------------------------------------
  // 3. Rollout Session Assignments
  // -------------------------------------------------------------------------

  /**
   * Save a sticky session assignment.
   */
  async saveSessionAssignment(
    assignment: RolloutSessionAssignment,
  ): Promise<RolloutSessionAssignment> {
    await this.pool.query(
      `INSERT INTO rollout_session_assignments (
        id,
        workspace_id,
        session_id,
        tool_id,
        assigned_version,
        rollout_id,
        is_canary,
        is_breaking_schema_isolated,
        reason,
        assigned_at,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (workspace_id, session_id, tool_id)
      DO UPDATE SET
        assigned_version = EXCLUDED.assigned_version,
        rollout_id = EXCLUDED.rollout_id,
        is_canary = EXCLUDED.is_canary,
        is_breaking_schema_isolated = EXCLUDED.is_breaking_schema_isolated,
        reason = EXCLUDED.reason,
        assigned_at = EXCLUDED.assigned_at,
        expires_at = EXCLUDED.expires_at`,
      [
        assignment.id,
        assignment.workspaceId,
        assignment.sessionId,
        assignment.toolId,
        assignment.assignedVersion,
        assignment.rolloutId ?? null,
        assignment.isCanary,
        assignment.isBreakingSchemaIsolated,
        assignment.reason,
        assignment.assignedAt,
        assignment.expiresAt ?? null,
      ],
    );

    return assignment;
  }

  /**
   * Get an existing session assignment.
   */
  async getSessionAssignment(
    workspaceId: string,
    sessionId: string,
    toolId: string,
  ): Promise<RolloutSessionAssignment | null> {
    const res = await this.pool.query(
      `SELECT * FROM rollout_session_assignments
       WHERE workspace_id = $1 AND session_id = $2 AND tool_id = $3`,
      [workspaceId, sessionId, toolId],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      sessionId: String(row.session_id),
      toolId: String(row.tool_id),
      assignedVersion: String(row.assigned_version),
      rolloutId: row.rollout_id ? String(row.rollout_id) : undefined,
      isCanary: Boolean(row.is_canary),
      isBreakingSchemaIsolated: Boolean(row.is_breaking_schema_isolated),
      reason: row.reason as RolloutSessionAssignment["reason"],
      assignedAt: String(row.assigned_at),
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    };
  }

  /**
   * Clear session assignment(s).
   */
  async clearSessionAssignment(
    workspaceId: string,
    sessionId: string,
    toolId?: string,
  ): Promise<void> {
    if (toolId) {
      await this.pool.query(
        `DELETE FROM rollout_session_assignments WHERE workspace_id = $1 AND session_id = $2 AND tool_id = $3`,
        [workspaceId, sessionId, toolId],
      );
    } else {
      await this.pool.query(
        `DELETE FROM rollout_session_assignments WHERE workspace_id = $1 AND session_id = $2`,
        [workspaceId, sessionId],
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4. Rollout Incidents
  // -------------------------------------------------------------------------

  /**
   * Save a rollout incident record.
   */
  async saveIncident(
    incident: RolloutIncidentRecord,
  ): Promise<RolloutIncidentRecord> {
    await this.pool.query(
      `INSERT INTO rollout_incidents (
        id,
        rollout_id,
        workspace_id,
        tool_id,
        version,
        severity,
        incident_type,
        description,
        evidence,
        triggered_rollback,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        incident.id,
        incident.rolloutId,
        incident.workspaceId,
        incident.toolId,
        incident.version,
        incident.severity,
        incident.incidentType,
        incident.description,
        JSON.stringify(incident.evidence ?? {}),
        incident.triggeredRollback,
        incident.createdAt,
      ],
    );

    return incident;
  }

  /**
   * Query incident records.
   */
  async getIncidents(
    workspaceId: string,
    filter?: { rolloutId?: string; toolId?: string },
  ): Promise<RolloutIncidentRecord[]> {
    let sql = `SELECT * FROM rollout_incidents WHERE workspace_id = $1`;
    const params: unknown[] = [workspaceId];

    if (filter?.rolloutId) {
      params.push(filter.rolloutId);
      sql += ` AND rollout_id = $${params.length}`;
    }

    if (filter?.toolId) {
      params.push(filter.toolId);
      sql += ` AND tool_id = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC`;
    const res = await this.pool.query(sql, params);

    return res.rows.map((row) => ({
      id: String(row.id),
      rolloutId: String(row.rollout_id),
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      version: String(row.version),
      severity: row.severity as RolloutIncidentRecord["severity"],
      incidentType: row.incident_type as RolloutIncidentRecord["incidentType"],
      description: String(row.description),
      evidence:
        typeof row.evidence === "string"
          ? JSON.parse(row.evidence)
          : (row.evidence ?? {}),
      triggeredRollback: Boolean(row.triggered_rollback),
      createdAt: String(row.created_at),
    }));
  }

  // -------------------------------------------------------------------------
  // 5. User Overrides (Pin & Disable)
  // -------------------------------------------------------------------------

  /**
   * Save a user configuration override.
   */
  async saveOverride(
    override: RolloutOverrideRecord,
  ): Promise<RolloutOverrideRecord> {
    await this.pool.query(
      `INSERT INTO rollout_overrides (
        workspace_id,
        tool_id,
        override_type,
        pinned_version,
        reason,
        created_by,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (workspace_id, tool_id)
      DO UPDATE SET
        override_type = EXCLUDED.override_type,
        pinned_version = EXCLUDED.pinned_version,
        reason = EXCLUDED.reason,
        created_by = EXCLUDED.created_by,
        updated_at = EXCLUDED.updated_at`,
      [
        override.workspaceId,
        override.toolId,
        override.overrideType,
        override.pinnedVersion ?? null,
        override.reason,
        override.createdBy,
        override.createdAt,
        override.updatedAt,
      ],
    );

    return override;
  }

  /**
   * Get an override by workspace and tool.
   */
  async getOverride(
    workspaceId: string,
    toolId: string,
  ): Promise<RolloutOverrideRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM rollout_overrides WHERE workspace_id = $1 AND tool_id = $2`,
      [workspaceId, toolId],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    return {
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      overrideType: row.override_type as RolloutOverrideRecord["overrideType"],
      pinnedVersion: row.pinned_version ? String(row.pinned_version) : undefined,
      reason: String(row.reason),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Remove a user override.
   */
  async removeOverride(workspaceId: string, toolId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM rollout_overrides WHERE workspace_id = $1 AND tool_id = $2`,
      [workspaceId, toolId],
    );
  }

  // -------------------------------------------------------------------------
  // 6. Telemetry Events & Metrics Windows
  // -------------------------------------------------------------------------

  /**
   * Record an invocation telemetry event.
   */
  async saveTelemetryEvent(event: RolloutTelemetryEvent): Promise<void> {
    const eventId = event.id ?? randomUUID();
    await this.pool.query(
      `INSERT INTO rollout_telemetry_events (
        id,
        workspace_id,
        device_id,
        session_id,
        tool_id,
        version,
        artifact_digest,
        success,
        duration_ms,
        error_code,
        error_message,
        security_violation,
        security_violation_reason,
        quarantine_signal,
        quarantine_reason,
        capability_breach,
        schema_mismatch,
        signature_valid,
        timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        eventId,
        event.workspaceId,
        event.deviceId ?? null,
        event.sessionId ?? null,
        event.toolId,
        event.version,
        event.artifactDigest ?? null,
        event.success,
        event.durationMs,
        event.errorCode ?? null,
        event.errorMessage ?? null,
        event.securityViolation ?? false,
        event.securityViolationReason ?? null,
        event.quarantineSignal ?? false,
        event.quarantineReason ?? null,
        event.capabilityBreach ?? false,
        event.schemaMismatch ?? false,
        event.signatureValid ?? true,
        event.timestamp,
      ],
    );
  }

  /**
   * Retrieve telemetry events for a version.
   */
  async getTelemetryEvents(
    workspaceId: string,
    toolId: string,
    version: string,
    since?: string,
  ): Promise<RolloutTelemetryEvent[]> {
    let sql = `SELECT * FROM rollout_telemetry_events WHERE workspace_id = $1 AND tool_id = $2 AND version = $3`;
    const params: unknown[] = [workspaceId, toolId, version];

    if (since) {
      params.push(since);
      sql += ` AND timestamp >= $${params.length}`;
    }

    sql += ` ORDER BY timestamp ASC`;
    const res = await this.pool.query(sql, params);

    return res.rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      deviceId: row.device_id ? String(row.device_id) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      toolId: String(row.tool_id),
      version: String(row.version),
      artifactDigest: row.artifact_digest ? String(row.artifact_digest) : undefined,
      success: Boolean(row.success),
      durationMs: Number(row.duration_ms),
      errorCode: row.error_code ? String(row.error_code) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      securityViolation: Boolean(row.security_violation),
      securityViolationReason: row.security_violation_reason
        ? String(row.security_violation_reason)
        : undefined,
      quarantineSignal: Boolean(row.quarantine_signal),
      quarantineReason: row.quarantine_reason
        ? String(row.quarantine_reason)
        : undefined,
      capabilityBreach: Boolean(row.capability_breach),
      schemaMismatch: Boolean(row.schema_mismatch),
      signatureValid: Boolean(row.signature_valid ?? true),
      timestamp: String(row.timestamp),
    }));
  }

  /**
   * Calculate aggregated canary metrics window for a rollout.
   */
  async calculateMetricsWindow(
    workspaceId: string,
    toolId: string,
    version: string,
    options?: {
      windowStart?: string;
      baselineP95LatencyMs?: number;
      deviceStatus?: { activeCount: number; offlineCount: number };
    },
  ): Promise<CanaryMetricsWindow> {
    const windowStart = options?.windowStart ?? new Date(Date.now() - 3600000).toISOString();
    const windowEnd = new Date().toISOString();

    const events = await this.getTelemetryEvents(
      workspaceId,
      toolId,
      version,
      windowStart,
    );

    return aggregateTelemetryEvents(
      events,
      windowStart,
      windowEnd,
      options?.baselineP95LatencyMs,
      options?.deviceStatus,
    );
  }

  // -------------------------------------------------------------------------
  // Row Mapping Helpers
  // -------------------------------------------------------------------------

  private mapRolloutRow(row: Record<string, unknown>): RolloutEntity {
    return {
      id: String(row.id),
      accountId: row.account_id ? String(row.account_id) : undefined,
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      targetVersion: String(row.target_version),
      previousVersion: row.previous_version ? String(row.previous_version) : undefined,
      artifactDigest: String(row.artifact_digest),
      manifestDigest: String(row.manifest_digest),
      riskTier: row.risk_tier as RolloutEntity["riskTier"],
      policyId: String(row.policy_id),
      state: row.state as RolloutState,
      canaryTrafficPercentage: Number(row.canary_traffic_percentage ?? 10),
      targetDeviceIds:
        typeof row.target_device_ids === "string"
          ? JSON.parse(row.target_device_ids)
          : (row.target_device_ids as string[] ?? []),
      activeDeviceIds:
        typeof row.active_device_ids === "string"
          ? JSON.parse(row.active_device_ids)
          : (row.active_device_ids as string[] ?? []),
      invocationsCount: Number(row.invocations_count ?? 0),
      failureCount: Number(row.failure_count ?? 0),
      consecutiveCleanWindows: Number(row.consecutive_clean_windows ?? 0),
      metrics: row.metrics
        ? typeof row.metrics === "string"
          ? JSON.parse(row.metrics)
          : (row.metrics as CanaryMetricsWindow)
        : null,
      cooldownUntil: row.cooldown_until ? String(row.cooldown_until) : undefined,
      pinnedVersionOverride: row.pinned_version_override
        ? String(row.pinned_version_override)
        : undefined,
      isDisabled: Boolean(row.is_disabled),
      failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
      startedAt: row.started_at ? String(row.started_at) : undefined,
      observingAt: row.observing_at ? String(row.observing_at) : undefined,
      promotedAt: row.promoted_at ? String(row.promoted_at) : undefined,
      rolledBackAt: row.rolled_back_at ? String(row.rolled_back_at) : undefined,
      suspendedAt: row.suspended_at ? String(row.suspended_at) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
