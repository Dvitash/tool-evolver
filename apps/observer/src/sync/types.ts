import {
  type CapabilityEnvelope,
  CapabilityEnvelopeSchema,
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  type DeploymentRecord,
  DeploymentRecordSchema,
  type DeploymentState,
  DeploymentStateSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  type InstallationRecord,
  InstallationRecordSchema,
  type SafetyAttestationRecord,
  SafetyAttestationRecordSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  ToolVersionSchema,
} from "@tool-evolver/contracts";
import { z } from "zod";

/**
 * Supported deployment command types.
 */
export const DeploymentCommandTypeSchema = z.enum([
  "deploy",
  "activate",
  "canary",
  "rollback",
  "suspend",
  "resume",
  "retire",
]);

export type DeploymentCommandType = z.infer<typeof DeploymentCommandTypeSchema>;

/**
 * Wire/Stream message for a deployment control command.
 */
export const DeploymentCommandMessageSchema = z.object({
  commandId: IdentifierSchema,
  commandType: DeploymentCommandTypeSchema,
  deploymentId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  workspaceId: IdentifierSchema.optional(),
  targetDigest: Sha256DigestSchema.optional(),
  canaryWeight: z.number().int().min(0).max(100).optional(),
  rollbackToVersion: SchemaVersionSchema.optional(),
  rollbackToSnapshotId: IdentifierSchema.optional(),
  reason: z.string().optional(),
  timestamp: ISOTimestampSchema,
  bundleUrl: z.string().optional(),
  artifactUri: z.string().optional(),
  manifest: ToolManifestSchema.optional(),
  signature: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type DeploymentCommandMessage = z.infer<typeof DeploymentCommandMessageSchema>;

/**
 * Local deployment lifecycle states.
 */
export const LocalDeploymentStateSchema = z.enum([
  "staged",
  "activating",
  "active",
  "canary",
  "suspended",
  "rolling_back",
  "rolled_back",
  "retired",
  "rejected",
  "broken",
  "failed",
]);

export type LocalDeploymentState = z.infer<typeof LocalDeploymentStateSchema>;

/**
 * Status report of deployment synchronization sent back to cloud control stream.
 */
export const DeploymentSyncStatusReportSchema = z.object({
  reportId: IdentifierSchema,
  commandId: IdentifierSchema.optional(),
  deploymentId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  workspaceId: IdentifierSchema,
  status: LocalDeploymentStateSchema,
  previousStatus: LocalDeploymentStateSchema.optional(),
  activeTrafficPercentage: z.number().min(0).max(100).default(0),
  appliedAt: ISOTimestampSchema,
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
  details: z.record(z.unknown()).default({}),
  catalogRevision: z.number().int().nonnegative().optional(),
  catalogDigest: Sha256DigestSchema.optional(),
});

export type DeploymentSyncStatusReport = z.infer<typeof DeploymentSyncStatusReportSchema>;

/**
 * Tool override record for local user pin/disable controls.
 */
export const ToolOverrideRecordSchema = z.object({
  overrideId: IdentifierSchema.optional(),
  toolId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  action: z.enum(["disable", "pin", "allow", "custom"]),
  pinnedVersion: SchemaVersionSchema.optional(),
  isEnabled: z.boolean().default(true),
  createdAt: ISOTimestampSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type ToolOverrideRecord = z.infer<typeof ToolOverrideRecordSchema>;

/**
 * User controls interface for pin/disable management.
 */
export interface UserControls {
  workspaceId: string;
  pinnedVersions: Record<string, string>;
  disabledTools: string[];
  frozenTools?: string[];
  rollbacks?: Array<{
    targetRevision: number | string;
    timestamp: string;
    restoredSnapshotId?: string;
    toolId?: string;
  }>;
}

/**
 * Types of actions taken during sync reconciliation.
 */
export const SyncReconciliationActionTypeSchema = z.enum([
  "activated",
  "suspended",
  "resumed",
  "rolled_back",
  "downloaded",
  "staged",
  "rejected",
  "skipped",
  "uninstalled",
  "retired",
]);

export type SyncReconciliationActionType = z.infer<typeof SyncReconciliationActionTypeSchema>;

/**
 * Single reconciliation action result.
 */
export const SyncReconciliationActionSchema = z.object({
  toolId: IdentifierSchema,
  deploymentId: IdentifierSchema.optional(),
  version: SchemaVersionSchema.optional(),
  action: SyncReconciliationActionTypeSchema,
  reason: z.string(),
  status: z.enum(["success", "failure", "skipped"]),
  error: z.string().optional(),
});

export type SyncReconciliationAction = z.infer<typeof SyncReconciliationActionSchema>;

/**
 * Result summary of a desired vs actual state reconciliation run.
 */
export const SyncReconciliationResultSchema = z.object({
  workspaceId: IdentifierSchema,
  reconciledAt: ISOTimestampSchema,
  actions: z.array(SyncReconciliationActionSchema).default([]),
  activeTools: z.record(SchemaVersionSchema).default({}),
  suspendedTools: z.array(IdentifierSchema).default([]),
  rolledBackTools: z.array(IdentifierSchema).default([]),
  pendingActionsCount: z.number().int().nonnegative().default(0),
  appliedActionsCount: z.number().int().nonnegative().default(0),
  errorCount: z.number().int().nonnegative().default(0),
  errors: z
    .array(
      z.object({
        toolId: IdentifierSchema.optional(),
        error: z.string(),
      }),
    )
    .default([]),
});

export type SyncReconciliationResult = z.infer<typeof SyncReconciliationResultSchema>;

/**
 * Catalog change notification event payload (TE-018 compatible).
 */
export interface CatalogChangeEvent {
  workspaceId: string;
  sessionId?: string;
  revision: number;
  snapshot: CatalogSnapshot;
  changedToolIds: string[];
  timestamp: string;
}

/**
 * Preactivation violation detail.
 */
export interface PreactivationViolation {
  code: string;
  subsystem:
    | "fs"
    | "net"
    | "command"
    | "secrets"
    | "limits"
    | "override"
    | "runtime"
    | "security"
    | "manifest";
  message: string;
  field?: string;
  requestedValue?: unknown;
}

/**
 * Preactivation inspection and constraint check result.
 */
export interface PreactivationCheckResult {
  eligible: boolean;
  violations: PreactivationViolation[];
  warnings: string[];
  metadata: Record<string, unknown>;
}

/**
 * Inspection file entry within a downloaded artifact.
 */
export interface ArtifactFileEntry {
  path: string;
  sizeBytes: number;
  digest: string;
}

/**
 * Non-executing loader inspection result for a downloaded artifact.
 */
export interface ArtifactInspectionResult {
  manifest: ToolManifest;
  bundleDigest: string;
  files: ArtifactFileEntry[];
  rawSignature?: Record<string, unknown>;
  signature?: {
    keyId: string;
    algorithm: string;
    valid: boolean;
    trustLevel: string;
    error?: string;
  };
  attestation?: SafetyAttestationRecord;
  rawAttestation?: Record<string, unknown>;
}

/**
 * Key store entry for trust chain verification.
 */
export interface SigningKeyEntry {
  keyId: string;
  algorithm: "ed25519" | "ecdsa-p256" | "ecdsa-p384" | "rsa-pss" | "rsa-sha256";
  publicKeyPem: string;
  trustLevel: "production" | "development" | "revoked";
  description?: string;
  expiresAt?: string;
  createdAt: string;
}

/**
 * Key store interface for artifact signature verification.
 */
export interface SigningKeyStore {
  getKey(keyId: string): Promise<SigningKeyEntry | null>;
  hasKey(keyId: string): Promise<boolean>;
  isTrusted(keyId: string, allowDevKeys?: boolean): Promise<boolean>;
  addKey(entry: SigningKeyEntry): Promise<void>;
  revokeKey(keyId: string): Promise<void>;
}
