import {
  type EvaluationResult,
  type EvolutionCandidate,
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  type ToolManifest,
  type ToolVersion,
} from "@tool-evolver/contracts";
import { z } from "zod";
import type { CandidateRevision } from "../generator/types.js";
import type { HistoricalReplayResult } from "../replay/types.js";
import type { CandidateValidationResult } from "../testing/types.js";

/**
 * Sequential states in the evolution candidate lifecycle.
 */
export const CandidateLifecycleStateSchema = z.enum([
  "drafted",
  "validating",
  "replaying",
  "evaluating",
  "eligible",
  "published",
  "rejected",
  "failed",
  "superseded",
]);

export type CandidateLifecycleState = z.infer<typeof CandidateLifecycleStateSchema>;

/**
 * Categorization of terminal lifecycle failures.
 */
export type TerminalReasonCategory =
  | "validation_failed"
  | "replay_divergence"
  | "hard_gate_failed"
  | "stale_evidence"
  | "scope_mismatch"
  | "signing_failed"
  | "unauthorized"
  | "infrastructure_error";

/**
 * Structured terminal failure reason.
 */
export interface TerminalReason {
  code: string;
  message: string;
  category?: TerminalReasonCategory;
  details?: Record<string, unknown>;
}

/**
 * Canonical evidence digests collected across lifecycle stages.
 */
export interface EvidenceDigests {
  manifestDigest?: string;
  sourceDigest?: string;
  schemaDigest?: string;
  validationDigest?: string;
  replayDigest?: string;
  evaluationDigest?: string;
  artifactDigest?: string;
  signatureDigest?: string;
}

/**
 * Single step execution attempt log entry.
 */
export interface AttemptHistoryEntry {
  attempt: number;
  state: CandidateLifecycleState;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "in_progress" | "succeeded" | "failed";
  error?: string;
}

/**
 * Mutable/persisted entity representing the live lifecycle stage of a candidate.
 */
export interface CandidateLifecycleRecord {
  id: string;
  accountId: string;
  workspaceId: string;
  candidateId: string;
  activeRevisionId: string;
  currentState: CandidateLifecycleState;
  targetVersion: string;
  idempotencyKey: string;
  attempt: number;
  evidenceDigests: EvidenceDigests;
  terminalReason?: TerminalReason | null;
  validationResult?: CandidateValidationResult | null;
  replayResult?: HistoricalReplayResult | null;
  evaluationResult?: EvaluationResult | null;
  publicationRecordId?: string | null;
  publishedVersion?: string | null;
  attemptHistory: AttemptHistoryEntry[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Immutable audit transition record.
 */
export interface LifecycleTransitionRecord {
  id: string;
  accountId: string;
  workspaceId: string;
  candidateId: string;
  revisionId: string;
  fromState: CandidateLifecycleState;
  toState: CandidateLifecycleState;
  idempotencyKey: string;
  attempt: number;
  evidenceDigests: EvidenceDigests;
  terminalReason?: TerminalReason | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Public/Sanitized candidate lifecycle status response for API consumers.
 * Redacts raw transcripts, source code not covered by consent, and internal secrets.
 */
export interface CandidateLifecycleStatusResponse {
  candidateId: string;
  workspaceId: string;
  toolName: string;
  toolVersion: string;
  currentState: CandidateLifecycleState;
  activeRevisionId: string;
  isTerminal: boolean;
  isEligible: boolean;
  isPublished: boolean;
  publishedVersion?: string | null;
  publicationRecordId?: string | null;
  terminalReason?: TerminalReason | null;
  evidenceSummary: {
    validationPassed?: boolean;
    typecheckPassed?: boolean;
    staticFindingsCount?: number;
    testsPassed?: boolean;
    replayPassed?: boolean;
    replaySuccessRate?: number;
    evaluationVerdict?: string;
    hardGatesPassed?: boolean;
    evidenceFreshnessVerified?: boolean;
    hasSignature?: boolean;
  };
  evidenceDigests: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  history: Array<{
    fromState: CandidateLifecycleState;
    toState: CandidateLifecycleState;
    timestamp: string;
    attempt: number;
  }>;
}

/**
 * Standard Job types used by Outbox and DurableQueue for lifecycle steps.
 */
export const EVOLUTION_LIFECYCLE_JOB_TYPES = {
  VALIDATE_CANDIDATE: "evolution.candidate.validate",
  REPLAY_CANDIDATE: "evolution.candidate.replay",
  EVALUATE_CANDIDATE: "evolution.candidate.evaluate",
  PUBLISH_CANDIDATE: "evolution.candidate.publish",
} as const;

/**
 * Payload schema for lifecycle step jobs.
 */
export interface LifecycleJobPayload {
  candidateId: string;
  revisionId: string;
  targetVersion: string;
  step: "validate" | "replay" | "evaluate" | "publish";
  idempotencyKey: string;
  attempt: number;
  scheduledAt: string;
}
