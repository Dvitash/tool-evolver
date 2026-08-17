import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../../db/client.js";
import { OutboxRepository, type OutboxPublisher } from "../../db/outbox.js";
import type { TenantContext } from "../../tenant.js";
import type { CloudCatalogService } from "../../mcp/catalog-service.js";
import type { ToolRegistryRepository } from "../artifacts/repositories/tool-registry-repository.js";
import {
  type AssignmentResolutionContext,
  RolloutAssignmentRouter,
} from "./assignment.js";
import { RolloutEvaluator } from "./evaluator.js";
import { RolloutPolicyRegistry } from "./policy.js";
import { RolloutRepository } from "./repositories/rollout-repository.js";
import {
  type CanaryMetricsWindow,
  type DeploymentCommand,
  type RolloutDecision,
  type RolloutEntity,
  type RolloutFilter,
  type RolloutIncidentRecord,
  type RolloutOverrideRecord,
  type RolloutPolicy,
  type RolloutRiskTier,
  type RolloutSessionAssignment,
  type RolloutState,
  type RolloutTelemetryEvent,
  RolloutCooldownActiveError,
  RolloutNotFoundError,
  RolloutPinnedVersionConflictError,
  RolloutStateTransitionError,
  RolloutToolDisabledError,
} from "./types.js";

/**
 * Parameters for creating a new Rollout.
 */
export interface CreateRolloutParams {
  toolId: string;
  version: string;
  artifactDigest: string;
  manifestDigest: string;
  riskTier?: RolloutRiskTier;
  policyId?: string;
  targetDeviceIds?: string[];
  previousVersion?: string;
  isBreakingSchema?: boolean;
  canaryTrafficPercentage?: number;
}

/**
 * Options for configuring RolloutController.
 */
export interface RolloutControllerOptions {
  toolRegistryRepo?: ToolRegistryRepository;
  rolloutRepo?: RolloutRepository;
  policyRegistry?: RolloutPolicyRegistry;
  evaluator?: RolloutEvaluator;
  assignmentRouter?: RolloutAssignmentRouter;
  outboxPublisher?: OutboxPublisher;
  catalogService?: CloudCatalogService;
}

/**
 * RolloutController: Orchestrates autonomous canary deployment, continuous health
 * evaluation, automated progression/promotion, sticky session routing, and instant
 * automatic rollback upon policy or security breach.
 */
export class RolloutController {
  readonly rolloutRepo: RolloutRepository;
  readonly policyRegistry: RolloutPolicyRegistry;
  readonly evaluator: RolloutEvaluator;
  readonly assignmentRouter: RolloutAssignmentRouter;
  private toolRegistryRepo?: ToolRegistryRepository;
  private outboxPublisher?: OutboxPublisher;
  private catalogService?: CloudCatalogService;

  constructor(
    private pool: DatabasePool,
    options: RolloutControllerOptions = {},
  ) {
    this.rolloutRepo =
      options.rolloutRepo ?? new RolloutRepository(this.pool);
    this.policyRegistry =
      options.policyRegistry ?? new RolloutPolicyRegistry();
    this.evaluator = options.evaluator ?? new RolloutEvaluator();
    this.assignmentRouter =
      options.assignmentRouter ??
      new RolloutAssignmentRouter(this.rolloutRepo);
    this.toolRegistryRepo = options.toolRegistryRepo;
    this.outboxPublisher = options.outboxPublisher;
    this.catalogService = options.catalogService;
  }

  // -------------------------------------------------------------------------
  // 1. Rollout Creation & Bounded Canary Activation (TE-035 -> TE-036)
  // -------------------------------------------------------------------------

  /**
   * Creates and initializes a canary rollout for an eligible published tool version.
   *
   * Enforces:
   * - Cooldown prevention against auto-redeployment of failed artifact digests.
   * - User pin and disable overrides.
   * - Discovery of previous known good version for safe rollback routing.
   * - Issuance of TE-036 deployment commands to targeted devices.
   */
  async createRolloutForPublishedVersion(
    tenant: TenantContext,
    params: CreateRolloutParams,
  ): Promise<RolloutEntity> {
    const workspaceId = tenant.workspaceId;
    const accountId = tenant.accountId ?? "acc_default";
    const now = new Date().toISOString();

    // 1. Enforce Cooldown Check
    const cooldownCheck = await this.rolloutRepo.isArtifactInCooldown(
      workspaceId,
      params.artifactDigest,
    );
    if (cooldownCheck.inCooldown && cooldownCheck.cooldownUntil) {
      throw new RolloutCooldownActiveError(
        params.artifactDigest,
        cooldownCheck.cooldownUntil,
        cooldownCheck.reason,
      );
    }

    // 2. Enforce User Configuration Overrides
    const override = await this.rolloutRepo.getOverride(
      workspaceId,
      params.toolId,
    );
    if (override) {
      if (override.overrideType === "disabled") {
        throw new RolloutToolDisabledError(params.toolId, workspaceId);
      }
      if (
        override.overrideType === "pinned" &&
        override.pinnedVersion &&
        override.pinnedVersion !== params.version
      ) {
        throw new RolloutPinnedVersionConflictError(
          params.toolId,
          override.pinnedVersion,
          params.version,
        );
      }
    }

    // 3. Resolve Rollout Policy
    let policy: RolloutPolicy;
    if (params.policyId) {
      const found = this.policyRegistry.getPolicy(params.policyId);
      if (!found) {
        throw new Error(`Rollout policy not found: ${params.policyId}`);
      }
      policy = found;
    } else {
      policy = this.policyRegistry.getPolicyForRiskTier(
        params.riskTier ?? "tier1_low",
      );
    }

    // 4. Discover Previous Known Good Version
    let previousVersion = params.previousVersion;
    if (!previousVersion) {
      const latestPromoted = await this.rolloutRepo.getLatestPromotedRollout(
        workspaceId,
        params.toolId,
      );
      if (latestPromoted) {
        previousVersion = latestPromoted.targetVersion;
      } else if (this.toolRegistryRepo) {
        const tool = await this.toolRegistryRepo.getTool(tenant, params.toolId);
        previousVersion = tool?.activeVersion ?? "1.0.0";
      } else {
        previousVersion = "1.0.0";
      }
    }

    // 5. Build Initial Rollout Entity
    const rolloutId = randomUUID();
    const canaryPercentage =
      params.canaryTrafficPercentage ??
      Math.round(policy.canaryExposureRatio * 100);

    const rollout: RolloutEntity = {
      id: rolloutId,
      accountId,
      workspaceId,
      toolId: params.toolId,
      targetVersion: params.version,
      previousVersion,
      artifactDigest: params.artifactDigest,
      manifestDigest: params.manifestDigest,
      riskTier: policy.riskTier,
      policyId: policy.policyId,
      state: "canary",
      canaryTrafficPercentage: canaryPercentage,
      targetDeviceIds: params.targetDeviceIds ?? [],
      activeDeviceIds: params.targetDeviceIds ?? [],
      invocationsCount: 0,
      failureCount: 0,
      consecutiveCleanWindows: 0,
      metrics: null,
      isDisabled: false,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    // 6. Persist Rollout Entity
    await this.rolloutRepo.createRollout(tenant, rollout);

    // 7. Record Initial Start Decision
    const initialDecision: RolloutDecision = {
      decisionId: randomUUID(),
      rolloutId,
      workspaceId,
      toolId: params.toolId,
      targetVersion: params.version,
      fromState: "pending",
      toState: "canary",
      action: "start_canary",
      reason: `Autonomous canary started with ${canaryPercentage}% exposure ratio under policy ${policy.policyId} (${policy.riskTier})`,
      confidence: 1.0,
      triggers: ["canary_initiated"],
      evaluatedAt: now,
    };
    await this.rolloutRepo.saveDecision(initialDecision);

    // 8. Issue TE-036 Deployment Command & Outbox Event
    const deploymentCommand: DeploymentCommand = {
      commandId: randomUUID(),
      workspaceId,
      toolId: params.toolId,
      targetVersion: params.version,
      action: "install_canary",
      canaryTrafficPercentage: canaryPercentage,
      artifactDigest: params.artifactDigest,
      manifestDigest: params.manifestDigest,
      reason: `Canary rollout started: ${params.version}`,
      issuedAt: now,
    };
    await this.issueDeploymentCommand(tenant, deploymentCommand);

    return rollout;
  }

  // -------------------------------------------------------------------------
  // 2. Ingestion of Actual-State Telemetry & Real-Time Hard Signal Trigger
  // -------------------------------------------------------------------------

  /**
   * Ingests an actual-state invocation telemetry event.
   *
   * Fast-path: If the event contains a hard security/quarantine/breach signal,
   * an instant automatic rollback is triggered immediately!
   */
  async recordTelemetry(
    event: RolloutTelemetryEvent,
  ): Promise<RolloutDecision | null> {
    // 1. Persist telemetry event
    await this.rolloutRepo.saveTelemetryEvent(event);

    // 2. Find active rollout
    const activeRollout = await this.rolloutRepo.getActiveRolloutForTool(
      event.workspaceId,
      event.toolId,
    );

    if (!activeRollout || activeRollout.targetVersion !== event.version) {
      return null;
    }

    // 3. Update invocation & failure counters
    const newInvocations = activeRollout.invocationsCount + 1;
    const newFailures = event.success
      ? activeRollout.failureCount
      : activeRollout.failureCount + 1;

    // 4. Hard Signal Fast Path (Instant Automatic Rollback)
    const isHardSignal =
      event.securityViolation ||
      event.quarantineSignal ||
      event.capabilityBreach ||
      event.signatureValid === false;

    if (isHardSignal) {
      const triggers: string[] = [];
      if (event.securityViolation) triggers.push("security_violation");
      if (event.quarantineSignal) triggers.push("quarantine_signal");
      if (event.capabilityBreach) triggers.push("capability_breach");
      if (event.signatureValid === false) triggers.push("signature_tamper");

      const reason = [
        event.securityViolation
          ? `Security violation: ${event.securityViolationReason ?? "unspecified"}`
          : null,
        event.quarantineSignal
          ? `Local quarantine signal from TE-024: ${event.quarantineReason ?? "quarantined"}`
          : null,
        event.capabilityBreach ? "Capability boundary breach" : null,
        event.signatureValid === false ? "Signature verification failure" : null,
      ]
        .filter(Boolean)
        .join("; ");

      return this.executeRollback(
        activeRollout,
        `Instant rollback on telemetry hard signal: ${reason}`,
        triggers,
        {
          windowStart: activeRollout.startedAt ?? new Date().toISOString(),
          windowEnd: new Date().toISOString(),
          totalInvocations: newInvocations,
          successCount: newInvocations - newFailures,
          failureCount: newFailures,
          successRate: (newInvocations - newFailures) / newInvocations,
          errorRate: newFailures / newInvocations,
          latenciesMs: [event.durationMs],
          p50LatencyMs: event.durationMs,
          p95LatencyMs: event.durationMs,
          p99LatencyMs: event.durationMs,
          policyViolations: 0,
          securityViolations: event.securityViolation ? 1 : 0,
          quarantineSignals: event.quarantineSignal ? 1 : 0,
          capabilityBreaches: event.capabilityBreach ? 1 : 0,
          schemaMismatches: event.schemaMismatch ? 1 : 0,
          signatureValid: event.signatureValid ?? true,
          activeDevicesCount: 1,
          offlineDevicesCount: 0,
          deviceReportingRate: 1.0,
          quarantineReasons: event.quarantineReason ? [event.quarantineReason] : [],
          securityViolationDetails: event.securityViolation
            ? [
                {
                  type: "security_violation",
                  reason:
                    event.securityViolationReason ?? "Security violation reported",
                  timestamp: event.timestamp,
                },
              ]
            : [],
        },
      );
    }

    // 5. Update counts on active rollout
    await this.rolloutRepo.updateRollout(activeRollout.id, {
      invocationsCount: newInvocations,
      failureCount: newFailures,
    });

    return null;
  }

  // -------------------------------------------------------------------------
  // 3. Rollout Health Evaluation & Progression
  // -------------------------------------------------------------------------

  /**
   * Evaluates active rollout metrics against its policy and triggers
   * progression (canary -> observing -> promoted), suspension, or rollback.
   */
  async evaluateRollout(
    rolloutId: string,
    options: {
      now?: string;
      deviceStatus?: { activeCount: number; offlineCount: number };
    } = {},
  ): Promise<RolloutDecision> {
    const rollout = await this.rolloutRepo.getRollout(rolloutId);
    if (!rollout) {
      throw new RolloutNotFoundError(rolloutId);
    }

    const now = options.now ?? new Date().toISOString();

    // If rollout is already in a terminal state, return maintain decision
    if (
      rollout.state === "promoted" ||
      rollout.state === "rolled_back" ||
      rollout.state === "failed" ||
      rollout.state === "retired" ||
      rollout.state === "superseded"
    ) {
      return {
        decisionId: randomUUID(),
        rolloutId: rollout.id,
        workspaceId: rollout.workspaceId,
        toolId: rollout.toolId,
        targetVersion: rollout.targetVersion,
        fromState: rollout.state,
        toState: rollout.state,
        action: "maintain",
        reason: `Rollout is in terminal state: ${rollout.state}`,
        confidence: 1.0,
        triggers: ["terminal_state"],
        evaluatedAt: now,
      };
    }

    // 1. Load Policy & User Overrides
    const policy =
      this.policyRegistry.getPolicy(rollout.policyId) ??
      this.policyRegistry.getPolicyForRiskTier(rollout.riskTier);

    const userOverride = await this.rolloutRepo.getOverride(
      rollout.workspaceId,
      rollout.toolId,
    );

    // 2. Compute Metrics Window
    const windowStart =
      (options as { windowStart?: string }).windowStart ??
      (rollout.startedAt
        ? new Date(new Date(rollout.startedAt).getTime() - 60000).toISOString()
        : new Date(Date.now() - 3600000).toISOString());
    const metrics = await this.rolloutRepo.calculateMetricsWindow(
      rollout.workspaceId,
      rollout.toolId,
      rollout.targetVersion,
      {
        windowStart,
        deviceStatus: options.deviceStatus,
      },
    );

    // 3. Run Evaluator Logic
    const decision = this.evaluator.evaluateCanaryMetrics({
      rollout,
      policy,
      metrics,
      userOverride,
      now,
    });

    // 4. Apply State Transitions Based on Decision
    const tenant: TenantContext = {
      accountId: rollout.accountId ?? "acc_default",
      workspaceId: rollout.workspaceId,
    };

    if (decision.action === "trigger_rollback") {
      return this.executeRollback(
        rollout,
        decision.reason,
        decision.triggers,
        metrics,
      );
    }

    if (decision.action === "promote") {
      await this.executePromotion(rollout, decision.reason, metrics);
    } else if (decision.action === "observe") {
      await this.rolloutRepo.updateRollout(rollout.id, {
        state: "observing",
        observingAt: rollout.observingAt ?? now,
        consecutiveCleanWindows: rollout.consecutiveCleanWindows + 1,
        metrics,
      });
      await this.emitOutboxEvent(tenant, {
        aggregateType: "rollout",
        aggregateId: rollout.id,
        eventType: "rollout.observing",
        payload: {
          rolloutId: rollout.id,
          toolId: rollout.toolId,
          version: rollout.targetVersion,
          consecutiveCleanWindows: rollout.consecutiveCleanWindows + 1,
        },
      });
    } else if (decision.action === "suspend") {
      await this.rolloutRepo.updateRollout(rollout.id, {
        state: "suspended",
        suspendedAt: now,
        failureReason: decision.reason,
        metrics,
      });

      const suspendCmd: DeploymentCommand = {
        commandId: randomUUID(),
        workspaceId: rollout.workspaceId,
        toolId: rollout.toolId,
        targetVersion: rollout.targetVersion,
        action: "suspend",
        canaryTrafficPercentage: 0,
        artifactDigest: rollout.artifactDigest,
        manifestDigest: rollout.manifestDigest,
        reason: decision.reason,
        issuedAt: now,
      };
      await this.issueDeploymentCommand(tenant, suspendCmd);

      await this.emitOutboxEvent(tenant, {
        aggregateType: "rollout",
        aggregateId: rollout.id,
        eventType: "rollout.suspended",
        payload: {
          rolloutId: rollout.id,
          toolId: rollout.toolId,
          version: rollout.targetVersion,
          reason: decision.reason,
          triggers: decision.triggers,
        },
      });
    } else {
      // Continue canary / maintain
      await this.rolloutRepo.updateRollout(rollout.id, {
        metrics,
      });
    }

    // Save decision lineage
    await this.rolloutRepo.saveDecision(decision);

    return decision;
  }

  // -------------------------------------------------------------------------
  // 4. Rollback Execution & Desired State Emission
  // -------------------------------------------------------------------------

  /**
   * Executes rollback of a rollout to the previous-known-good version,
   * sets the digest cooldown, records incidents, and emits deployment commands.
   */
  async executeRollback(
    rollout: RolloutEntity,
    reason: string,
    triggers: string[] = ["automated_rollback"],
    metrics?: CanaryMetricsWindow,
  ): Promise<RolloutDecision> {
    const now = new Date().toISOString();
    const policy =
      this.policyRegistry.getPolicy(rollout.policyId) ??
      this.policyRegistry.getPolicyForRiskTier(rollout.riskTier);

    const targetRollbackVersion = rollout.previousVersion ?? "1.0.0";
    const cooldownUntil = new Date(
      Date.now() + policy.cooldownDurationMs,
    ).toISOString();

    const tenant: TenantContext = {
      accountId: rollout.accountId ?? "acc_default",
      workspaceId: rollout.workspaceId,
    };

    // 1. Update Rollout State to rolled_back
    await this.rolloutRepo.updateRollout(rollout.id, {
      state: "rolled_back",
      rolledBackAt: now,
      cooldownUntil,
      failureReason: reason,
      canaryTrafficPercentage: 0,
      metrics: metrics ?? rollout.metrics,
    });

    // 2. Record Incident
    const severity = triggers.some((t) =>
      ["security_violation", "quarantine_signal", "capability_breach", "signature_tamper"].includes(t),
    )
      ? "critical"
      : "high";

    const incidentType = triggers.includes("security_violation")
      ? "security_violation"
      : triggers.includes("quarantine_signal")
        ? "quarantine_signal"
        : triggers.includes("capability_breach")
          ? "capability_breach"
          : triggers.includes("signature_tamper")
            ? "signature_tamper"
            : triggers.includes("latency_regression_exceeded")
              ? "latency_regression"
              : "error_spike";

    const incident: RolloutIncidentRecord = {
      id: randomUUID(),
      rolloutId: rollout.id,
      workspaceId: rollout.workspaceId,
      toolId: rollout.toolId,
      version: rollout.targetVersion,
      severity,
      incidentType,
      description: reason,
      evidence: {
        triggers,
        metrics,
        cooldownUntil,
        rolledBackAt: now,
      },
      triggeredRollback: true,
      createdAt: now,
    };
    await this.rolloutRepo.saveIncident(incident);

    // 3. Record Decision Lineage
    const decision: RolloutDecision = {
      decisionId: randomUUID(),
      rolloutId: rollout.id,
      workspaceId: rollout.workspaceId,
      toolId: rollout.toolId,
      targetVersion: rollout.targetVersion,
      fromState: rollout.state,
      toState: "rolled_back",
      action: "trigger_rollback",
      reason,
      confidence: 1.0,
      triggers,
      targetRollbackVersion,
      metrics,
      evaluatedAt: now,
    };
    await this.rolloutRepo.saveDecision(decision);

    // 4. Issue TE-036 Rollback Deployment Command
    const rollbackCmd: DeploymentCommand = {
      commandId: randomUUID(),
      workspaceId: rollout.workspaceId,
      toolId: rollout.toolId,
      targetVersion: rollout.targetVersion,
      action: "rollback",
      canaryTrafficPercentage: 0,
      artifactDigest: rollout.artifactDigest,
      manifestDigest: rollout.manifestDigest,
      rollbackToVersion: targetRollbackVersion,
      reason,
      issuedAt: now,
    };
    await this.issueDeploymentCommand(tenant, rollbackCmd);

    // 5. Invalidate MCP Catalog / Tool Registry Active Version
    if (this.toolRegistryRepo) {
      await this.toolRegistryRepo.setActiveVersion(
        tenant,
        rollout.toolId,
        targetRollbackVersion,
      );
    }
    if (this.catalogService) {
      await this.catalogService.invalidateWorkspaceCatalog(
        tenant,
        "emergency_revocation",
        [rollout.toolId],
      );
    }

    // 6. Emit Outbox Events
    await this.emitOutboxEvent(tenant, {
      aggregateType: "rollout",
      aggregateId: rollout.id,
      eventType: "rollout.rolled_back",
      payload: {
        rolloutId: rollout.id,
        toolId: rollout.toolId,
        failedVersion: rollout.targetVersion,
        restoredVersion: targetRollbackVersion,
        cooldownUntil,
        reason,
        triggers,
      },
    });

    return decision;
  }

  /**
   * Promotes a rollout candidate to 100% traffic and updates active versions.
   */
  private async executePromotion(
    rollout: RolloutEntity,
    reason: string,
    metrics?: CanaryMetricsWindow,
  ): Promise<void> {
    const now = new Date().toISOString();
    const tenant: TenantContext = {
      accountId: rollout.accountId ?? "acc_default",
      workspaceId: rollout.workspaceId,
    };

    // 1. Update Rollout State
    await this.rolloutRepo.updateRollout(rollout.id, {
      state: "promoted",
      promotedAt: now,
      canaryTrafficPercentage: 100,
      metrics: metrics ?? rollout.metrics,
    });

    // 2. Issue TE-036 Promotion Command
    const promoteCmd: DeploymentCommand = {
      commandId: randomUUID(),
      workspaceId: rollout.workspaceId,
      toolId: rollout.toolId,
      targetVersion: rollout.targetVersion,
      action: "promote",
      canaryTrafficPercentage: 100,
      artifactDigest: rollout.artifactDigest,
      manifestDigest: rollout.manifestDigest,
      reason,
      issuedAt: now,
    };
    await this.issueDeploymentCommand(tenant, promoteCmd);

    // 3. Update Tool Registry Active Version
    if (this.toolRegistryRepo) {
      await this.toolRegistryRepo.setActiveVersion(
        tenant,
        rollout.toolId,
        rollout.targetVersion,
      );
    }

    // 4. Invalidate MCP Catalog
    if (this.catalogService) {
      await this.catalogService.invalidateWorkspaceCatalog(
        tenant,
        "version_published",
        [rollout.toolId],
      );
    }

    // 5. Supersede older active rollouts for this tool
    const olderRollouts = await this.rolloutRepo.listRollouts(
      rollout.workspaceId,
      {
        toolId: rollout.toolId,
      },
    );
    for (const older of olderRollouts) {
      if (
        older.id !== rollout.id &&
        (older.state === "canary" ||
          older.state === "observing" ||
          older.state === "suspended")
      ) {
        await this.rolloutRepo.updateRollout(older.id, {
          state: "superseded",
        });
      }
    }

    // 6. Emit Outbox Event
    await this.emitOutboxEvent(tenant, {
      aggregateType: "rollout",
      aggregateId: rollout.id,
      eventType: "rollout.promoted",
      payload: {
        rolloutId: rollout.id,
        toolId: rollout.toolId,
        promotedVersion: rollout.targetVersion,
        promotedAt: now,
        reason,
      },
    });
  }

  // -------------------------------------------------------------------------
  // 5. Manual Controls & User Overrides
  // -------------------------------------------------------------------------

  /**
   * Triggers a manual rollback by operator/user.
   */
  async executeManualRollback(
    tenant: TenantContext,
    rolloutId: string,
    reason: string,
  ): Promise<RolloutDecision> {
    const rollout = await this.rolloutRepo.getRollout(rolloutId);
    if (!rollout) {
      throw new RolloutNotFoundError(rolloutId);
    }
    return this.executeRollback(rollout, `Manual operator rollback: ${reason}`, [
      "manual_rollback",
    ]);
  }

  /**
   * Triggers a manual promotion by operator/user.
   */
  async executeManualPromotion(
    tenant: TenantContext,
    rolloutId: string,
    reason: string,
  ): Promise<RolloutDecision> {
    const rollout = await this.rolloutRepo.getRollout(rolloutId);
    if (!rollout) {
      throw new RolloutNotFoundError(rolloutId);
    }

    const now = new Date().toISOString();
    await this.executePromotion(rollout, `Manual promotion: ${reason}`);

    const decision: RolloutDecision = {
      decisionId: randomUUID(),
      rolloutId: rollout.id,
      workspaceId: rollout.workspaceId,
      toolId: rollout.toolId,
      targetVersion: rollout.targetVersion,
      fromState: rollout.state,
      toState: "promoted",
      action: "promote",
      reason: `Manual operator promotion: ${reason}`,
      confidence: 1.0,
      triggers: ["manual_promotion"],
      evaluatedAt: now,
    };
    await this.rolloutRepo.saveDecision(decision);

    return decision;
  }

  /**
   * Set user override (pin or disable).
   */
  async setUserOverride(
    tenant: TenantContext,
    override: RolloutOverrideRecord,
  ): Promise<RolloutOverrideRecord> {
    const saved = await this.rolloutRepo.saveOverride(override);

    // If tool was disabled or pinned, suspend any active rollouts
    const active = await this.rolloutRepo.getActiveRolloutForTool(
      tenant.workspaceId,
      override.toolId,
    );
    if (active) {
      if (
        override.overrideType === "disabled" ||
        (override.overrideType === "pinned" &&
          override.pinnedVersion !== active.targetVersion)
      ) {
        await this.evaluateRollout(active.id);
      }
    }

    return saved;
  }

  async getUserOverride(
    tenant: TenantContext,
    toolId: string,
  ): Promise<RolloutOverrideRecord | null> {
    return this.rolloutRepo.getOverride(tenant.workspaceId, toolId);
  }

  async removeUserOverride(
    tenant: TenantContext,
    toolId: string,
  ): Promise<void> {
    await this.rolloutRepo.removeOverride(tenant.workspaceId, toolId);
  }

  // -------------------------------------------------------------------------
  // 6. Session Assignment Routing
  // -------------------------------------------------------------------------

  /**
   * Resolves the sticky version assignment for a session invocation.
   */
  async resolveSessionAssignment(
    context: AssignmentResolutionContext,
  ): Promise<RolloutSessionAssignment> {
    let activeRollout = context.activeRollout;
    if (activeRollout === undefined) {
      activeRollout = await this.rolloutRepo.getActiveRolloutForTool(
        context.workspaceId,
        context.toolId,
      );
    }

    let userOverride = context.userOverride;
    if (userOverride === undefined) {
      userOverride = await this.rolloutRepo.getOverride(
        context.workspaceId,
        context.toolId,
      );
    }

    return this.assignmentRouter.resolveAssignment({
      ...context,
      activeRollout,
      userOverride,
    });
  }

  // -------------------------------------------------------------------------
  // 7. Query Methods
  // -------------------------------------------------------------------------

  async getRollout(rolloutId: string): Promise<RolloutEntity | null> {
    return this.rolloutRepo.getRollout(rolloutId);
  }

  async getActiveRolloutForTool(
    workspaceId: string,
    toolId: string,
  ): Promise<RolloutEntity | null> {
    return this.rolloutRepo.getActiveRolloutForTool(workspaceId, toolId);
  }

  async listRollouts(
    workspaceId: string,
    filter?: RolloutFilter,
  ): Promise<RolloutEntity[]> {
    return this.rolloutRepo.listRollouts(workspaceId, filter);
  }

  async getDecisionLineage(rolloutId: string): Promise<RolloutDecision[]> {
    return this.rolloutRepo.getDecisions(rolloutId);
  }

  async getIncidents(
    workspaceId: string,
    filter?: { rolloutId?: string; toolId?: string },
  ): Promise<RolloutIncidentRecord[]> {
    return this.rolloutRepo.getIncidents(workspaceId, filter);
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  private async issueDeploymentCommand(
    tenant: TenantContext,
    command: DeploymentCommand,
  ): Promise<void> {
    await this.emitOutboxEvent(tenant, {
      aggregateType: "deployment_command",
      aggregateId: command.commandId,
      eventType: "deployment.command.issued",
      payload: command as unknown as Record<string, unknown>,
    });
  }

  private async emitOutboxEvent(
    tenant: TenantContext,
    event: {
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await OutboxRepository.insert(this.pool, {
        accountId: tenant.accountId ?? "acc_default",
        workspaceId: tenant.workspaceId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
      });

      if (this.outboxPublisher) {
        await this.outboxPublisher.dispatchBatch();
      }
    } catch {
      // Outbox insertion is best-effort in tests / environments without active outbox
    }
  }
}
