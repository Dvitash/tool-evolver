export {
  AnomalyAlertRecordSchema,
  AnomalySeveritySchema,
  AnomalyTypeSchema,
  CalibrationRecordSchema,
  CounterfactualSavingsSchema,
  DecisionOutcomeSchema,
  EfficiencyMetricRecordSchema,
  MeasuredSavingsSchema,
  RolloutMetricWindowRecordSchema,
  SecurityViolationDetailSchema,
  TelemetryBucketRecordSchema,
  type AnomalyAlertRecord,
  type AnomalyQueryFilter,
  type AnomalySeverity,
  type AnomalyType,
  type BucketQueryFilter,
  type CalculateEfficiencyParams,
  type CalibrateEvaluationParams,
  type CalibrationQueryFilter,
  type CalibrationRecord,
  type CanaryMetricsWindow,
  type CounterfactualSavings,
  type DecisionOutcome,
  type EfficiencyMetricRecord,
  type EfficiencyQueryFilter,
  type MaterializeRolloutWindowParams,
  type MeasuredSavings,
  type RolloutMetricWindowRecord,
  type RolloutWindowQueryFilter,
  type SecurityViolationDetail,
  type TelemetryBatchRequest,
  type TelemetryBatchResponse,
  type TelemetryBucketRecord,
  type TelemetryMetric,
  type TelemetryReceiptEntity,
} from "./types.js";

export {
  ALLOWED_TAG_KEYS,
  SchemaGuard,
  SchemaGuardValidationError,
} from "./schema-guard.js";

export {
  TelemetryBatchConflictError,
  TelemetryDeduplicator,
  type TelemetryDeduplicationResult,
} from "./deduplicator.js";

export {
  MetricsRepository,
  createMetricsRepository,
  type IMetricsRepository,
} from "./repositories/metrics-repository.js";

export { RolloutWindowMaterializer } from "./materializer.js";

export { EfficiencyCalculator } from "./efficiency.js";

export { EvaluationCalibrator } from "./calibration.js";

export { AnomalyDetector } from "./anomaly.js";

export {
  AnalyticsService,
  AnalyticsTenantMismatchError,
  createAnalyticsService,
  type AnalyticsServiceOptions,
} from "./service.js";

export { handleTelemetryBatchRoute } from "./routes.js";
