-- Tool Evolver Cloud Service Platform - Lifecycle Metrics & Feedback Analytics Schema
-- Migration: 005_analytics_and_metrics.sql

-- 1. Telemetry Ingestion Receipts (Idempotent deduplication tracking)
CREATE TABLE IF NOT EXISTS telemetry_receipts (
  id VARCHAR(64) PRIMARY KEY,
  batch_id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id VARCHAR(64) REFERENCES accounts(id) ON DELETE CASCADE,
  device_id VARCHAR(64),
  installation_id VARCHAR(64),
  content_hash VARCHAR(64) NOT NULL,
  accepted_count INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_receipts_workspace_batch ON telemetry_receipts(workspace_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_receipts_tenant ON telemetry_receipts(account_id, workspace_id);

-- 2. Telemetry Aggregation Buckets (Privacy-safe metric time slices)
CREATE TABLE IF NOT EXISTS telemetry_buckets (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  metric_name VARCHAR(128) NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0,
  sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  min DOUBLE PRECISION NOT NULL DEFAULT 0,
  max DOUBLE PRECISION NOT NULL DEFAULT 0,
  p50 DOUBLE PRECISION NOT NULL DEFAULT 0,
  p95 DOUBLE PRECISION NOT NULL DEFAULT 0,
  p99 DOUBLE PRECISION NOT NULL DEFAULT 0,
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  quarantine_count INT NOT NULL DEFAULT 0,
  security_violation_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_buckets_query ON telemetry_buckets(workspace_id, tool_id, version, metric_name, window_start);
CREATE INDEX IF NOT EXISTS idx_telemetry_buckets_tenant ON telemetry_buckets(account_id, workspace_id);

-- 3. Rollout Metric Windows (Computed deterministic observation windows for TE-037)
CREATE TABLE IF NOT EXISTS rollout_metric_windows (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  total_invocations INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  success_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  error_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  latencies_ms JSONB NOT NULL DEFAULT '[]'::jsonb,
  p50_latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  p95_latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  p99_latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  baseline_p95_latency_ms DOUBLE PRECISION,
  latency_regression_percent DOUBLE PRECISION,
  policy_violations INT NOT NULL DEFAULT 0,
  security_violations INT NOT NULL DEFAULT 0,
  quarantine_signals INT NOT NULL DEFAULT 0,
  capability_breaches INT NOT NULL DEFAULT 0,
  schema_mismatches INT NOT NULL DEFAULT 0,
  signature_valid BOOLEAN NOT NULL DEFAULT TRUE,
  active_devices_count INT NOT NULL DEFAULT 0,
  offline_devices_count INT NOT NULL DEFAULT 0,
  device_reporting_rate DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  quarantine_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  security_violation_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rollout_metric_windows_query ON rollout_metric_windows(workspace_id, tool_id, version, window_start);
CREATE INDEX IF NOT EXISTS idx_rollout_metric_windows_tenant ON rollout_metric_windows(account_id, workspace_id);

-- 4. Efficiency Metrics (Measured vs counterfactual productivity impact)
CREATE TABLE IF NOT EXISTS efficiency_metrics (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  baseline_version VARCHAR(64),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  invocation_count INT NOT NULL DEFAULT 0,
  measured_savings JSONB NOT NULL DEFAULT '{}'::jsonb,
  counterfactual_savings JSONB NOT NULL DEFAULT '{}'::jsonb,
  net_savings_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_efficiency_metrics_query ON efficiency_metrics(workspace_id, tool_id, version, calculated_at);
CREATE INDEX IF NOT EXISTS idx_efficiency_metrics_tenant ON efficiency_metrics(account_id, workspace_id);

-- 5. Evaluation Calibrations (Predictions vs canary/production actuals)
CREATE TABLE IF NOT EXISTS evaluation_calibrations (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  evaluation_id VARCHAR(64) NOT NULL,
  predicted_success_rate DOUBLE PRECISION NOT NULL,
  actual_success_rate DOUBLE PRECISION NOT NULL,
  predicted_p95_latency_ms DOUBLE PRECISION NOT NULL,
  actual_p95_latency_ms DOUBLE PRECISION NOT NULL,
  predicted_token_savings DOUBLE PRECISION NOT NULL DEFAULT 0,
  actual_token_savings DOUBLE PRECISION NOT NULL DEFAULT 0,
  prediction_error JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_size INT NOT NULL DEFAULT 0,
  decision_outcome VARCHAR(64) NOT NULL,
  calibrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eval_calibrations_query ON evaluation_calibrations(workspace_id, tool_id, version, calibrated_at);
CREATE INDEX IF NOT EXISTS idx_eval_calibrations_tenant ON evaluation_calibrations(account_id, workspace_id);

-- 6. Anomaly Alerts (Lifecycle and sequence violations)
CREATE TABLE IF NOT EXISTS anomaly_alerts (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  anomaly_type VARCHAR(64) NOT NULL,
  severity VARCHAR(32) NOT NULL DEFAULT 'warning',
  description TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_query ON anomaly_alerts(workspace_id, tool_id, version, detected_at);
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_tenant ON anomaly_alerts(account_id, workspace_id);
