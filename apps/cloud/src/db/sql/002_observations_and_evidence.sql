-- Tool Evolver Cloud Service Platform - Observations, Sessions & Evidence Schema
-- Migration: 002_observations_and_evidence.sql

-- 1. Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  harness_type VARCHAR(64) NOT NULL DEFAULT 'default',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  fidelity VARCHAR(32) NOT NULL DEFAULT 'full',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  cursor VARCHAR(255),
  event_count INT NOT NULL DEFAULT 0,
  summary_by_kind JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(account_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(account_id, workspace_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(account_id, workspace_id, status);

-- 2. Session Branches
CREATE TABLE IF NOT EXISTS session_branches (
  id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  parent_branch_id VARCHAR(64),
  fork_event_id VARCHAR(64),
  head_event_id VARCHAR(64),
  event_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_branches_session ON session_branches(session_id);
CREATE INDEX IF NOT EXISTS idx_session_branches_tenant ON session_branches(account_id, workspace_id);

-- 3. Normalized Events
CREATE TABLE IF NOT EXISTS normalized_events (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) NOT NULL DEFAULT 'main',
  event_type VARCHAR(64) NOT NULL,
  schema_version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  timestamp TIMESTAMPTZ NOT NULL,
  causal_sequence BIGINT NOT NULL DEFAULT 0,
  parent_id VARCHAR(64),
  root_id VARCHAR(64),
  turn_index INT,
  step_index INT,
  trace_id VARCHAR(128),
  span_id VARCHAR(128),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction JSONB,
  content_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_normalized_events_tenant_session ON normalized_events(account_id, workspace_id, session_id);
CREATE INDEX IF NOT EXISTS idx_normalized_events_sequence ON normalized_events(session_id, causal_sequence);
CREATE INDEX IF NOT EXISTS idx_normalized_events_timestamp ON normalized_events(account_id, workspace_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_normalized_events_type ON normalized_events(account_id, workspace_id, event_type);
CREATE INDEX IF NOT EXISTS idx_normalized_events_parent ON normalized_events(session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_normalized_events_hash ON normalized_events(content_hash);

-- 4. Evidence Sets
CREATE TABLE IF NOT EXISTS evidence_sets (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  revision INT NOT NULL DEFAULT 1,
  root_digest VARCHAR(64) NOT NULL,
  member_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evidence_sets_tenant ON evidence_sets(account_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_evidence_sets_session ON evidence_sets(session_id);
CREATE INDEX IF NOT EXISTS idx_evidence_sets_digest ON evidence_sets(root_digest);

-- 5. Evidence Members
CREATE TABLE IF NOT EXISTS evidence_members (
  id VARCHAR(64) PRIMARY KEY,
  evidence_set_id VARCHAR(64) NOT NULL REFERENCES evidence_sets(id) ON DELETE CASCADE,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id VARCHAR(64) NOT NULL REFERENCES normalized_events(id) ON DELETE CASCADE,
  event_digest VARCHAR(64) NOT NULL,
  sequence_index INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evidence_members_set ON evidence_members(evidence_set_id, sequence_index);
CREATE INDEX IF NOT EXISTS idx_evidence_members_event ON evidence_members(event_id);
CREATE INDEX IF NOT EXISTS idx_evidence_members_tenant ON evidence_members(account_id, workspace_id);

-- 6. Retention Holds
CREATE TABLE IF NOT EXISTS retention_holds (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  hold_type VARCHAR(64) NOT NULL DEFAULT 'manual',
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_retention_holds_target ON retention_holds(account_id, workspace_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_retention_holds_expires ON retention_holds(expires_at);

-- 7. Export Jobs
CREATE TABLE IF NOT EXISTS export_jobs (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by VARCHAR(255) NOT NULL DEFAULT 'system',
  scope VARCHAR(64) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  format VARCHAR(32) NOT NULL DEFAULT 'json',
  export_path TEXT,
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  record_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant ON export_jobs(account_id, workspace_id, status);

-- 8. Deletion Jobs
CREATE TABLE IF NOT EXISTS deletion_jobs (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by VARCHAR(255) NOT NULL DEFAULT 'system',
  scope VARCHAR(64) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  deleted_records_count INT NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deletion_jobs_tenant ON deletion_jobs(account_id, workspace_id, status);
