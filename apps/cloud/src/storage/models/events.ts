import {
  CausalRefSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  RedactionMetaSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
} from "@tool-evolver/contracts";
import { z } from "zod";

/**
 * Database entity schema for normalized events stored in the cloud.
 */
export const NormalizedEventEntitySchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sessionId: IdentifierSchema,
  branchId: z.string().min(1).default("main"),
  eventType: z.string().min(1),
  schemaVersion: SchemaVersionSchema,
  timestamp: ISOTimestampSchema,
  causalSequence: z.number().int().nonnegative(),
  parentId: IdentifierSchema.nullable().optional(),
  rootId: IdentifierSchema.nullable().optional(),
  turnIndex: z.number().int().nonnegative().optional().nullable(),
  stepIndex: z.number().int().nonnegative().optional().nullable(),
  traceId: z.string().optional().nullable(),
  spanId: z.string().optional().nullable(),
  payload: z.record(z.unknown()),
  redaction: RedactionMetaSchema.optional().nullable(),
  contentHash: Sha256DigestSchema,
  createdAt: ISOTimestampSchema,
});

export type NormalizedEventEntity = z.infer<typeof NormalizedEventEntitySchema>;

/**
 * Filter options for querying normalized events.
 */
export interface EventQueryFilter {
  accountId: string;
  workspaceId: string;
  sessionId?: string;
  branchId?: string;
  eventTypes?: string[];
  eventKind?: string;
  timeRange?: {
    start?: string;
    end?: string;
  };
  causalSequenceRange?: {
    min?: number;
    max?: number;
  };
  parentId?: string | null;
  rootId?: string | null;
  turnIndex?: number;
  stepIndex?: number;
  traceId?: string;
  limit?: number;
  offset?: number;
  afterSequence?: number;
  afterTimestamp?: string;
  sortOrder?: "ASC" | "DESC";
}

/**
 * Paginated result of normalized events.
 */
export interface PaginatedEventsResult {
  events: NormalizedEventEntity[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: string | null;
}
