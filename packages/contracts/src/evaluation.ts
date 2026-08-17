import { z } from "zod";
import { ISOTimestampSchema, IdentifierSchema, SchemaVersionSchema } from "./common.js";

/**
 * Dimensions evaluated during candidate verification.
 */
export const EvaluationDimensionNameSchema = z.enum([
  "test",
  "replay",
  "security",
  "quality",
  "latency",
  "reliability",
  "token_savings",
]);

export type EvaluationDimensionName = z.infer<typeof EvaluationDimensionNameSchema>;

/**
 * Score and assessment for an individual evaluation dimension.
 */
export const EvaluationDimensionSchema = z.object({
  name: EvaluationDimensionNameSchema,
  weight: z.number().min(0).max(1).default(1),
  score: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  passed: z.boolean(),
  metrics: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
  details: z.string().optional(),
});

export type EvaluationDimension = z.infer<typeof EvaluationDimensionSchema>;

/**
 * Final verdict of the evaluation pipeline.
 */
export const EvaluationVerdictSchema = z.enum(["pass", "fail", "conditional"]);
export type EvaluationVerdict = z.infer<typeof EvaluationVerdictSchema>;

/**
 * High-level decision synthesizing all dimension scores.
 */
export const EvaluationDecisionSchema = z.object({
  verdict: EvaluationVerdictSchema,
  score: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  notes: z.string().optional(),
  evaluatedBy: z.string().min(1),
  evaluatedAt: ISOTimestampSchema,
});

export type EvaluationDecision = z.infer<typeof EvaluationDecisionSchema>;

/**
 * Complete Evaluation Result contract.
 */
export const EvaluationResultSchema = z.object({
  evaluationId: IdentifierSchema,
  candidateId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  overallDecision: EvaluationDecisionSchema,
  dimensions: z.array(EvaluationDimensionSchema),
  replayTestCount: z.number().int().nonnegative().default(0),
  replaySuccessCount: z.number().int().nonnegative().default(0),
  securityChecklist: z.record(z.boolean()).default({}),
  completedAt: ISOTimestampSchema,
  durationMs: z.number().nonnegative(),
});

export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
