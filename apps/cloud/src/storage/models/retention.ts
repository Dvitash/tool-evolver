import { ISOTimestampSchema, IdentifierSchema } from "@tool-evolver/contracts";
import { z } from "zod";

/**
 * Target types that can be held under retention policies.
 */
export const RetentionHoldTargetTypeSchema = z.enum([
  "session",
  "evidence_set",
  "candidate",
  "evaluation",
  "deployment",
  "account",
  "workspace",
]);

export type RetentionHoldTargetType = z.infer<typeof RetentionHoldTargetTypeSchema>;

/**
 * Hold classification type.
 */
export const RetentionHoldTypeSchema = z.enum([
  "legal",
  "candidate",
  "evaluation",
  "deployment",
  "manual",
]);

export type RetentionHoldType = z.infer<typeof RetentionHoldTypeSchema>;

/**
 * Database entity schema for retention holds.
 */
export const RetentionHoldEntitySchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  targetType: RetentionHoldTargetTypeSchema,
  targetId: z.string().min(1),
  holdType: RetentionHoldTypeSchema,
  reason: z.string().min(1),
  expiresAt: ISOTimestampSchema.nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
});

export type RetentionHoldEntity = z.infer<typeof RetentionHoldEntitySchema>;

/**
 * Retention policy configuration.
 */
export interface RetentionPolicy {
  eventRetentionDays?: number;
  sessionRetentionDays?: number;
  unheldOnly?: boolean;
}

/**
 * Export job status.
 */
export const ExportJobStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);

export type ExportJobStatus = z.infer<typeof ExportJobStatusSchema>;

/**
 * Export scope.
 */
export const ExportScopeSchema = z.enum(["account", "workspace", "session"]);

export type ExportScope = z.infer<typeof ExportScopeSchema>;

/**
 * Database entity schema for export jobs.
 */
export const ExportJobEntitySchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  requestedBy: z.string().min(1).default("system"),
  scope: ExportScopeSchema,
  targetId: z.string().min(1),
  status: ExportJobStatusSchema.default("pending"),
  format: z.enum(["json", "zip", "ndjson"]).default("json"),
  exportPath: z.string().nullable().optional(),
  manifest: z.record(z.unknown()).default({}),
  error: z.string().nullable().optional(),
  recordCount: z.number().int().nonnegative().default(0),
  createdAt: ISOTimestampSchema,
  completedAt: ISOTimestampSchema.nullable().optional(),
});

export type ExportJobEntity = z.infer<typeof ExportJobEntitySchema>;

/**
 * Deletion job status.
 */
export const DeletionJobStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);

export type DeletionJobStatus = z.infer<typeof DeletionJobStatusSchema>;

/**
 * Deletion scope.
 */
export const DeletionScopeSchema = z.enum(["account", "workspace", "session"]);

export type DeletionScope = z.infer<typeof DeletionScopeSchema>;

/**
 * Database entity schema for deletion jobs.
 */
export const DeletionJobEntitySchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  requestedBy: z.string().min(1).default("system"),
  scope: DeletionScopeSchema,
  targetId: z.string().min(1),
  status: DeletionJobStatusSchema.default("pending"),
  deletedRecordsCount: z.number().int().nonnegative().default(0),
  summary: z.record(z.unknown()).default({}),
  error: z.string().nullable().optional(),
  createdAt: ISOTimestampSchema,
  completedAt: ISOTimestampSchema.nullable().optional(),
});

export type DeletionJobEntity = z.infer<typeof DeletionJobEntitySchema>;
