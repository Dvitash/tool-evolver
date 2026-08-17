-- Tool Evolver Cloud Service Platform - Autonomous Canary & Rollout Schema
-- Migration: 004_rollouts.sql

-- 1. Rollouts (Canary, Observation, Promotion, and Rollback lifecycles)
CREATE TABLE IF NOT EXISTS rollouts (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  target_version VARCHAR(64) NOT NULL,
  previous_version VARCHAR(64),
  artifact_digest VARCHAR(64) NOT NULL,
  manifest_digest VARCHAR(64) NOT NULL,
  risk_tier VARCHAR(32) NOT NULL DEFAULT 'tier1_low',
  policy_id VARCHAR(64) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'pending',
  canary_traffic_percentage INT NOT NULL DEFAULT 10,
  target_device_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  active_device_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  invocations_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  consecutive_clean_windows INT NOT NULL DEFAULT 0,
  metrics JSONB,
  cooldown_until TIMESTAMPTZ,
  pinned_version_override VARCHAR(64),
  is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  failure_reason TEXT,
  started_at TIMESTAMPTZ,
  observing_at TIMESTAMPTZ,
  promoted_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rollouts_workspace_tool ON rollouts(workspace_id, tool_id, state);
CREATE INDEX IF NOT EXISTS idx_rollouts_digest ON rollouts(workspace_id, artifact_digest);

-- 2. Rollout Decisions (Auditable decision lineage)
CREATE TABLE IF NOT EXISTS rollout_decisions (
  id VARCHAR(64) PRIMARY KEY,
  rollout_id VARCHAR(64) NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  target_version VARCHAR(64) NOT NULL,
  from_state VARCHAR(32) NOT NULL,
  to_state VARCHAR(32) NOT NULL,
  action VARCHAR(32) NOT NULL,
  reason TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rollout_decisions_rollout ON rollout_decisions(rollout_id, evaluated_at);

-- 3. Rollout Session Assignments (Per-session sticky version router records)
CREATE TABLE IF NOT EXISTS rollout_session_assignments (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id VARCHAR(64) NOT NULL,
  tool_id VARCHAR(64) NOT NULL,
  assigned_version VARCHAR(64) NOT NULL,
  rollout_id VARCHAR(64),
  is_canary BOOLEAN NOT NULL DEFAULT FALSE,
  is_breaking_schema_isolated BOOLEAN NOT NULL DEFAULT FALSE,
  reason VARCHAR(64) NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_assignments_unique ON rollout_session_assignments(workspace_id, session_id, tool_id);
CREATE INDEX IF NOT EXISTS idx_session_assignments_tool ON rollout_session_assignments(workspace_id, tool_id);

-- 4. Rollout Incidents (Quarantine, Security, Capability breaches & Error spikes)
CREATE TABLE IF NOT EXISTS rollout_incidents (
  id VARCHAR(64) PRIMARY KEY,
  rollout_id VARCHAR(64) NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  severity VARCHAR(32) NOT NULL,
  incident_type VARCHAR(64) NOT NULL,
  description TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggered_rollback BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rollout_incidents_rollout ON rollout_incidents(rollout_id);
CREATE INDEX IF NOT EXISTS idx_rollout_incidents_tool ON rollout_incidents(workspace_id, tool_id);

-- 5. Rollout Overrides (User pin/disable configuration)
CREATE TABLE IF NOT EXISTS rollout_overrides (
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  override_type VARCHAR(32) NOT NULL,
  pinned_version VARCHAR(64),
  reason TEXT NOT NULL,
  created_by VARCHAR(64) NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, tool_id)
);

-- 6. Rollout Telemetry Events (Live execution metrics & health observations)
CREATE TABLE IF NOT EXISTS rollout_telemetry_events (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  device_id VARCHAR(64),
  session_id VARCHAR(64),
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  artifact_digest VARCHAR(64),
  success BOOLEAN NOT NULL,
  duration_ms INT NOT NULL,
  error_code VARCHAR(64),
  error_message TEXT,
  security_violation BOOLEAN NOT NULL DEFAULT FALSE,
  security_violation_reason TEXT,
  quarantine_signal BOOLEAN NOT NULL DEFAULT FALSE,
  quarantine_reason TEXT,
  capability_breach BOOLEAN NOT NULL DEFAULT FALSE,
  schema_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  signature_valid BOOLEAN NOT NULL DEFAULT TRUE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_events ON rollout_telemetry_events(workspace_id, tool_id, version, timestamp);
