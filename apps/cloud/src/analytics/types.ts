import {
  ISOTimestampSchema,
  IdentifierSchema,
  type InvocationRecord,
  SchemaVersionSchema,
} from "@tool-evolver/contracts";
import type {
  TelemetryBatchRequest,
  TelemetryBatchResponse,
  TelemetryMetric,
} from "@tool-evolver/protocol";
import { z } from "zod";
import type { CanaryMetricsWindow } from "../evolution/rollout/types.js";

/**
 * 1. Telemetry Bucket Record
 * Represents an aggregated slice of privacy-safe metrics across a discrete time window.
 */
export const TelemetryBucketRecordSchema = z.object({
  bucketId: IdentifierSchema,
  accountId: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  metricName: z.string().min(1),
  windowStart: ISOTimestampSchema,
  windowEnd: ISOTimestampSchema,
  count: z.number().int().nonnegative(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
  p50: z.number().nonnegative(),
  p95: z.number().nonnegative(),
  p99: z.number().nonnegative(),
  dimensions: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  errorCount: z.number().int().nonnegative().default(0),
  successCount: z.number().int().nonnegative().default(0),
  quarantineCount: z.number().int().nonnegative().default(0),
  securityViolationCount: z.number().int().nonnegative().default(0),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
});

export type TelemetryBucketRecord = z.infer<typeof TelemetryBucketRecordSchema>;

/**
 * 2. Rollout Metric Window Record
 * Represents a computed observation window used for TE-037 Autonomous Canary evaluation.
 */
export const SecurityViolationDetailSchema = z.object({
  type: z.string(),
  reason: z.string(),
  timestamp: ISOTimestampSchema,
});

export type SecurityViolationDetail = z.infer<typeof SecurityViolationDetailSchema>;

export const RolloutMetricWindowRecordSchema = z.object({
  windowId: IdentifierSchema,
  accountId: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  windowStart: ISOTimestampSchema,
  windowEnd: ISOTimestampSchema,
  totalInvocations: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  errorRate: z.number().min(0).max(1),
  latenciesMs: z.array(z.number().nonnegative()).default([]),
  p50LatencyMs: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
  p99LatencyMs: z.number().nonnegative(),
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
  deviceReportingRate: z.number().min(0).max(1).default(1),
  quarantineReasons: z.array(z.string()).default([]),
  securityViolationDetails: z.array(SecurityViolationDetailSchema).default([]),
  confidence: z.number().min(0).max(1).default(0),
  materializedAt: ISOTimestampSchema,
});

export type RolloutMetricWindowRecord = z.infer<typeof RolloutMetricWindowRecordSchema>;

/**
 * 3. Efficiency Metric Record
 * Distinguishes directly measured savings from counterfactual uncertainty bounds.
 */
export const MeasuredSavingsSchema = z.object({
  durationMsSaved: z.number(),
  tokensSaved: z.number(),
  stepsAvoided: z.number(),
  estimatedCostSavedUsd: z.number(),
});

export type MeasuredSavings = z.infer<typeof MeasuredSavingsSchema>;

export const CounterfactualSavingsSchema = z.object({
  durationMsSavedEstimate: z.number(),
  tokensSavedEstimate: z.number(),
  stepsAvoidedEstimate: z.number(),
  lowerBoundUsd: z.number(),
  upperBoundUsd: z.number(),
  confidenceLevel: z.number().min(0).max(1),
  standardErrorUsd: z.number().nonnegative(),
});

export type CounterfactualSavings = z.infer<typeof CounterfactualSavingsSchema>;

export const EfficiencyMetricRecordSchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  baselineVersion: SchemaVersionSchema.optional(),
  windowStart: ISOTimestampSchema,
  windowEnd: ISOTimestampSchema,
  invocationCount: z.number().int().nonnegative(),
  measuredSavings: MeasuredSavingsSchema,
  counterfactualSavings: CounterfactualSavingsSchema,
  netSavingsScore: z.number().min(0).max(100),
  calculatedAt: ISOTimestampSchema,
});

export type EfficiencyMetricRecord = z.infer<typeof EfficiencyMetricRecordSchema>;

/**
 * 4. Calibration Record
 * Joins predeployment evaluation predictions with canary/production outcomes.
 */
export const DecisionOutcomeSchema = z.enum([
  "concordant",
  "optimistic_false_positive",
  "pessimistic_false_negative",
  "divergent",
]);

export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export const CalibrationRecordSchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  candidateId: IdentifierSchema,
  evaluationId: IdentifierSchema,
  predictedSuccessRate: z.number().min(0).max(1),
  actualSuccessRate: z.number().min(0).max(1),
  predictedP95LatencyMs: z.number().nonnegative(),
  actualP95LatencyMs: z.number().nonnegative(),
  predictedTokenSavings: z.number().default(0),
  actualTokenSavings: z.number().default(0),
  predictionError: z.object({
    successRateDelta: z.number(),
    latencyDeltaMs: z.number(),
    tokenSavingsDelta: z.number(),
    brierScore: z.number().nonnegative().optional(),
  }),
  sampleSize: z.number().int().nonnegative(),
  decisionOutcome: DecisionOutcomeSchema,
  calibratedAt: ISOTimestampSchema,
});

export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;

/**
 * 5. Anomaly Alert Record
 * Detects impossible sequences, counter resets, cardinality explosion, and lifecycle violations.
 */
export const AnomalyTypeSchema = z.enum([
  "invocation_before_activation",
  "counter_reset",
  "cardinality_explosion",
  "impossible_timestamp",
  "revoked_tool_invocation",
  "invalid_transition_telemetry",
  "rate_spike",
  "unauthorized_dimension",
]);

export type AnomalyType = z.infer<typeof AnomalyTypeSchema>;

export const AnomalySeveritySchema = z.enum(["info", "warning", "critical"]);
export type AnomalySeverity = z.infer<typeof AnomalySeveritySchema>;

export const AnomalyAlertRecordSchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  anomalyType: AnomalyTypeSchema,
  severity: AnomalySeveritySchema.default("warning"),
  description: z.string().min(1),
  evidence: z.record(z.unknown()).default({}),
  resolved: z.boolean().default(false),
  detectedAt: ISOTimestampSchema,
  resolvedAt: ISOTimestampSchema.optional(),
});

export type AnomalyAlertRecord = z.infer<typeof AnomalyAlertRecordSchema>;

/**
 * Ingestion receipt entity.
 */
export interface TelemetryReceiptEntity {
  id: string;
  batchId: string;
  workspaceId: string;
  accountId?: string;
  deviceId?: string;
  installationId?: string;
  contentHash: string;
  acceptedCount: number;
  duplicateCount: number;
  status: "accepted" | "partial" | "rejected";
  createdAt: string;
}

/**
 * Query filters
 */
export interface BucketQueryFilter {
  accountId?: string;
  workspaceId: string;
  toolId?: string;
  version?: string;
  metricName?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface RolloutWindowQueryFilter {
  accountId?: string;
  workspaceId: string;
  toolId?: string;
  version?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface EfficiencyQueryFilter {
  accountId?: string;
  workspaceId: string;
  toolId?: string;
  version?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface CalibrationQueryFilter {
  accountId?: string;
  workspaceId: string;
  toolId?: string;
  version?: string;
  candidateId?: string;
  evaluationId?: string;
  decisionOutcome?: DecisionOutcome;
  limit?: number;
}

export interface AnomalyQueryFilter {
  accountId?: string;
  workspaceId: string;
  toolId?: string;
  version?: string;
  anomalyType?: AnomalyType;
  severity?: AnomalySeverity;
  resolved?: boolean;
  limit?: number;
}

/**
 * Materialization parameters
 */
export interface MaterializeRolloutWindowParams {
  workspaceId: string;
  accountId?: string;
  toolId: string;
  version: string;
  windowStart: string;
  windowEnd?: string;
  baselineP95LatencyMs?: number;
  baselineVersion?: string;
  expectedActiveDevices?: number;
}

/**
 * Efficiency calculation parameters
 */
export interface CalculateEfficiencyParams {
  workspaceId: string;
  accountId?: string;
  toolId: string;
  version: string;
  baselineVersion?: string;
  windowStart: string;
  windowEnd?: string;
  baselineP95LatencyMs?: number;
  baselineTokensPerInvocation?: number;
  baselineStepsPerInvocation?: number;
  costPer1kTokensUsd?: number;
  developerHourlyRateUsd?: number;
}

/**
 * Calibration parameters
 */
export interface CalibrateEvaluationParams {
  workspaceId: string;
  accountId?: string;
  toolId: string;
  version: string;
  candidateId: string;
  evaluationId: string;
  predictedSuccessRate: number;
  predictedP95LatencyMs: number;
  predictedTokenSavings?: number;
  windowStart?: string;
  windowEnd?: string;
}

export type {
  InvocationRecord,
  TelemetryMetric,
  TelemetryBatchRequest,
  TelemetryBatchResponse,
  CanaryMetricsWindow,
};
