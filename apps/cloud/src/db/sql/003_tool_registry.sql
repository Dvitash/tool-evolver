-- Tool Evolver Cloud Service Platform - Tool Registry & Artifacts Schema
-- Migration: 003_tool_registry.sql

-- 1. Tools (Logical tool metadata)
CREATE TABLE IF NOT EXISTS tools (
  id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  active_version VARCHAR(64),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_tools_tenant ON tools(account_id, workspace_id);

-- 2. Tool Versions (Immutable version records)
CREATE TABLE IF NOT EXISTS tool_versions (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  manifest_digest VARCHAR(64) NOT NULL,
  artifact_digest VARCHAR(64) NOT NULL,
  manifest JSONB NOT NULL,
  artifact JSONB NOT NULL,
  provenance JSONB NOT NULL,
  signature JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  superseded_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255) NOT NULL DEFAULT 'system',
  UNIQUE (workspace_id, tool_id, version)
);
CREATE INDEX IF NOT EXISTS idx_tool_versions_tenant ON tool_versions(account_id, workspace_id, tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_versions_artifact_digest ON tool_versions(artifact_digest);
CREATE INDEX IF NOT EXISTS idx_tool_versions_manifest_digest ON tool_versions(manifest_digest);
CREATE INDEX IF NOT EXISTS idx_tool_versions_status ON tool_versions(workspace_id, tool_id, status);

-- 3. Tool Publication Records (Lifecycle tracking)
CREATE TABLE IF NOT EXISTS tool_publication_records (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL,
  tool_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  revision_id VARCHAR(64),
  state VARCHAR(32) NOT NULL,
  manifest_digest VARCHAR(64) NOT NULL,
  artifact_digest VARCHAR(64) NOT NULL,
  storage_uri TEXT NOT NULL,
  signed_by VARCHAR(64),
  signature_algorithm VARCHAR(64),
  provenance_digest VARCHAR(64),
  version_diff JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tool_publication_records_tenant ON tool_publication_records(account_id, workspace_id, tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_publication_records_state ON tool_publication_records(state);

-- 4. Tool Version Aliases (e.g. latest, stable)
CREATE TABLE IF NOT EXISTS tool_version_aliases (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL,
  tool_id VARCHAR(64) NOT NULL,
  alias VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, tool_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_tool_version_aliases_lookup ON tool_version_aliases(workspace_id, tool_id, alias);

-- 5. Signing Keys (Cryptographic trust store & revocation list)
CREATE TABLE IF NOT EXISTS signing_keys (
  key_id VARCHAR(64) PRIMARY KEY,
  algorithm VARCHAR(64) NOT NULL,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  trust_level VARCHAR(32) NOT NULL DEFAULT 'production',
  revocation_reason TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signing_keys_status ON signing_keys(status, algorithm);
