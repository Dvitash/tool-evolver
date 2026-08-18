import {
  type CapabilityEnvelope,
  type CapabilityManifest,
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
  "repairing",
  "published",
  "rejected",
  "failed",
  "blocked",
  "quarantined",
  "dead_letter",
  "superseded",
]);

export type CandidateLifecycleState = z.infer<typeof CandidateLifecycleStateSchema>;

/**
 * Stages in the evolution candidate pipeline execution.
 */
export type LifecycleStage = "draft" | "validate" | "replay" | "evaluate" | "repair" | "publish";

/**
 * Categorization of terminal lifecycle failures.
 */
export type TerminalFailureCategory =
  | "validation_failed"
  | "replay_divergence"
  | "evaluation_rejected"
  | "safety_gate_violation"
  | "verification_failed"
  | "stale_evidence"
  | "capability_broadened"
  | "quota_exceeded"
  | "signing_revoked"
  | "attempts_exhausted"
  | "malformed_output"
  | "dlq_terminal"
  | "infrastructure_exhausted"
  | "unclassified";

/**
 * Terminal failure reason details.
 */
export interface TerminalReason {
  code: string;
  message: string;
  category: TerminalFailureCategory;
  details?: Record<string, unknown>;
}

/**
 * Canonical evidence digests collected across lifecycle stages.
 */
export interface EvidenceDigests {
  manifestDigest?: string;
  sourceDigest?: string;
  testDigest?: string;
  workflowDigest?: string;
  capabilityDigest?: string;
  validationDigest?: string;
  replayDigest?: string;
  evaluationDigest?: string;
  artifactDigest?: string;
  signatureDigest?: string;
}

/**
 * History of attempts for a lifecycle stage.
 */
export interface AttemptHistoryEntry {
  attempt: number;
  state: CandidateLifecycleState;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "succeeded" | "failed" | "diverged" | "retrying";
  error?: string;
  diagnostics?: Record<string, unknown>;
}

/**
 * Complete persisted candidate lifecycle record.
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
 * Error categories for explicit lifecycle retry classification.
 */
export type ErrorCategory =
  | "provider_outage"
  | "rate_limit"
  | "malformed_output"
  | "queue_delay"
  | "database_restart"
  | "object_store_failure"
  | "signing_failure"
  | "worker_crash"
  | "validation_failure"
  | "replay_divergence"
  | "evaluation_hard_gate"
  | "capability_violation"
  | "attempts_exhausted"
  | "unknown_error";

/**
 * Retry classification type.
 */
export type RetryClassificationType = "transient" | "terminal" | "repairable";

/**
 * Retry policy defining budgets and backoff.
 */
export interface RetryPolicy {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
}

/**
 * Outcome of classifying an error.
 */
export interface RetryClassificationResult {
  category: ErrorCategory;
  classification: RetryClassificationType;
  retryable: boolean;
  maxRetries: number;
  backoffMs: number;
  reason: string;
}

/**
 * Tenant-scoped Dead Letter Queue (DLQ) entry for terminal or quarantined lifecycle jobs.
 */
export interface CandidateLifecycleDlqRecord {
  id: string;
  accountId: string;
  workspaceId: string;
  candidateId: string;
  revisionId: string;
  stage: LifecycleStage;
  errorCategory: ErrorCategory;
  errorMessage: string;
  retryClassification: RetryClassificationType;
  attemptCount: number;
  diagnostics: Record<string, unknown>;
  resumed: boolean;
  resumedAt?: string | null;
  resumedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Filter options for listing DLQ records.
 */
export interface DlqFilter {
  candidateId?: string;
  stage?: LifecycleStage;
  errorCategory?: ErrorCategory;
  resumed?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Options for resuming a candidate from DLQ.
 */
export interface ResumeFromDlqOptions {
  resumedBy?: string;
  targetStage?: LifecycleStage;
  overridePayload?: Record<string, unknown>;
  forceReplay?: boolean;
}

/**
 * Options for bounded candidate repair.
 */
export interface RepairCandidateOptions {
  maxRepairAttempts?: number;
  envelope?: CapabilityEnvelope;
  repairHint?: string;
  modifiedArtifacts?: {
    sourceCode?: string;
    manifest?: ToolManifest;
    capabilities?: CapabilityManifest;
    workflowDefinition?: Record<string, unknown>;
  };
}

/**
 * Event payload emitted when lifecycle transitions occur.
 */
export interface CandidateLifecycleEventPayload {
  candidateId: string;
  workspaceId: string;
  toolName: string;
  toolVersion: string;
  fromState: CandidateLifecycleState;
  toState: CandidateLifecycleState;
  attempt: number;
  evidenceDigests: EvidenceDigests;
  terminalReason?: TerminalReason | null;
  timestamp: string;
}

/**
 * Async queue job payload for candidate lifecycle transitions.
 */
export interface LifecycleJobPayload {
  candidateId: string;
  revisionId: string;
  targetVersion: string;
  step: "validate" | "replay" | "evaluate" | "publish" | "repair";
  idempotencyKey: string;
  attempt: number;
  scheduledAt: string;
}

/**
 * Outbox / Queue job event types for candidate lifecycle progression.
 */
export const EVOLUTION_LIFECYCLE_JOB_TYPES = {
  VALIDATE_CANDIDATE: "evolution.candidate.validate",
  REPLAY_CANDIDATE: "evolution.candidate.replay",
  EVALUATE_CANDIDATE: "evolution.candidate.evaluate",
  PUBLISH_CANDIDATE: "evolution.candidate.publish",
  REPAIR_CANDIDATE: "evolution.candidate.repair",
} as const;

/**
 * Sanitized public status response of a candidate lifecycle.
 */
export interface CandidateLifecycleStatusResponse {
  candidateId: string;
  workspaceId: string;
  toolName?: string;
  toolVersion?: string;
  currentState: CandidateLifecycleState;
  activeRevisionId: string;
  isTerminal?: boolean;
  isEligible?: boolean;
  isPublished?: boolean;
  publishedVersion?: string | null;
  publicationRecordId?: string | null;
  attempt?: number;
  terminalReason?: TerminalReason | null;
  evidenceSummary: {
    validationPassed?: boolean;
    typecheckPassed?: boolean;
    staticFindingsCount?: number;
    replayPassed?: boolean;
    evaluationVerdict?: string;
    hardGatesPassed?: boolean;
    evidenceFreshnessVerified?: boolean;
    hasSignature?: boolean;
  };
  evidenceDigests: Record<string, string> | EvidenceDigests;
  attemptHistory?: AttemptHistoryEntry[];
  history: Array<{
    fromState: CandidateLifecycleState;
    toState: CandidateLifecycleState;
    timestamp: string;
    attempt: number;
  }>;
}
