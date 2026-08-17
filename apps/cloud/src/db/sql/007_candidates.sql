-- Tool Evolver Cloud Service Platform - Candidate & Revision Persistence Schema
-- Migration: 007_candidates.sql

-- 1. Evolution Candidates Table (Deterministic, immutable candidate records with tenant isolation)
CREATE TABLE IF NOT EXISTS evolution_candidates (
  id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id VARCHAR(64) NOT NULL,
  structural_hash VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'synthesized',
  proposed_tool_name VARCHAR(255) NOT NULL,
  proposed_tool_version VARCHAR(64) NOT NULL,
  manifest JSONB NOT NULL,
  manifest_digest VARCHAR(64) NOT NULL,
  required_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  trigger_reason VARCHAR(64) NOT NULL,
  evidence_event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_revision_id VARCHAR(64),
  source_code TEXT,
  evaluation_summary JSONB,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT uq_evolution_candidates_idempotency UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_evolution_candidates_tenant ON evolution_candidates(account_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_evolution_candidates_opp ON evolution_candidates(workspace_id, opportunity_id);
CREATE INDEX IF NOT EXISTS idx_evolution_candidates_state ON evolution_candidates(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_evolution_candidates_hash ON evolution_candidates(workspace_id, structural_hash);
CREATE INDEX IF NOT EXISTS idx_evolution_candidates_created_at ON evolution_candidates(workspace_id, created_at);

-- 2. Candidate Revisions Table (Deterministic revision lineage and synthesis provenance)
CREATE TABLE IF NOT EXISTS candidate_revisions (
  id VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision_number INT NOT NULL DEFAULT 1,
  parent_revision_id VARCHAR(64),
  source_code TEXT NOT NULL,
  source_digest VARCHAR(64) NOT NULL,
  input_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL,
  schema_digest VARCHAR(64) NOT NULL,
  manifest JSONB NOT NULL,
  manifest_digest VARCHAR(64) NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  state VARCHAR(32) NOT NULL DEFAULT 'active',
  prompt_template_id VARCHAR(64),
  prompt_template_version VARCHAR(64),
  prompt_digest VARCHAR(64),
  model_provider VARCHAR(64),
  model_id VARCHAR(64),
  request_id VARCHAR(64),
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  self_review JSONB NOT NULL DEFAULT '{}'::jsonb,
  repair_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  storage_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_candidate_revisions_cand ON candidate_revisions(workspace_id, candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_revisions_lookup ON candidate_revisions(workspace_id, candidate_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_candidate_revisions_state ON candidate_revisions(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_candidate_revisions_created_at ON candidate_revisions(workspace_id, created_at);
