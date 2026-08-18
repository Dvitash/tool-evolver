-- Tool Evolver Cloud Service Platform - Candidate Lifecycle & Transition Persistence Schema
-- Migration: 008_candidate_lifecycle.sql

-- 1. Candidate Lifecycle States Table (Atomic, idempotent lifecycle stage tracking)
CREATE TABLE IF NOT EXISTS candidate_lifecycle_states (
  id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id VARCHAR(64) NOT NULL,
  active_revision_id VARCHAR(64) NOT NULL,
  current_state VARCHAR(32) NOT NULL DEFAULT 'drafted',
  target_version VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  attempt INT NOT NULL DEFAULT 1,
  evidence_digests JSONB NOT NULL DEFAULT '{}'::jsonb,
  terminal_reason JSONB,
  validation_result JSONB,
  replay_result JSONB,
  evaluation_result JSONB,
  publication_record_id VARCHAR(64),
  published_version VARCHAR(64),
  attempt_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, candidate_id),
  CONSTRAINT uq_candidate_lifecycle_idempotency UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_candidate_lifecycle_tenant ON candidate_lifecycle_states(account_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_candidate_lifecycle_state ON candidate_lifecycle_states(workspace_id, current_state);
CREATE INDEX IF NOT EXISTS idx_candidate_lifecycle_cand ON candidate_lifecycle_states(workspace_id, candidate_id);

-- 2. Candidate Lifecycle Transitions Table (Immutable audit log of all transitions)
CREATE TABLE IF NOT EXISTS candidate_lifecycle_transitions (
  id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id VARCHAR(64) NOT NULL,
  revision_id VARCHAR(64) NOT NULL,
  from_state VARCHAR(32) NOT NULL,
  to_state VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  attempt INT NOT NULL DEFAULT 1,
  evidence_digests JSONB NOT NULL DEFAULT '{}'::jsonb,
  terminal_reason JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT uq_lifecycle_transitions_idempotency UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_cand ON candidate_lifecycle_transitions(workspace_id, candidate_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_created_at ON candidate_lifecycle_transitions(workspace_id, created_at);

-- 3. Candidate Lifecycle Dead Letter Queue (DLQ) Table
CREATE TABLE IF NOT EXISTS candidate_lifecycle_dlq (
  id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id VARCHAR(64) NOT NULL,
  revision_id VARCHAR(64) NOT NULL,
  stage VARCHAR(32) NOT NULL,
  error_category VARCHAR(64) NOT NULL,
  error_message TEXT NOT NULL,
  retry_classification VARCHAR(32) NOT NULL,
  attempt_count INT NOT NULL DEFAULT 1,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  resumed BOOLEAN NOT NULL DEFAULT FALSE,
  resumed_at TIMESTAMPTZ,
  resumed_by VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_dlq_cand ON candidate_lifecycle_dlq(workspace_id, candidate_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_dlq_status ON candidate_lifecycle_dlq(workspace_id, resumed);
CREATE INDEX IF NOT EXISTS idx_lifecycle_dlq_created_at ON candidate_lifecycle_dlq(workspace_id, created_at);
