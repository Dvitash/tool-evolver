import crypto from "node:crypto";
import {
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  type CatalogToolSummary,
  type DeploymentRecord,
  type DeploymentState,
  type DeploymentTransition,
  type DeploymentTransitionReason,
  type InstallationRecord,
  type SafetyGateRefusal,
  type ToolManifest,
  type ToolVersion,
  canonicalJson,
  hashCanonicalContent,
  isSafetyGateBypassTool,
} from "@tool-evolver/contracts";
import type { LocalDatabaseConnection, ToolRepository } from "@tool-evolver/db";
import type { AuditTrailManager } from "../observability/audit-trail.js";
import type { CatalogChangeEvent, LocalDeploymentState } from "./types.js";
/**
 * Listener function for CatalogChangeEvents.
 */
export type CatalogChangeListener = (event: CatalogChangeEvent) => void | Promise<void>;

/**
 * Parameters for activating a deployment.
 */
export interface ActivateDeploymentParams {
  workspaceId: string;
  toolId: string;
  version: string;
  deploymentId?: string;
  targetTrafficPercentage?: number;
  isCanary?: boolean;
  reason?: string;
  transitionReason?: DeploymentTransitionReason;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Result of activating a deployment.
 */
export interface ActivationResult {
  success: boolean;
  deploymentId: string;
  toolId: string;
  version: string;
  state: LocalDeploymentState;
  activeTrafficPercentage: number;
  revision: number;
  snapshot: CatalogSnapshot;
  appliedAt: string;
}

/**
 * Parameters for rolling back a deployment.
 */
export interface RollbackDeploymentParams {
  workspaceId: string;
  toolId: string;
  targetVersion?: string;
  targetSnapshotId?: string;
  reason?: string;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
}

/**
 * Result of rolling back a deployment.
 */
export interface RollbackResult {
  success: boolean;
  deploymentId: string;
  toolId: string;
  rolledBackVersion: string;
  restoredVersion?: string;
  state: LocalDeploymentState;
  revision: number;
  snapshot: CatalogSnapshot;
  appliedAt: string;
}

/**
 * Parameters for suspending a deployment.
 */
export interface SuspendDeploymentParams {
  workspaceId: string;
  toolId: string;
  version?: string;
  reason?: string;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
}

/**
 * Parameters for resuming a deployment.
 */
export interface ResumeDeploymentParams {
  workspaceId: string;
  toolId: string;
  version?: string;
  reason?: string;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
}

/**
 * Parameters for retiring a deployment.
 */
export interface RetireDeploymentParams {
  workspaceId: string;
  toolId: string;
  version?: string;
  reason?: string;
  actor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
}

/**
 * Options for DeploymentActivator.
 */
export interface SafetyGateLike {
  canExecuteTool(
    toolId: string,
    toolName: string,
    isSystem?: boolean,
  ): { allowed: boolean; refusal?: SafetyGateRefusal };
  isUnsafeOverrideActive?(): boolean;
}

export interface DeploymentActivatorOptions {
  conn: LocalDatabaseConnection;
  toolRepo?: ToolRepository;
  defaultActor?: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };
  safetyGate?: SafetyGateLike;
  auditTrail?: AuditTrailManager;
}

/**
 * Atomic deployment activator managing transition through SQLite in single transactions,
 * emitting catalog change events (TE-018) and guaranteeing crash resilience.
 */
export class DeploymentActivator {
  private readonly conn: LocalDatabaseConnection;
  private readonly toolRepo?: ToolRepository;
  private readonly listeners = new Set<CatalogChangeListener>();
  private safetyGate?: SafetyGateLike;
  private auditTrail?: AuditTrailManager;
  private readonly defaultActor: {
    type: "daemon" | "user" | "policy_engine" | "gateway" | "system";
    id: string;
  };

  constructor(options: DeploymentActivatorOptions) {
    this.conn = options.conn;
    this.toolRepo = options.toolRepo;
    this.safetyGate = options.safetyGate;
    this.auditTrail = options.auditTrail;
    this.defaultActor = options.defaultActor ?? {
      type: "daemon",
      id: "observer-daemon",
    };
  }
  setSafetyGate(safetyGate: SafetyGateLike): void {
    this.safetyGate = safetyGate;
  }

  setAuditTrail(auditTrail: AuditTrailManager): void {
    this.auditTrail = auditTrail;
  }
  /**
   * Register a listener for catalog change notifications.
   */
  onCatalogChange(listener: CatalogChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Broadcast catalog change event to all registered listeners.
   */
  private emitCatalogChange(event: CatalogChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        void listener(event);
      } catch {
        // Suppress listener errors
      }
    }
  }

  /**
   * Stages a tool manifest and version in the local database.
   */
  async stageTool(
    manifest: ToolManifest,
    options: {
      workspaceId?: string;
      artifactDigest?: string;
      bundleUri?: string;
      status?: "draft" | "active";
      createdBy?: string;
    } = {},
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const manifestDigest =
      manifest.digest || crypto.createHash("sha256").update(canonicalJson(manifest)).digest("hex");
    const artifactDigest = options.artifactDigest ?? manifestDigest;

    await this.conn.transaction(async () => {
      // 1. Upsert tool manifest
      this.conn.run(
        `INSERT INTO tool_manifests (
          tool_id, name, version, description, scope, parameters_json,
          output_schema_json, runtime_json, capabilities_json, limits_json,
          digest, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tool_id) DO UPDATE SET
          name = excluded.name,
          version = excluded.version,
          description = excluded.description,
          scope = excluded.scope,
          parameters_json = excluded.parameters_json,
          output_schema_json = excluded.output_schema_json,
          runtime_json = excluded.runtime_json,
          capabilities_json = excluded.capabilities_json,
          limits_json = excluded.limits_json,
          digest = excluded.digest,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at;`,
        [
          manifest.id,
          manifest.name,
          manifest.version,
          manifest.description,
          manifest.scope ?? "workspace",
          canonicalJson(manifest.parameters ?? {}),
          manifest.outputSchema ? canonicalJson(manifest.outputSchema) : null,
          canonicalJson(manifest.runtime ?? {}),
          canonicalJson(manifest.capabilities ?? {}),
          canonicalJson(manifest.limits ?? {}),
          manifestDigest,
          canonicalJson(manifest.metadata ?? {}),
          timestamp,
          timestamp,
        ],
      );

      // 2. Upsert tool version
      const artifactObj = {
        artifactDigest,
        bundleReference: {
          uri: options.bundleUri ?? `memory://${manifest.id}/${manifest.version}`,
          hash: artifactDigest,
          format: "tar",
        },
      };

      const provenanceObj = {
        synthesizer: "manual",
        evolutionStrategy: "deterministic",
        createdAt: timestamp,
      };

      this.conn.run(
        `INSERT INTO tool_versions (
          tool_id, version, manifest_digest, artifact_digest, manifest_json,
          artifact_json, provenance_json, signature_json, status, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)
        ON CONFLICT(tool_id, version) DO UPDATE SET
          manifest_digest = excluded.manifest_digest,
          artifact_digest = excluded.artifact_digest,
          manifest_json = excluded.manifest_json,
          artifact_json = excluded.artifact_json,
          provenance_json = excluded.provenance_json,
          status = excluded.status;`,
        [
          manifest.id,
          manifest.version,
          manifestDigest,
          artifactDigest,
          canonicalJson(manifest),
          canonicalJson(artifactObj),
          canonicalJson(provenanceObj),
          options.status ?? "draft",
          timestamp,
          options.createdBy ?? "system",
        ],
      );
    });
  }

  /**
   * Atomically activates a tool deployment for a workspace in a single SQLite transaction.
   */
  async activate(params: ActivateDeploymentParams): Promise<ActivationResult> {
    const timestamp = new Date().toISOString();
    const actor = params.actor ?? this.defaultActor;
    const isCanary = Boolean(params.isCanary);
    const trafficPct = isCanary ? (params.targetTrafficPercentage ?? 10) : 100;
    const targetState: DeploymentState = isCanary ? "canary" : "promoted";

    // Safety gate fail-closed enforcement on non-system tools
    if (this.safetyGate && !isSafetyGateBypassTool(params.toolId)) {
      const check = this.safetyGate.canExecuteTool(params.toolId, params.toolId, false);
      if (!check.allowed && check.refusal) {
        if (this.auditTrail) {
          const auditActor = {
            type: (actor.type === "gateway" ? "system" : actor.type) as
              | "daemon"
              | "user"
              | "policy_engine"
              | "system"
              | "agent",
            id: actor.id,
          };
          await this.auditTrail.append({
            eventType: "safety_gate_refusal",
            actor: auditActor,
            resourceType: "deployment",
            resourceId: params.toolId,
            action: "activate",
            status: "denied",
            details: {
              reason: check.refusal.refusalReason,
              code: check.refusal.refusalCode,
              remediation: check.refusal.remediation,
              unmetGates: check.refusal.unmetGates,
              toolId: params.toolId,
              version: params.version,
            },
          });
        }
        throw new Error(
          `Deployment activation blocked by fail-closed safety gate: ${check.refusal.refusalReason}`,
        );
      }

      if (this.safetyGate.isUnsafeOverrideActive?.() && this.auditTrail) {
        const auditActor = {
          type: (actor.type === "gateway" ? "system" : actor.type) as
            | "daemon"
            | "user"
            | "policy_engine"
            | "system"
            | "agent",
          id: actor.id,
        };
        await this.auditTrail.append({
          eventType: "safety_gate_unsafe_override",
          actor: auditActor,
          workspaceId: params.workspaceId,
          resourceType: "deployment",
          resourceId: params.toolId,
          action: "activate",
          status: "success",
          details: {
            warning: "Unsafe development override active during tool activation",
            toolId: params.toolId,
            version: params.version,
          },
        });
      }
    }

    let snapshotResult: CatalogSnapshot | null = null;
    let deploymentIdResult = params.deploymentId;
    let revisionResult = 1;

    await this.conn.transaction(async () => {
      // 1. Ensure workspace exists
      let wsRow = this.conn.get<{
        workspace_id: string;
        active_tools_json: string;
        capability_envelope_json: string;
      }>(
        "SELECT workspace_id, active_tools_json, capability_envelope_json FROM workspaces WHERE workspace_id = ?;",
        [params.workspaceId],
      );

      if (!wsRow) {
        this.conn.run(
          `INSERT INTO workspaces (
            workspace_id, root_path, name, config_json, capability_envelope_json,
            active_tools_json, created_at, updated_at
          ) VALUES (?, ?, ?, '{}', '{}', '{}', ?, ?);`,
          [
            params.workspaceId,
            `/workspaces/${params.workspaceId}`,
            params.workspaceId,
            timestamp,
            timestamp,
          ],
        );
        wsRow = {
          workspace_id: params.workspaceId,
          active_tools_json: "{}",
          capability_envelope_json: "{}",
        };
      }

      const activeTools: Record<string, string> = JSON.parse(wsRow.active_tools_json || "{}");

      // 2. Read or create deployment record
      let depRow = this.conn.get<{
        deployment_id: string;
        state: string;
        history_json: string;
      }>(
        "SELECT deployment_id, state, history_json FROM deployment_records WHERE workspace_id = ? AND tool_id = ? AND tool_version = ?;",
        [params.workspaceId, params.toolId, params.version],
      );

      if (!depRow && params.deploymentId) {
        depRow = this.conn.get<{
          deployment_id: string;
          state: string;
          history_json: string;
        }>(
          "SELECT deployment_id, state, history_json FROM deployment_records WHERE deployment_id = ?;",
          [params.deploymentId],
        );
      }

      const deploymentId =
        depRow?.deployment_id ?? params.deploymentId ?? `dep_${crypto.randomUUID()}`;
      deploymentIdResult = deploymentId;
      const previousState = (depRow?.state as DeploymentState) ?? "drafted";
      const history: DeploymentTransition[] = JSON.parse(depRow?.history_json || "[]");

      const transReason: DeploymentTransitionReason =
        params.transitionReason ?? (isCanary ? "canary_started" : "auto_promotion");

      const transition: DeploymentTransition = {
        fromState: previousState,
        toState: targetState,
        timestamp,
        reason: transReason,
        actor,
        message: params.reason ?? `Activated tool ${params.toolId} v${params.version}`,
        metadata: params.metadata ?? {},
      };
      history.push(transition);

      // 3. Upsert deployment record
      this.conn.run(
        `INSERT INTO deployment_records (
          deployment_id, workspace_id, tool_id, tool_version, state,
          canary_config_json, history_json, active_traffic_percentage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(deployment_id) DO UPDATE SET
          state = excluded.state,
          canary_config_json = excluded.canary_config_json,
          history_json = excluded.history_json,
          active_traffic_percentage = excluded.active_traffic_percentage,
          updated_at = excluded.updated_at;`,
        [
          deploymentId,
          params.workspaceId,
          params.toolId,
          params.version,
          targetState,
          isCanary ? JSON.stringify({ trafficPercentage: trafficPct }) : null,
          canonicalJson(history),
          trafficPct,
          timestamp,
          timestamp,
        ],
      );

      // 4. Update tool_versions status to active
      this.conn.run(
        "UPDATE tool_versions SET status = 'active' WHERE tool_id = ? AND version = ?;",
        [params.toolId, params.version],
      );

      // 5. Upsert installation record in table installations
      this.conn.run(
        `INSERT INTO installations (
          installation_id, workspace_id, tool_id, tool_version, deployment_id,
          installed_at, state, config_overrides_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          tool_version = excluded.tool_version,
          deployment_id = excluded.deployment_id,
          installed_at = excluded.installed_at,
          state = 'active',
          updated_at = excluded.updated_at;`,
        [
          `inst_${params.workspaceId}_${params.toolId}`,
          params.workspaceId,
          params.toolId,
          params.version,
          deploymentId,
          timestamp,
          timestamp,
          timestamp,
        ],
      );

      // 6. Update workspace active tools mapping
      activeTools[params.toolId] = params.version;
      this.conn.run(
        "UPDATE workspaces SET active_tools_json = ?, updated_at = ? WHERE workspace_id = ?;",
        [canonicalJson(activeTools), timestamp, params.workspaceId],
      );

      // 7. Generate and save new CatalogSnapshot
      const toolSummaries: Record<string, CatalogToolSummary> = {};

      for (const [tId, tVer] of Object.entries(activeTools)) {
        const manifestRow = this.conn.get<{
          scope: string;
          digest: string;
        }>("SELECT scope, digest FROM tool_manifests WHERE tool_id = ?;", [tId]);

        toolSummaries[tId] = {
          toolId: tId,
          version: tVer,
          manifestDigest:
            manifestRow?.digest ??
            crypto.createHash("sha256").update(`${tId}@${tVer}`).digest("hex"),
          scope: (manifestRow?.scope as "workspace" | "user" | "global" | "session") ?? "workspace",
          status: "active",
        };
      }

      // Determine next revision number
      const latestSnap = this.conn.get<{
        snapshot_id: string;
      }>(
        "SELECT snapshot_id FROM catalog_snapshots WHERE workspace_id = ? ORDER BY timestamp DESC, snapshot_id DESC LIMIT 1;",
        [params.workspaceId],
      );

      let nextRev = 1;
      if (latestSnap) {
        const match = latestSnap.snapshot_id.match(/_rev(\d+)$/);
        if (match) {
          nextRev = Number.parseInt(match[1], 10) + 1;
        }
      }
      revisionResult = nextRev;

      const snapshotDigest = hashCanonicalContent({
        workspaceId: params.workspaceId,
        tools: toolSummaries,
      });

      const snapshotId = `snap_${params.workspaceId}_rev${nextRev}`;
      snapshotResult = {
        snapshotId,
        workspaceId: params.workspaceId,
        timestamp,
        tools: toolSummaries,
        digest: snapshotDigest,
      };

      this.conn.run(
        `INSERT INTO catalog_snapshots (
          snapshot_id, workspace_id, timestamp, tools_json, digest
        ) VALUES (?, ?, ?, ?, ?);`,
        [snapshotId, params.workspaceId, timestamp, canonicalJson(toolSummaries), snapshotDigest],
      );
    });

    if (!snapshotResult || !deploymentIdResult) {
      throw new Error("Failed to activate deployment in transaction");
    }

    // Emit catalog change event after successful transaction commit
    const event: CatalogChangeEvent = {
      workspaceId: params.workspaceId,
      revision: revisionResult,
      snapshot: snapshotResult,
      changedToolIds: [params.toolId],
      timestamp,
    };
    this.emitCatalogChange(event);

    return {
      success: true,
      deploymentId: deploymentIdResult,
      toolId: params.toolId,
      version: params.version,
      state: isCanary ? "canary" : "active",
      activeTrafficPercentage: trafficPct,
      revision: revisionResult,
      snapshot: snapshotResult,
      appliedAt: timestamp,
    };
  }

  /**
   * Atomically rolls back a deployment in a single SQLite transaction.
   */
  async rollback(params: RollbackDeploymentParams): Promise<RollbackResult> {
    const timestamp = new Date().toISOString();
    const actor = params.actor ?? this.defaultActor;

    let snapshotResult: CatalogSnapshot | null = null;
    let rolledBackVersion = "";
    let restoredVersion: string | undefined;
    let deploymentIdResult = "";
    let revisionResult = 1;

    await this.conn.transaction(async () => {
      const wsRow = this.conn.get<{
        active_tools_json: string;
      }>("SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;", [params.workspaceId]);

      const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
      rolledBackVersion = activeTools[params.toolId] ?? "";

      // Read current deployment record
      const depRow = this.conn.get<{
        deployment_id: string;
        state: string;
        history_json: string;
      }>(
        "SELECT deployment_id, state, history_json FROM deployment_records WHERE workspace_id = ? AND tool_id = ? ORDER BY created_at DESC LIMIT 1;",
        [params.workspaceId, params.toolId],
      );

      const deploymentId = depRow?.deployment_id ?? `dep_${crypto.randomUUID()}`;
      deploymentIdResult = deploymentId;
      const history: DeploymentTransition[] = JSON.parse(depRow?.history_json || "[]");

      // Record rolling_back and rolled_back transition
      history.push({
        fromState: (depRow?.state as DeploymentState) ?? "promoted",
        toState: "rolled_back",
        timestamp,
        reason: "manual_rollback",
        actor,
        message: params.reason ?? `Rolled back tool ${params.toolId}`,
        metadata: {},
      });

      this.conn.run(
        `UPDATE deployment_records SET
          state = 'rolled_back',
          history_json = ?,
          active_traffic_percentage = 0,
          updated_at = ?
        WHERE deployment_id = ?;`,
        [canonicalJson(history), timestamp, deploymentId],
      );

      // Determine rollback target version
      if (params.targetVersion) {
        restoredVersion = params.targetVersion;
      } else if (params.targetSnapshotId) {
        const snapRow = this.conn.get<{
          tools_json: string;
        }>("SELECT tools_json FROM catalog_snapshots WHERE snapshot_id = ?;", [
          params.targetSnapshotId,
        ]);
        if (snapRow) {
          const snapTools: Record<string, CatalogToolSummary> = JSON.parse(snapRow.tools_json);
          restoredVersion = snapTools[params.toolId]?.version;
        }
      } else {
        // 1. Look back in historical catalog_snapshots
        const snapRows = this.conn.all<{
          tools_json: string;
        }>(
          "SELECT tools_json FROM catalog_snapshots WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 10;",
          [params.workspaceId],
        );

        for (const sRow of snapRows) {
          try {
            const sTools: Record<string, CatalogToolSummary> = JSON.parse(sRow.tools_json);
            const candVer = sTools[params.toolId]?.version;
            if (candVer && candVer !== rolledBackVersion) {
              restoredVersion = candVer;
              break;
            }
          } catch {
            // Ignore parse error
          }
        }

        // 2. Fallback to deployment_records
        if (!restoredVersion) {
          const prevDepRow = this.conn.get<{
            tool_version: string;
          }>(
            "SELECT tool_version FROM deployment_records WHERE workspace_id = ? AND tool_id = ? AND tool_version != ? ORDER BY rowid DESC LIMIT 1;",
            [params.workspaceId, params.toolId, rolledBackVersion],
          );
          restoredVersion = prevDepRow?.tool_version;
        }
      }

      if (restoredVersion) {
        activeTools[params.toolId] = restoredVersion;
        this.conn.run(
          "UPDATE installations SET tool_version = ?, state = 'active', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
          [restoredVersion, timestamp, params.workspaceId, params.toolId],
        );
      } else {
        delete activeTools[params.toolId];
        this.conn.run(
          "UPDATE installations SET state = 'uninstalled', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
          [timestamp, params.workspaceId, params.toolId],
        );
      }

      this.conn.run(
        "UPDATE workspaces SET active_tools_json = ?, updated_at = ? WHERE workspace_id = ?;",
        [canonicalJson(activeTools), timestamp, params.workspaceId],
      );

      // Generate new CatalogSnapshot
      const toolSummaries: Record<string, CatalogToolSummary> = {};
      for (const [tId, tVer] of Object.entries(activeTools)) {
        const manifestRow = this.conn.get<{
          scope: string;
          digest: string;
        }>("SELECT scope, digest FROM tool_manifests WHERE tool_id = ?;", [tId]);

        toolSummaries[tId] = {
          toolId: tId,
          version: tVer,
          manifestDigest:
            manifestRow?.digest ??
            crypto.createHash("sha256").update(`${tId}@${tVer}`).digest("hex"),
          scope: (manifestRow?.scope as "workspace" | "user" | "global" | "session") ?? "workspace",
          status: "active",
        };
      }

      const latestSnap = this.conn.get<{
        snapshot_id: string;
      }>(
        "SELECT snapshot_id FROM catalog_snapshots WHERE workspace_id = ? ORDER BY timestamp DESC, snapshot_id DESC LIMIT 1;",
        [params.workspaceId],
      );

      let nextRev = 1;
      if (latestSnap) {
        const match = latestSnap.snapshot_id.match(/_rev(\d+)$/);
        if (match) {
          nextRev = Number.parseInt(match[1], 10) + 1;
        }
      }
      revisionResult = nextRev;

      const snapshotDigest = hashCanonicalContent({
        workspaceId: params.workspaceId,
        tools: toolSummaries,
      });

      const snapshotId = `snap_${params.workspaceId}_rev${nextRev}`;
      snapshotResult = {
        snapshotId,
        workspaceId: params.workspaceId,
        timestamp,
        tools: toolSummaries,
        digest: snapshotDigest,
      };

      this.conn.run(
        `INSERT INTO catalog_snapshots (
          snapshot_id, workspace_id, timestamp, tools_json, digest
        ) VALUES (?, ?, ?, ?, ?);`,
        [snapshotId, params.workspaceId, timestamp, canonicalJson(toolSummaries), snapshotDigest],
      );
    });

    if (!snapshotResult) {
      throw new Error("Failed to rollback deployment in transaction");
    }

    const event: CatalogChangeEvent = {
      workspaceId: params.workspaceId,
      revision: revisionResult,
      snapshot: snapshotResult,
      changedToolIds: [params.toolId],
      timestamp,
    };
    this.emitCatalogChange(event);

    return {
      success: true,
      deploymentId: deploymentIdResult,
      toolId: params.toolId,
      rolledBackVersion,
      restoredVersion,
      state: "rolled_back",
      revision: revisionResult,
      snapshot: snapshotResult,
      appliedAt: timestamp,
    };
  }

  /**
   * Suspends an active deployment.
   */
  async suspend(
    params: SuspendDeploymentParams,
  ): Promise<{ success: boolean; snapshot: CatalogSnapshot }> {
    const timestamp = new Date().toISOString();
    let snapshotResult: CatalogSnapshot | null = null;
    let revisionResult = 1;

    await this.conn.transaction(async () => {
      const wsRow = this.conn.get<{
        active_tools_json: string;
      }>("SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;", [params.workspaceId]);

      const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
      delete activeTools[params.toolId];

      this.conn.run(
        "UPDATE workspaces SET active_tools_json = ?, updated_at = ? WHERE workspace_id = ?;",
        [canonicalJson(activeTools), timestamp, params.workspaceId],
      );

      this.conn.run(
        "UPDATE deployment_records SET state = 'suspended', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
        [timestamp, params.workspaceId, params.toolId],
      );

      this.conn.run(
        "UPDATE installations SET state = 'inactive', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
        [timestamp, params.workspaceId, params.toolId],
      );

      // Generate new CatalogSnapshot
      const toolSummaries: Record<string, CatalogToolSummary> = {};
      for (const [tId, tVer] of Object.entries(activeTools)) {
        const manifestRow = this.conn.get<{
          scope: string;
          digest: string;
        }>("SELECT scope, digest FROM tool_manifests WHERE tool_id = ?;", [tId]);

        toolSummaries[tId] = {
          toolId: tId,
          version: tVer,
          manifestDigest:
            manifestRow?.digest ??
            crypto.createHash("sha256").update(`${tId}@${tVer}`).digest("hex"),
          scope: (manifestRow?.scope as "workspace" | "user" | "global" | "session") ?? "workspace",
          status: "active",
        };
      }

      const latestSnap = this.conn.get<{
        snapshot_id: string;
      }>(
        "SELECT snapshot_id FROM catalog_snapshots WHERE workspace_id = ? ORDER BY timestamp DESC, snapshot_id DESC LIMIT 1;",
        [params.workspaceId],
      );

      let nextRev = 1;
      if (latestSnap) {
        const match = latestSnap.snapshot_id.match(/_rev(\d+)$/);
        if (match) nextRev = Number.parseInt(match[1], 10) + 1;
      }
      revisionResult = nextRev;

      const snapshotDigest = hashCanonicalContent({
        workspaceId: params.workspaceId,
        tools: toolSummaries,
      });

      const snapshotId = `snap_${params.workspaceId}_rev${nextRev}`;
      snapshotResult = {
        snapshotId,
        workspaceId: params.workspaceId,
        timestamp,
        tools: toolSummaries,
        digest: snapshotDigest,
      };

      this.conn.run(
        "INSERT INTO catalog_snapshots (snapshot_id, workspace_id, timestamp, tools_json, digest) VALUES (?, ?, ?, ?, ?);",
        [snapshotId, params.workspaceId, timestamp, canonicalJson(toolSummaries), snapshotDigest],
      );
    });

    if (!snapshotResult) {
      throw new Error("Failed to suspend deployment");
    }

    const event: CatalogChangeEvent = {
      workspaceId: params.workspaceId,
      revision: revisionResult,
      snapshot: snapshotResult,
      changedToolIds: [params.toolId],
      timestamp,
    };
    this.emitCatalogChange(event);

    return { success: true, snapshot: snapshotResult };
  }

  /**
   * Resumes a suspended deployment.
   */
  async resume(params: ResumeDeploymentParams): Promise<ActivationResult> {
    // Find version for tool
    let version = params.version;
    if (!version) {
      const depRow = this.conn.get<{
        tool_version: string;
      }>(
        "SELECT tool_version FROM deployment_records WHERE workspace_id = ? AND tool_id = ? ORDER BY created_at DESC LIMIT 1;",
        [params.workspaceId, params.toolId],
      );
      version = depRow?.tool_version;
    }

    if (!version) {
      throw new Error(`No deployment record found to resume for tool '${params.toolId}'`);
    }

    return this.activate({
      workspaceId: params.workspaceId,
      toolId: params.toolId,
      version,
      reason: params.reason ?? "Resumed deployment",
      actor: params.actor,
    });
  }

  /**
   * Retires a deployment.
   */
  async retire(params: RetireDeploymentParams): Promise<{ success: boolean }> {
    const timestamp = new Date().toISOString();

    await this.conn.transaction(async () => {
      const wsRow = this.conn.get<{
        active_tools_json: string;
      }>("SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;", [params.workspaceId]);

      const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
      delete activeTools[params.toolId];

      this.conn.run(
        "UPDATE workspaces SET active_tools_json = ?, updated_at = ? WHERE workspace_id = ?;",
        [canonicalJson(activeTools), timestamp, params.workspaceId],
      );

      this.conn.run(
        "UPDATE deployment_records SET state = 'retired', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
        [timestamp, params.workspaceId, params.toolId],
      );

      this.conn.run("UPDATE tool_versions SET status = 'revoked' WHERE tool_id = ?;", [
        params.toolId,
      ]);

      this.conn.run(
        "UPDATE installations SET state = 'uninstalled', updated_at = ? WHERE workspace_id = ? AND tool_id = ?;",
        [timestamp, params.workspaceId, params.toolId],
      );
    });

    return { success: true };
  }
}
