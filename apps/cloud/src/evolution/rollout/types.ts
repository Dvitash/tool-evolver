import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  type SignatureMetadata,
  type ToolManifest,
} from "@tool-evolver/contracts";
import { z } from "zod";

/**
 * Rollout lifecycle states.
 */
export const RolloutStateSchema = z.enum([
  "pending",
  "canary",
  "observing",
  "promoted",
  "suspended",
  "rollback_pending",
  "rolled_back",
  "failed",
  "retired",
  "superseded",
]);

export type RolloutState =
  | "pending"
  | "canary"
  | "observing"
  | "promoted"
  | "suspended"
  | "rollback_pending"
  | "rolled_back"
  | "failed"
  | "retired"
  | "superseded";

/**
 * Risk tiers for rollout policy classification.
 */
export const RolloutRiskTierSchema = z.enum([
  "tier1_low",
  "tier2_medium",
  "tier3_high",
  "critical",
]);

export type RolloutRiskTier = "tier1_low" | "tier2_medium" | "tier3_high" | "critical";

/**
 * Latency tolerance thresholds for canary evaluation.
 */
export const LatencyTolerancesSchema = z.object({
  maxP95LatencyMs: z.number().positive(),
  maxP99LatencyMs: z.number().positive(),
  maxAllowedLatencyRegressionPercent: z.number().min(0),
});

export interface LatencyTolerances {
  maxP95LatencyMs: number;
  maxP99LatencyMs: number;
  maxAllowedLatencyRegressionPercent: number;
}

/**
 * Versioned rollout policy configuration.
 */
export const RolloutPolicySchema = z.object({
  policyId: z.string().min(1),
  version: z.number().int().positive().default(1),
  name: z.string().min(1),
  description: z.string().optional(),
  riskTier: RolloutRiskTierSchema,
  canaryExposureRatio: z.number().min(0).max(1),
  minInvocations: z.number().int().nonnegative(),
  maxFailures: z.number().int().nonnegative(),
  maxFailureRate: z.number().min(0).max(1),
  latencyTolerances: LatencyTolerancesSchema,
  confidenceThreshold: z.number().min(0).max(1),
  cooldownDurationMs: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
  minObservationDurationMs: z.number().int().nonnegative().default(0),
  requiredCleanWindows: z.number().int().positive().default(1),
  allowAutoPromotion: z.boolean().default(true),
  allowAutoRollback: z.boolean().default(true),
});

export interface RolloutPolicy {
  policyId: string;
  version: number;
  name: string;
  description?: string;
  riskTier: RolloutRiskTier;
  canaryExposureRatio: number;
  minInvocations: number;
  maxFailures: number;
  maxFailureRate: number;
  latencyTolerances: LatencyTolerances;
  confidenceThreshold: number;
  cooldownDurationMs: number;
  timeoutMs: number;
  minObservationDurationMs: number;
  requiredCleanWindows: number;
  allowAutoPromotion: boolean;
  allowAutoRollback: boolean;
}

/**
 * Aggregated canary telemetry and health metrics window.
 */
export const CanaryMetricsWindowSchema = z.object({
  windowStart: ISOTimestampSchema,
  windowEnd: ISOTimestampSchema,
  totalInvocations: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  errorRate: z.number().min(0).max(1),
  latenciesMs: z.array(z.number().nonnegative()).default([]),
  p50LatencyMs: z.number().nonnegative().default(0),
  p95LatencyMs: z.number().nonnegative().default(0),
  p99LatencyMs: z.number().nonnegative().default(0),
  baselineP95LatencyMs: z.number().nonnegative().optional(),
  latencyRegressionPercent: z.number().optional(),
  policyViolations: z.number().int().nonnegative().default(0),
  securityViolations: z.number().int().nonnegative().default(0),
  quarantineSignals: z.number().int().nonnegative().default(0),
  capabilityBreaches: z.number().int().nonnegative().default(0),
  schemaMismatches: z.number().int().nonnegative().default(0),
  signatureValid: z.boolean().default(true),
  activeDevicesCount: z.number().int().nonnegative().default(0),
  offlineDevicesCount: z.number().int().nonnegative().default(0),
  deviceReportingRate: z.number().min(0).max(1).default(1.0),
  quarantineReasons: z.array(z.string()).default([]),
  securityViolationDetails: z
    .array(
      z.object({
        type: z.string(),
        reason: z.string(),
        timestamp: z.string(),
      }),
    )
    .default([]),
});

export interface CanaryMetricsWindow {
  windowStart: string;
  windowEnd: string;
  totalInvocations: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  errorRate: number;
  latenciesMs: number[];
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  baselineP95LatencyMs?: number;
  latencyRegressionPercent?: number;
  policyViolations: number;
  securityViolations: number;
  quarantineSignals: number;
  capabilityBreaches: number;
  schemaMismatches: number;
  signatureValid: boolean;
  activeDevicesCount: number;
  offlineDevicesCount: number;
  deviceReportingRate: number;
  quarantineReasons: string[];
  securityViolationDetails: Array<{
    type: string;
    reason: string;
    timestamp: string;
  }>;
}

/**
 * Rollout decision actions.
 */
export const RolloutActionSchema = z.enum([
  "start_canary",
  "continue_canary",
  "observe",
  "promote",
  "suspend",
  "trigger_rollback",
  "complete_rollback",
  "fail",
  "retire",
  "supersede",
  "maintain",
]);

export type RolloutAction =
  | "start_canary"
  | "continue_canary"
  | "observe"
  | "promote"
  | "suspend"
  | "trigger_rollback"
  | "complete_rollback"
  | "fail"
  | "retire"
  | "supersede"
  | "maintain";

/**
 * Decision record capturing state transitions and rationale.
 */
export const RolloutDecisionSchema = z.object({
  decisionId: IdentifierSchema,
  rolloutId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  targetVersion: SchemaVersionSchema,
  fromState: RolloutStateSchema,
  toState: RolloutStateSchema,
  action: RolloutActionSchema,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  metrics: CanaryMetricsWindowSchema.optional(),
  triggers: z.array(z.string()).optional().default([]),
  targetRollbackVersion: SchemaVersionSchema.optional(),
  evaluatedAt: ISOTimestampSchema,
  metadata: z.record(z.unknown()).optional().default({}),
});

export interface RolloutDecision {
  decisionId: string;
  rolloutId: string;
  workspaceId: string;
  toolId: string;
  targetVersion: string;
  fromState: RolloutState;
  toState: RolloutState;
  action: RolloutAction;
  reason: string;
  confidence: number;
  metrics?: CanaryMetricsWindow;
  triggers?: string[];
  targetRollbackVersion?: string;
  evaluatedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Per-session sticky version assignment.
 */
export const RolloutSessionAssignmentSchema = z.object({
  id: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sessionId: z.string().min(1),
  toolId: IdentifierSchema,
  assignedVersion: SchemaVersionSchema,
  rolloutId: IdentifierSchema.optional(),
  isCanary: z.boolean().optional().default(false),
  isBreakingSchemaIsolated: z.boolean().optional().default(false),
  reason: z.enum([
    "sticky_session",
    "canary_bucket",
    "promoted_default",
    "user_pin_override",
    "user_disabled",
    "rollback_fallback",
    "breaking_schema_isolated",
    "default_baseline",
  ]),
  assignedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema.optional(),
});

export interface RolloutSessionAssignment {
  id: string;
  workspaceId: string;
  sessionId: string;
  toolId: string;
  assignedVersion: string;
  rolloutId?: string;
  isCanary?: boolean;
  isBreakingSchemaIsolated?: boolean;
  reason:
    | "sticky_session"
    | "canary_bucket"
    | "promoted_default"
    | "user_pin_override"
    | "user_disabled"
    | "rollback_fallback"
    | "breaking_schema_isolated"
    | "default_baseline";
  assignedAt: string;
  expiresAt?: string;
}

/**
 * Persistent rollout entity.
 */
export const RolloutEntitySchema = z.object({
  id: IdentifierSchema,
  workspaceId: IdentifierSchema,
  accountId: IdentifierSchema.optional(),
  toolId: IdentifierSchema,
  targetVersion: SchemaVersionSchema,
  previousVersion: SchemaVersionSchema.optional(),
  artifactDigest: Sha256DigestSchema,
  manifestDigest: Sha256DigestSchema,
  riskTier: RolloutRiskTierSchema,
  policyId: z.string().min(1),
  state: RolloutStateSchema,
  canaryTrafficPercentage: z.number().min(0).max(100).optional().default(10),
  targetDeviceIds: z.array(z.string()).optional().default([]),
  activeDeviceIds: z.array(z.string()).optional().default([]),
  invocationsCount: z.number().int().nonnegative().optional().default(0),
  failureCount: z.number().int().nonnegative().optional().default(0),
  consecutiveCleanWindows: z.number().int().nonnegative().optional().default(0),
  metrics: CanaryMetricsWindowSchema.nullable().optional().default(null),
  lastDecision: RolloutDecisionSchema.optional(),
  cooldownUntil: ISOTimestampSchema.optional(),
  pinnedVersionOverride: SchemaVersionSchema.optional(),
  isDisabled: z.boolean().optional().default(false),
  failureReason: z.string().optional(),
  startedAt: ISOTimestampSchema.optional(),
  observingAt: ISOTimestampSchema.optional(),
  promotedAt: ISOTimestampSchema.optional(),
  rolledBackAt: ISOTimestampSchema.optional(),
  suspendedAt: ISOTimestampSchema.optional(),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
});

export interface RolloutEntity {
  id: string;
  workspaceId: string;
  accountId?: string;
  toolId: string;
  targetVersion: string;
  previousVersion?: string;
  artifactDigest: string;
  manifestDigest: string;
  riskTier: RolloutRiskTier;
  policyId: string;
  state: RolloutState;
  canaryTrafficPercentage: number;
  targetDeviceIds?: string[];
  activeDeviceIds?: string[];
  invocationsCount: number;
  failureCount: number;
  consecutiveCleanWindows: number;
  metrics: CanaryMetricsWindow | null;
  lastDecision?: RolloutDecision;
  cooldownUntil?: string;
  pinnedVersionOverride?: string;
  isDisabled?: boolean;
  failureReason?: string;
  startedAt?: string;
  observingAt?: string;
  promotedAt?: string;
  rolledBackAt?: string;
  suspendedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Rollout incident record.
 */
export const RolloutIncidentRecordSchema = z.object({
  id: IdentifierSchema,
  rolloutId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  severity: z.enum(["critical", "high", "medium", "low"]),
  incidentType: z.enum([
    "security_violation",
    "quarantine_signal",
    "capability_breach",
    "error_spike",
    "latency_regression",
    "signature_tamper",
    "device_outage",
    "schema_mismatch",
  ]),
  description: z.string().min(1),
  evidence: z.record(z.unknown()).optional().default({}),
  triggeredRollback: z.boolean().optional().default(false),
  createdAt: ISOTimestampSchema,
});

export interface RolloutIncidentRecord {
  id: string;
  rolloutId: string;
  workspaceId: string;
  toolId: string;
  version: string;
  severity: "critical" | "high" | "medium" | "low";
  incidentType:
    | "security_violation"
    | "quarantine_signal"
    | "capability_breach"
    | "error_spike"
    | "latency_regression"
    | "signature_tamper"
    | "device_outage"
    | "schema_mismatch";
  description: string;
  evidence?: Record<string, unknown>;
  triggeredRollback?: boolean;
  createdAt: string;
}

/**
 * User configuration override for pins / disables.
 */
export const RolloutOverrideRecordSchema = z.object({
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  overrideType: z.enum(["pinned", "disabled", "canary_opt_out"]),
  pinnedVersion: SchemaVersionSchema.optional(),
  reason: z.string().min(1),
  createdBy: z.string().min(1).default("user"),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
});

export interface RolloutOverrideRecord {
  workspaceId: string;
  toolId: string;
  overrideType: "pinned" | "disabled" | "canary_opt_out";
  pinnedVersion?: string;
  reason: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Telemetry event from invocation execution.
 */
export const RolloutTelemetryEventSchema = z.object({
  id: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema,
  deviceId: z.string().optional(),
  sessionId: z.string().optional(),
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  artifactDigest: Sha256DigestSchema.optional(),
  manifestDigest: Sha256DigestSchema.optional(),
  success: z.boolean(),
  durationMs: z.number().nonnegative(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  securityViolation: z.boolean().default(false),
  securityViolationReason: z.string().optional(),
  quarantineSignal: z.boolean().default(false),
  quarantineReason: z.string().optional(),
  capabilityBreach: z.boolean().default(false),
  schemaMismatch: z.boolean().default(false),
  signatureValid: z.boolean().default(true),
  timestamp: ISOTimestampSchema,
});

export interface RolloutTelemetryEvent {
  id?: string;
  workspaceId: string;
  deviceId?: string;
  sessionId?: string;
  toolId: string;
  version: string;
  artifactDigest?: string;
  manifestDigest?: string;
  success: boolean;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  securityViolation?: boolean;
  securityViolationReason?: string;
  quarantineSignal?: boolean;
  quarantineReason?: string;
  capabilityBreach?: boolean;
  schemaMismatch?: boolean;
  signatureValid?: boolean;
  timestamp: string;
}

/**
 * Deployment command issued to devices / observer.
 */
export const DeploymentCommandSchema = z.object({
  commandId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  deviceId: z.string().optional(),
  toolId: IdentifierSchema,
  targetVersion: SchemaVersionSchema,
  action: z.enum(["install_canary", "activate", "promote", "suspend", "rollback", "deactivate"]),
  canaryTrafficPercentage: z.number().min(0).max(100),
  artifactDigest: Sha256DigestSchema,
  manifestDigest: Sha256DigestSchema,
  rollbackToVersion: SchemaVersionSchema.optional(),
  reason: z.string().min(1),
  issuedAt: ISOTimestampSchema,
});

export interface DeploymentCommand {
  commandId: string;
  workspaceId: string;
  deviceId?: string;
  toolId: string;
  targetVersion: string;
  action: "install_canary" | "activate" | "promote" | "suspend" | "rollback" | "deactivate";
  canaryTrafficPercentage: number;
  artifactDigest: string;
  manifestDigest: string;
  rollbackToVersion?: string;
  reason: string;
  issuedAt: string;
}

/**
 * Filter for querying rollouts.
 */
export interface RolloutFilter {
  toolId?: string;
  state?: RolloutState | RolloutState[];
  targetVersion?: string;
  artifactDigest?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Rollout Error Hierarchy
// ---------------------------------------------------------------------------

export class RolloutError extends Error {
  readonly code: string;

  constructor(message: string, code = "ROLLOUT_ERROR") {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class RolloutNotFoundError extends RolloutError {
  constructor(rolloutId: string) {
    super(`Rollout not found: ${rolloutId}`, "ROLLOUT_NOT_FOUND");
  }
}

export class RolloutStateTransitionError extends RolloutError {
  constructor(fromState: string, toState: string, reason?: string) {
    super(
      `Invalid rollout state transition from ${fromState} to ${toState}${reason ? `: ${reason}` : ""}`,
      "INVALID_ROLLOUT_TRANSITION",
    );
  }
}

export class RolloutCooldownActiveError extends RolloutError {
  readonly cooldownUntil: string;
  readonly artifactDigest: string;

  constructor(artifactDigest: string, cooldownUntil: string, reason?: string) {
    super(
      `Artifact digest ${artifactDigest} is in cooldown until ${cooldownUntil}${reason ? ` (${reason})` : ""}`,
      "ROLLOUT_COOLDOWN_ACTIVE",
    );
    this.cooldownUntil = cooldownUntil;
    this.artifactDigest = artifactDigest;
  }
}

export class RolloutToolDisabledError extends RolloutError {
  constructor(toolId: string, workspaceId: string) {
    super(
      `Tool ${toolId} is disabled by user override in workspace ${workspaceId}`,
      "TOOL_DISABLED_BY_OVERRIDE",
    );
  }
}

export class RolloutPinnedVersionConflictError extends RolloutError {
  readonly pinnedVersion: string;

  constructor(toolId: string, pinnedVersion: string, attemptedVersion: string) {
    super(
      `Cannot rollout version ${attemptedVersion} for tool ${toolId} because it is pinned to ${pinnedVersion}`,
      "TOOL_PINNED_VERSION_CONFLICT",
    );
    this.pinnedVersion = pinnedVersion;
  }
}

export class RolloutEvaluationError extends RolloutError {
  constructor(message: string) {
    super(message, "ROLLOUT_EVALUATION_ERROR");
  }
}

/**
 * Evidence verification bundle for rollout validation.
 */
export interface EvidenceVerificationBundle {
  candidateId?: string;
  toolId: string;
  version: string;
  artifactDigest: string;
  manifestDigest: string;
  manifest: ToolManifest;
  signature?: SignatureMetadata | null;
  evaluatedAt?: string;
  replaySuccessRate?: number;
  validationPassed?: boolean;
  hardGatesPassed?: boolean;
  evidenceFreshnessTimestamp?: string;
}

/**
 * Result of verifying candidate evidence bundle during rollout.
 */
export interface EvidenceVerificationResult {
  valid: boolean;
  reasons: string[];
  verifiedAt: string;
  signatureValid: boolean;
  digestsMatch: boolean;
  freshnessValid: boolean;
  hardGatesValid: boolean;
}
