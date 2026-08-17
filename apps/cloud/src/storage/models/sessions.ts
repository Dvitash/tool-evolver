import { z } from "zod";
import {
  ISOTimestampSchema,
  IdentifierSchema,
} from "@tool-evolver/contracts";

/**
 * Session status enum schema.
 */
export const SessionStatusSchema = z.enum([
  "active",
  "idle",
  "completed",
  "failed",
  "archived",
  "terminated",
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Session fidelity level.
 */
export const SessionFidelitySchema = z.enum([
  "full",
  "compact",
  "summary",
  "lossless",
]);

export type SessionFidelity = z.infer<typeof SessionFidelitySchema>;

/**
 * Database entity schema for sessions.
 */
export const SessionEntitySchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  harnessType: z.string().min(1).default("default"),
  status: SessionStatusSchema.default("active"),
  fidelity: SessionFidelitySchema.default("full"),
  startedAt: ISOTimestampSchema,
  endedAt: ISOTimestampSchema.nullable().optional(),
  cursor: z.string().nullable().optional(),
  eventCount: z.number().int().nonnegative().default(0),
  summaryByKind: z.record(z.number().int().nonnegative()).default({}),
  metadata: z.record(z.unknown()).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
});

export type SessionEntity = z.infer<typeof SessionEntitySchema>;

/**
 * Database entity schema for session branches.
 */
export const SessionBranchEntitySchema = z.object({
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  name: z.string().min(1),
  parentBranchId: IdentifierSchema.nullable().optional(),
  forkEventId: IdentifierSchema.nullable().optional(),
  headEventId: IdentifierSchema.nullable().optional(),
  eventCount: z.number().int().nonnegative().default(0),
  metadata: z.record(z.unknown()).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
});

export type SessionBranchEntity = z.infer<typeof SessionBranchEntitySchema>;

/**
 * Query filter for sessions.
 */
export interface SessionQueryFilter {
  accountId: string;
  workspaceId: string;
  status?: SessionStatus;
  harnessType?: string;
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  offset?: number;
  sortOrder?: "ASC" | "DESC";
}

/**
 * Session summary snapshot.
 */
export interface SessionSummary {
  sessionId: string;
  accountId: string;
  workspaceId: string;
  status: SessionStatus;
  fidelity: SessionFidelity;
  startedAt: string;
  endedAt?: string | null;
  cursor?: string | null;
  eventCount: number;
  summaryByKind: Record<string, number>;
  branchCount: number;
}
