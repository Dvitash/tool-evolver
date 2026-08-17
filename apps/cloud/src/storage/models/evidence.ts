import { z } from "zod";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  Sha256DigestSchema,
} from "@tool-evolver/contracts";
import { NormalizedEventEntity } from "./events.js";

/**
 * Database entity schema for immutable EvidenceSets.
 */
export const EvidenceSetEntitySchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sessionId: IdentifierSchema.nullable().optional(),
  name: z.string().min(1),
  description: z.string().default(""),
  revision: z.number().int().positive().default(1),
  rootDigest: Sha256DigestSchema,
  memberCount: z.number().int().nonnegative().default(0),
  metadata: z.record(z.unknown()).default({}),
  createdAt: ISOTimestampSchema,
});

export type EvidenceSetEntity = z.infer<typeof EvidenceSetEntitySchema>;

/**
 * Database entity schema for individual EvidenceMember references.
 */
export const EvidenceMemberEntitySchema = z.object({
  id: IdentifierSchema,
  evidenceSetId: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  eventId: IdentifierSchema,
  eventDigest: Sha256DigestSchema,
  sequenceIndex: z.number().int().nonnegative(),
  createdAt: ISOTimestampSchema,
});

export type EvidenceMemberEntity = z.infer<typeof EvidenceMemberEntitySchema>;

/**
 * Resolved EvidenceSet snapshot with verified member events.
 */
export interface ResolvedEvidenceSet {
  evidenceSet: EvidenceSetEntity;
  members: EvidenceMemberEntity[];
  events: NormalizedEventEntity[];
  isDigestValid: boolean;
}

/**
 * Creation payload for an EvidenceSet snapshot.
 */
export interface CreateEvidenceSetInput {
  id?: string;
  accountId: string;
  workspaceId: string;
  sessionId?: string | null;
  name: string;
  description?: string;
  revision?: number;
  eventIds: string[];
  metadata?: Record<string, unknown>;
}
