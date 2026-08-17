-- Tool Evolver Cloud Service Platform - Opportunity Detection & Lineage Persistence Schema
-- Migration: 006_opportunities.sql

-- 1. Opportunities Table (Deterministic, immutable opportunity records with tenant isolation)
CREATE TABLE IF NOT EXISTS opportunities (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cluster_id VARCHAR(64) NOT NULL,
  structural_hash VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'eligible',
  trigger_type VARCHAR(64) NOT NULL,
  trigger_reason VARCHAR(64) NOT NULL,
  occurrence_count INT NOT NULL DEFAULT 1,
  distinct_session_count INT NOT NULL DEFAULT 1,
  evidence_event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  classification JSONB,
  suppression_reason TEXT,
  coverage_decision TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_opportunities_workspace_idempotency UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_opportunities_tenant ON opportunities(account_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_hash ON opportunities(workspace_id, structural_hash);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_opportunities_idempotency ON opportunities(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_opportunities_created_at ON opportunities(workspace_id, created_at);
