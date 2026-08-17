import { z } from "zod";
import { CapabilityManifestSchema } from "./capabilities.js";
import { ISOTimestampSchema, IdentifierSchema, SchemaVersionSchema } from "./common.js";
import { ToolManifestSchema } from "./tools.js";

/**
 * State of an evolution candidate during synthesis and evaluation lifecycle.
 */
export const CandidateStateSchema = z.enum([
  "detected",
  "synthesizing",
  "synthesized",
  "evaluating",
  "evaluated",
  "approved",
  "rejected",
  "superseded",
  "failed",
]);

export type CandidateState = z.infer<typeof CandidateStateSchema>;

/**
 * Trigger reason and evidence that prompted synthesis of a candidate tool.
 */
export const CandidateTriggerReasonSchema = z.enum([
  "repeated_pattern",
  "latency_bottleneck",
  "failure_recovery",
  "missing_abstraction",
  "manual_request",
]);

export type CandidateTriggerReason = z.infer<typeof CandidateTriggerReasonSchema>;

export const CandidateTriggerSchema = z.object({
  reason: CandidateTriggerReasonSchema,
  evidenceEventIds: z.array(IdentifierSchema).min(1),
  sessionOccurrences: z.number().int().positive().default(1),
  detectedAt: ISOTimestampSchema,
  patternFrequency: z.number().nonnegative().default(1),
  estimatedLatencySavingsMs: z.number().nonnegative().optional(),
  estimatedTokenSavings: z.number().nonnegative().optional(),
});

export type CandidateTrigger = z.infer<typeof CandidateTriggerSchema>;

/**
 * High-level evaluation summary for a candidate.
 */
export const CandidateEvaluationSummarySchema = z.object({
  benchmarkScore: z.number().min(0).max(1),
  replaySuccessRate: z.number().min(0).max(1),
  latencyImprovementPercent: z.number(),
  tokenSavingsPercent: z.number(),
  securityVerdict: z.enum(["passed", "failed", "requires_review"]),
  evaluatorVersion: SchemaVersionSchema,
  evaluatedAt: ISOTimestampSchema,
});

export type CandidateEvaluationSummary = z.infer<typeof CandidateEvaluationSummarySchema>;

/**
 * Evolution Candidate contract representing a synthesized tool proposal.
 */
export const EvolutionCandidateSchema = z.object({
  id: IdentifierSchema,
  workspaceId: IdentifierSchema,
  state: CandidateStateSchema,
  trigger: CandidateTriggerSchema,
  proposedTool: ToolManifestSchema,
  requiredCapabilities: CapabilityManifestSchema,
  evaluationSummary: CandidateEvaluationSummarySchema.optional(),
  sourceCode: z.string().optional(),
  rejectionReason: z.string().optional(),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional(),
});

export type EvolutionCandidate = z.infer<typeof EvolutionCandidateSchema>;
