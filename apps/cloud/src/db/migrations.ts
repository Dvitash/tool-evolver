import { createHash } from "node:crypto";
import type { DatabasePool, Queryable } from "./client.js";

/**
 * Migration advisory lock ID (hash of "tool_evolver_schema_migrations").
 */
export const MIGRATION_ADVISORY_LOCK_ID = "8389364951478144880";

/**
 * Migration definition interface.
 */
export interface Migration {
  version: number;
  name: string;
  checksum?: string;
  up: (db: Queryable) => Promise<void>;
  down?: (db: Queryable) => Promise<void>;
}

/**
 * Result of a migration operation.
 */
export interface MigrationResult {
  success: boolean;
  appliedCount: number;
  rolledBackCount?: number;
  currentVersion: number;
  appliedMigrations: Array<{ version: number; name: string }>;
  error?: string;
}

/**
 * Status of a single migration.
 */
export interface MigrationStatus {
  version: number;
  name: string;
  applied: boolean;
  appliedAt?: string;
  checksum?: string;
}

/**
 * Built-in initial schema migration.
 */
export const initialSchemaMigration: Migration = {
  version: 1,
  name: "001_initial_schema",
  checksum: createHash("sha256").update("001_initial_schema_v1").digest("hex"),
  up: async (db: Queryable) => {
    // 1. Accounts
    await db.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        plan VARCHAR(64) NOT NULL DEFAULT 'standard',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Workspaces
    await db.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_workspaces_account ON workspaces(account_id);`);

    // 3. Devices
    await db.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        platform VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'registered',
        public_key TEXT,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(account_id, workspace_id);`,
    );

    // 4. Installations
    await db.query(`
      CREATE TABLE IF NOT EXISTS installations (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        device_id VARCHAR(64) NOT NULL,
        harness_type VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        version VARCHAR(64) NOT NULL,
        config JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_installations_tenant ON installations(account_id, workspace_id);`,
    );

    // 5. Outbox
    await db.query(`
      CREATE TABLE IF NOT EXISTS outbox (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        aggregate_type VARCHAR(64) NOT NULL,
        aggregate_id VARCHAR(64) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        headers JSONB DEFAULT '{}'::jsonb,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        retry_count INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, created_at);`);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON outbox(account_id, workspace_id);`,
    );

    // 6. Jobs Queue
    await db.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        job_type VARCHAR(128) NOT NULL,
        version VARCHAR(64) NOT NULL DEFAULT '1.0.0',
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        attempt INT NOT NULL DEFAULT 1,
        max_attempts INT NOT NULL DEFAULT 3,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        idempotency_key VARCHAR(128),
        causation_id VARCHAR(64),
        correlation_id VARCHAR(64),
        trace_context JSONB DEFAULT '{}'::jsonb,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_jobs_dequeue ON jobs(status, available_at);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(account_id, workspace_id);`);

    // 7. Dead Letter Queue
    await db.query(`
      CREATE TABLE IF NOT EXISTS dead_letter_queue (
        id VARCHAR(64) PRIMARY KEY,
        original_job_id VARCHAR(64) NOT NULL,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        job_type VARCHAR(128) NOT NULL,
        version VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        attempts INT NOT NULL,
        failure_reason TEXT NOT NULL,
        failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        causation_id VARCHAR(64),
        correlation_id VARCHAR(64),
        requeued_at TIMESTAMPTZ
      );
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_dlq_tenant ON dead_letter_queue(account_id, workspace_id);`,
    );

    // 8. Object Metadata
    await db.query(`
      CREATE TABLE IF NOT EXISTS object_metadata (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        key VARCHAR(512) NOT NULL,
        sha256 VARCHAR(64) NOT NULL,
        size_bytes BIGINT NOT NULL,
        content_type VARCHAR(128),
        retention_marker VARCHAR(32) NOT NULL DEFAULT 'standard',
        expires_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_object_metadata_sha256 ON object_metadata(sha256);`,
    );

    // 9. Ingestion Receipts
    await db.query(`
      CREATE TABLE IF NOT EXISTS ingestion_receipts (
        receipt_id VARCHAR(64) PRIMARY KEY,
        batch_id VARCHAR(64) NOT NULL,
        installation_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        device_id VARCHAR(64),
        account_id VARCHAR(64),
        source_cursors JSONB DEFAULT '[]'::jsonb,
        source_cursor VARCHAR(255),
        content_hash VARCHAR(64) NOT NULL,
        accepted_count INT NOT NULL DEFAULT 0,
        duplicate_count INT NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'accepted',
        response_payload JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_ingestion_receipts_batch ON ingestion_receipts(installation_id, workspace_id, batch_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_ingestion_receipts_cursor ON ingestion_receipts(installation_id, workspace_id, source_cursor);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_ingestion_receipts_hash ON ingestion_receipts(content_hash);`,
    );
  },
  down: async (db: Queryable) => {
    await db.query(`DROP TABLE IF EXISTS ingestion_receipts;`);
    await db.query(`DROP TABLE IF EXISTS object_metadata;`);
    await db.query(`DROP TABLE IF EXISTS dead_letter_queue;`);
    await db.query(`DROP TABLE IF EXISTS jobs;`);
    await db.query(`DROP TABLE IF EXISTS outbox;`);
    await db.query(`DROP TABLE IF EXISTS installations;`);
    await db.query(`DROP TABLE IF EXISTS devices;`);
    await db.query(`DROP TABLE IF EXISTS workspaces;`);
    await db.query(`DROP TABLE IF EXISTS accounts;`);
  },
};

/**
 * Observations, sessions, evidence, and retention migration (version 2).
 */
export const observationsAndEvidenceMigration: Migration = {
  version: 2,
  name: "002_observations_and_evidence",
  checksum: createHash("sha256").update("002_observations_and_evidence_v1").digest("hex"),
  up: async (db: Queryable) => {
    // 1. Sessions
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(account_id, workspace_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(account_id, workspace_id, started_at);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(account_id, workspace_id, status);`,
    );

    // 2. Session Branches
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_session_branches_session ON session_branches(session_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_session_branches_tenant ON session_branches(account_id, workspace_id);`,
    );

    // 3. Normalized Events
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_normalized_events_tenant_session ON normalized_events(account_id, workspace_id, session_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_normalized_events_sequence ON normalized_events(session_id, causal_sequence);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_normalized_events_timestamp ON normalized_events(account_id, workspace_id, timestamp);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_normalized_events_type ON normalized_events(account_id, workspace_id, event_type);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_normalized_events_parent ON normalized_events(session_id, parent_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_normalized_events_hash ON normalized_events(content_hash);`,
    );

    // 4. Evidence Sets
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evidence_sets_tenant ON evidence_sets(account_id, workspace_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evidence_sets_session ON evidence_sets(session_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evidence_sets_digest ON evidence_sets(root_digest);`,
    );

    // 5. Evidence Members
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evidence_members_set ON evidence_members(evidence_set_id, sequence_index);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evidence_members_event ON evidence_members(event_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evidence_members_tenant ON evidence_members(account_id, workspace_id);`,
    );

    // 6. Retention Holds
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_retention_holds_target ON retention_holds(account_id, workspace_id, target_type, target_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_retention_holds_expires ON retention_holds(expires_at);`,
    );

    // 7. Export Jobs
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant ON export_jobs(account_id, workspace_id, status);`,
    );

    // 8. Deletion Jobs
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_deletion_jobs_tenant ON deletion_jobs(account_id, workspace_id, status);`,
    );
  },
  down: async (db: Queryable) => {
    await db.query(`DROP TABLE IF EXISTS deletion_jobs;`);
    await db.query(`DROP TABLE IF EXISTS export_jobs;`);
    await db.query(`DROP TABLE IF EXISTS retention_holds;`);
    await db.query(`DROP TABLE IF EXISTS evidence_members;`);
    await db.query(`DROP TABLE IF EXISTS evidence_sets;`);
    await db.query(`DROP TABLE IF EXISTS normalized_events;`);
    await db.query(`DROP TABLE IF EXISTS session_branches;`);
    await db.query(`DROP TABLE IF EXISTS sessions;`);
  },
};

/**
 * Tool Registry, Versions, Publication Records & Cryptographic Keys Migration.
 */
export const toolRegistryAndArtifactsMigration: Migration = {
  version: 3,
  name: "003_tool_registry",
  checksum: createHash("sha256").update("003_tool_registry_v1").digest("hex"),
  up: async (db: Queryable) => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS tools (
        id VARCHAR(64) NOT NULL,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        active_version VARCHAR(64),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, id)
      );
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tools_tenant ON tools(account_id, workspace_id);`,
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS tool_versions (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tool_versions_tenant ON tool_versions(account_id, workspace_id, tool_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tool_versions_artifact_digest ON tool_versions(artifact_digest);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tool_versions_manifest_digest ON tool_versions(manifest_digest);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tool_versions_status ON tool_versions(workspace_id, tool_id, status);`,
    );

    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tool_publication_records_tenant ON tool_publication_records(account_id, workspace_id, tool_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tool_publication_records_state ON tool_publication_records(state);`,
    );

    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tool_version_aliases_lookup ON tool_version_aliases(workspace_id, tool_id, alias);`,
    );

    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_signing_keys_status ON signing_keys(status, algorithm);`,
    );
  },
  down: async (db: Queryable) => {
    await db.query(`DROP TABLE IF EXISTS signing_keys;`);
    await db.query(`DROP TABLE IF EXISTS tool_version_aliases;`);
    await db.query(`DROP TABLE IF EXISTS tool_publication_records;`);
    await db.query(`DROP TABLE IF EXISTS tool_versions;`);
    await db.query(`DROP TABLE IF EXISTS tools;`);
  },
};

/**
 * Autonomous Canary, Promotion, Suspension, and Rollback Migration.
 */
export const rolloutAndCanaryMigration: Migration = {
  version: 4,
  name: "004_rollouts",
  checksum: createHash("sha256").update("004_rollouts_v1").digest("hex"),
  up: async (db: Queryable) => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS rollouts (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_rollouts_workspace_tool ON rollouts(workspace_id, tool_id, state);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_rollouts_digest ON rollouts(workspace_id, artifact_digest);`,
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS rollout_decisions (
        id VARCHAR(64) PRIMARY KEY,
        rollout_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_rollout_decisions_rollout ON rollout_decisions(rollout_id, evaluated_at);`,
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS rollout_session_assignments (
        id VARCHAR(64) PRIMARY KEY,
        workspace_id VARCHAR(64) NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        tool_id VARCHAR(64) NOT NULL,
        assigned_version VARCHAR(64) NOT NULL,
        rollout_id VARCHAR(64),
        is_canary BOOLEAN NOT NULL DEFAULT FALSE,
        is_breaking_schema_isolated BOOLEAN NOT NULL DEFAULT FALSE,
        reason VARCHAR(64) NOT NULL,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        UNIQUE (workspace_id, session_id, tool_id)
      );
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_session_assignments_tool ON rollout_session_assignments(workspace_id, tool_id);`,
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS rollout_incidents (
        id VARCHAR(64) PRIMARY KEY,
        rollout_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL,
        tool_id VARCHAR(64) NOT NULL,
        version VARCHAR(64) NOT NULL,
        severity VARCHAR(32) NOT NULL,
        incident_type VARCHAR(64) NOT NULL,
        description TEXT NOT NULL,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        triggered_rollback BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_rollout_incidents_rollout ON rollout_incidents(rollout_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_rollout_incidents_tool ON rollout_incidents(workspace_id, tool_id);`,
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS rollout_overrides (
        workspace_id VARCHAR(64) NOT NULL,
        tool_id VARCHAR(64) NOT NULL,
        override_type VARCHAR(32) NOT NULL,
        pinned_version VARCHAR(64),
        reason TEXT NOT NULL,
        created_by VARCHAR(64) NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, tool_id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS rollout_telemetry_events (
        id VARCHAR(64) PRIMARY KEY,
        workspace_id VARCHAR(64) NOT NULL,
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_telemetry_events ON rollout_telemetry_events(workspace_id, tool_id, version, timestamp);`,
    );
  },
  down: async (db: Queryable) => {
    await db.query(`DROP TABLE IF EXISTS rollout_telemetry_events;`);
    await db.query(`DROP TABLE IF EXISTS rollout_overrides;`);
    await db.query(`DROP TABLE IF EXISTS rollout_incidents;`);
    await db.query(`DROP TABLE IF EXISTS rollout_session_assignments;`);
    await db.query(`DROP TABLE IF EXISTS rollout_decisions;`);
    await db.query(`DROP TABLE IF EXISTS rollouts;`);
  },
};

/**
 * Built-in analytics & metrics schema migration (v5).
 */
export const analyticsAndMetricsMigration: Migration = {
  version: 5,
  name: "005_analytics_and_metrics",
  up: async (db: Queryable) => {
    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_telemetry_receipts_workspace_batch ON telemetry_receipts(workspace_id, batch_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_telemetry_receipts_tenant ON telemetry_receipts(account_id, workspace_id);`,
    );

    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_telemetry_buckets_query ON telemetry_buckets(workspace_id, tool_id, version, metric_name, window_start);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_telemetry_buckets_tenant ON telemetry_buckets(account_id, workspace_id);`,
    );

    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_rollout_metric_windows_query ON rollout_metric_windows(workspace_id, tool_id, version, window_start);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_rollout_metric_windows_tenant ON rollout_metric_windows(account_id, workspace_id);`,
    );

    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_efficiency_metrics_query ON efficiency_metrics(workspace_id, tool_id, version, calculated_at);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_efficiency_metrics_tenant ON efficiency_metrics(account_id, workspace_id);`,
    );

    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_eval_calibrations_query ON evaluation_calibrations(workspace_id, tool_id, version, calibrated_at);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_eval_calibrations_tenant ON evaluation_calibrations(account_id, workspace_id);`,
    );

    await db.query(`
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
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_query ON anomaly_alerts(workspace_id, tool_id, version, detected_at);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_tenant ON anomaly_alerts(account_id, workspace_id);`,
    );
  },
  down: async (db: Queryable) => {
    await db.query(`DROP TABLE IF EXISTS anomaly_alerts;`);
    await db.query(`DROP TABLE IF EXISTS evaluation_calibrations;`);
    await db.query(`DROP TABLE IF EXISTS efficiency_metrics;`);
    await db.query(`DROP TABLE IF EXISTS rollout_metric_windows;`);
    await db.query(`DROP TABLE IF EXISTS telemetry_buckets;`);
    await db.query(`DROP TABLE IF EXISTS telemetry_receipts;`);
  },
};

/**
 * Opportunity persistence & detection schema migration (v6).
 */
export const opportunitiesMigration: Migration = {
  version: 6,
  name: "006_opportunities",
  up: async (db: Queryable) => {
    await db.query(`
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
    `);

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_opportunities_tenant ON opportunities(account_id, workspace_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_opportunities_hash ON opportunities(workspace_id, structural_hash);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(workspace_id, status);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_opportunities_idempotency ON opportunities(workspace_id, idempotency_key);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_opportunities_created_at ON opportunities(workspace_id, created_at);`,
    );
  },
  down: async (db: Queryable) => {
    await db.query(`DROP TABLE IF EXISTS opportunities;`);
  },
};
/**
 * Candidate & revision persistence schema migration (v7).
 */
export const candidatesMigration: Migration = {
  version: 7,
  name: "007_candidates",
  checksum: createHash("sha256").update("007_candidates_v1").digest("hex"),
  up: async (db: Queryable) => {
    await db.query(`
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
    `);

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evolution_candidates_tenant ON evolution_candidates(account_id, workspace_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evolution_candidates_opp ON evolution_candidates(workspace_id, opportunity_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evolution_candidates_state ON evolution_candidates(workspace_id, state);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evolution_candidates_hash ON evolution_candidates(workspace_id, structural_hash);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_evolution_candidates_created_at ON evolution_candidates(workspace_id, created_at);`,
    );

    await db.query(`
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
    `);

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_candidate_revisions_cand ON candidate_revisions(workspace_id, candidate_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_candidate_revisions_lookup ON candidate_revisions(workspace_id, candidate_id, revision_number);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_candidate_revisions_state ON candidate_revisions(workspace_id, state);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_candidate_revisions_created_at ON candidate_revisions(workspace_id, created_at);`,
    );
  },
  down: async (db: Queryable) => {
    await db.query(`DROP TABLE IF EXISTS candidate_revisions;`);
    await db.query(`DROP TABLE IF EXISTS evolution_candidates;`);
  },
};
/**
 * Candidate lifecycle & transition persistence schema migration (v8).
 */
export const candidateLifecycleMigration: Migration = {
  version: 8,
  name: "008_candidate_lifecycle",
  checksum: createHash("sha256").update("008_candidate_lifecycle_v1").digest("hex"),
  up: async (db: Queryable) => {
    await db.query(`
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
    `);

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_candidate_lifecycle_tenant ON candidate_lifecycle_states(account_id, workspace_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_candidate_lifecycle_state ON candidate_lifecycle_states(workspace_id, current_state);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_candidate_lifecycle_cand ON candidate_lifecycle_states(workspace_id, candidate_id);`,
    );

    await db.query(`
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
    `);

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_cand ON candidate_lifecycle_transitions(workspace_id, candidate_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_created_at ON candidate_lifecycle_transitions(workspace_id, created_at);`,
    );

    await db.query(`
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
    `);

    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_dlq_cand ON candidate_lifecycle_dlq(workspace_id, candidate_id);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_dlq_status ON candidate_lifecycle_dlq(workspace_id, resumed);`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_dlq_created_at ON candidate_lifecycle_dlq(workspace_id, created_at);`,
    );
  },
  down: async (db: Queryable) => {
    await db.query(`DROP TABLE IF EXISTS candidate_lifecycle_dlq;`);
    await db.query(`DROP TABLE IF EXISTS candidate_lifecycle_transitions;`);
    await db.query(`DROP TABLE IF EXISTS candidate_lifecycle_states;`);
  },
};

/**
 * Persisted replay options migration (v9): adds columns to store canonical
 * HistoricalReplayOptions and its digest for lifecycle replay persistence.
 * Idempotent: uses IF NOT EXISTS / IF EXISTS so existing DBs upgrade cleanly
 * and repeated runs are no-ops.
 */
export const persistedReplayOptionsMigration: Migration = {
  version: 9,
  name: "009_persisted_replay_options",
  checksum: createHash("sha256").update("009_persisted_replay_options_v1").digest("hex"),
  up: async (db: Queryable) => {
    await db.query(`ALTER TABLE candidate_lifecycle_states ADD COLUMN IF NOT EXISTS persisted_replay_options JSONB`);
    await db.query(`ALTER TABLE candidate_lifecycle_states ADD COLUMN IF NOT EXISTS persisted_replay_options_digest TEXT`);
  },
  down: async (db: Queryable) => {
    await db.query(`ALTER TABLE candidate_lifecycle_states DROP COLUMN IF EXISTS persisted_replay_options`);
    await db.query(`ALTER TABLE candidate_lifecycle_states DROP COLUMN IF EXISTS persisted_replay_options_digest`);
  },
};

export const DEFAULT_MIGRATIONS: Migration[] = [
  initialSchemaMigration,
  observationsAndEvidenceMigration,
  toolRegistryAndArtifactsMigration,
  rolloutAndCanaryMigration,
  analyticsAndMetricsMigration,
  opportunitiesMigration,
  candidatesMigration,
  candidateLifecycleMigration,
  persistedReplayOptionsMigration,
];

/**
 * Ensure the migration tracking table exists.
 */
async function ensureMigrationsTable(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum VARCHAR(64) NOT NULL
    );
  `);
}

/**
 * Run pending database migrations with advisory lock protection.
 */
export async function runMigrations(
  pool: DatabasePool,
  options: { targetVersion?: number; migrations?: Migration[] } = {},
): Promise<MigrationResult> {
  const migrations = (options.migrations ?? DEFAULT_MIGRATIONS)
    .slice()
    .sort((a, b) => a.version - b.version);
  const targetVersion = options.targetVersion ?? Number.MAX_SAFE_INTEGER;

  // Acquire advisory lock
  const locked = await pool.acquireAdvisoryLock(MIGRATION_ADVISORY_LOCK_ID);
  if (!locked) {
    throw new Error(
      `Failed to acquire migration advisory lock (${MIGRATION_ADVISORY_LOCK_ID}). Another migration is in progress.`,
    );
  }

  try {
    await ensureMigrationsTable(pool);

    // Get applied migrations
    const appliedResult = await pool.query<{ version: number; name: string }>(
      `SELECT version, name FROM _migrations ORDER BY version ASC`,
    );
    const appliedVersions = new Set(appliedResult.rows.map((r) => r.version));

    const newlyApplied: Array<{ version: number; name: string }> = [];

    for (const migration of migrations) {
      if (migration.version > targetVersion) break;
      if (appliedVersions.has(migration.version)) continue;

      // Run migration inside transaction
      await pool.transaction(async (tx) => {
        await migration.up(tx);
        const checksum =
          migration.checksum ??
          createHash("sha256").update(`${migration.version}_${migration.name}`).digest("hex");
        await tx.query(
          `INSERT INTO _migrations (version, name, applied_at, checksum) VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, new Date().toISOString(), checksum],
        );
      });

      newlyApplied.push({ version: migration.version, name: migration.name });
      appliedVersions.add(migration.version);
    }

    const currentVersion = appliedVersions.size > 0 ? Math.max(...Array.from(appliedVersions)) : 0;

    return {
      success: true,
      appliedCount: newlyApplied.length,
      currentVersion,
      appliedMigrations: newlyApplied,
    };
  } finally {
    await pool.releaseAdvisoryLock(MIGRATION_ADVISORY_LOCK_ID);
  }
}

/**
 * Rollback database migrations down to targetVersion with advisory lock protection.
 */
export async function rollbackMigration(
  pool: DatabasePool,
  options: { targetVersion?: number; migrations?: Migration[] } = {},
): Promise<MigrationResult> {
  const migrations = (options.migrations ?? DEFAULT_MIGRATIONS)
    .slice()
    .sort((a, b) => b.version - a.version);
  const targetVersion = options.targetVersion ?? 0;

  const locked = await pool.acquireAdvisoryLock(MIGRATION_ADVISORY_LOCK_ID);
  if (!locked) {
    throw new Error(
      `Failed to acquire migration advisory lock (${MIGRATION_ADVISORY_LOCK_ID}). Another migration is in progress.`,
    );
  }

  try {
    await ensureMigrationsTable(pool);

    const appliedResult = await pool.query<{ version: number; name: string }>(
      `SELECT version, name FROM _migrations ORDER BY version DESC`,
    );
    const appliedVersions = new Set(appliedResult.rows.map((r) => r.version));
    const rolledBack: Array<{ version: number; name: string }> = [];

    for (const migration of migrations) {
      if (migration.version <= targetVersion) break;
      if (!appliedVersions.has(migration.version)) continue;
      if (!migration.down) {
        throw new Error(
          `Migration ${migration.version} (${migration.name}) has no down() rollback method`,
        );
      }

      await pool.transaction(async (tx) => {
        await migration.down!(tx);
        await tx.query(`DELETE FROM _migrations WHERE version = $1`, [migration.version]);
      });

      rolledBack.push({ version: migration.version, name: migration.name });
      appliedVersions.delete(migration.version);
    }

    const currentVersion = appliedVersions.size > 0 ? Math.max(...Array.from(appliedVersions)) : 0;

    return {
      success: true,
      appliedCount: 0,
      rolledBackCount: rolledBack.length,
      currentVersion,
      appliedMigrations: rolledBack,
    };
  } finally {
    await pool.releaseAdvisoryLock(MIGRATION_ADVISORY_LOCK_ID);
  }
}

/**
 * Get status of all available migrations.
 */
export async function getMigrationStatus(
  pool: DatabasePool,
  migrations: Migration[] = DEFAULT_MIGRATIONS,
): Promise<MigrationStatus[]> {
  await ensureMigrationsTable(pool);
  const appliedResult = await pool.query<{
    version: number;
    name: string;
    applied_at: string;
    checksum: string;
  }>(`SELECT version, name, applied_at, checksum FROM _migrations ORDER BY version ASC`);

  const appliedMap = new Map<number, { appliedAt: string; checksum: string }>();
  for (const row of appliedResult.rows) {
    appliedMap.set(row.version, { appliedAt: row.applied_at, checksum: row.checksum });
  }

  return migrations.map((m) => {
    const applied = appliedMap.get(m.version);
    return {
      version: m.version,
      name: m.name,
      applied: Boolean(applied),
      appliedAt: applied?.appliedAt,
      checksum: applied?.checksum ?? m.checksum,
    };
  });
}
