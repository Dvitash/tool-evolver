import { createHash } from "node:crypto";
import { DatabasePool, Queryable } from "./client.js";

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
    await db.query(`CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(account_id, workspace_id);`);

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
    await db.query(`CREATE INDEX IF NOT EXISTS idx_installations_tenant ON installations(account_id, workspace_id);`);

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
    await db.query(`CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON outbox(account_id, workspace_id);`);

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
    await db.query(`CREATE INDEX IF NOT EXISTS idx_dlq_tenant ON dead_letter_queue(account_id, workspace_id);`);

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
    await db.query(`CREATE INDEX IF NOT EXISTS idx_object_metadata_sha256 ON object_metadata(sha256);`);
  },
  down: async (db: Queryable) => {
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

export const DEFAULT_MIGRATIONS: Migration[] = [initialSchemaMigration];

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
  const migrations = (options.migrations ?? DEFAULT_MIGRATIONS).slice().sort((a, b) => a.version - b.version);
  const targetVersion = options.targetVersion ?? Number.MAX_SAFE_INTEGER;

  // Acquire advisory lock
  const locked = await pool.acquireAdvisoryLock(MIGRATION_ADVISORY_LOCK_ID);
  if (!locked) {
    throw new Error(`Failed to acquire migration advisory lock (${MIGRATION_ADVISORY_LOCK_ID}). Another migration is in progress.`);
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
        const checksum = migration.checksum ?? createHash("sha256").update(`${migration.version}_${migration.name}`).digest("hex");
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
  const migrations = (options.migrations ?? DEFAULT_MIGRATIONS).slice().sort((a, b) => b.version - a.version);
  const targetVersion = options.targetVersion ?? 0;

  const locked = await pool.acquireAdvisoryLock(MIGRATION_ADVISORY_LOCK_ID);
  if (!locked) {
    throw new Error(`Failed to acquire migration advisory lock (${MIGRATION_ADVISORY_LOCK_ID}). Another migration is in progress.`);
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
        throw new Error(`Migration ${migration.version} (${migration.name}) has no down() rollback method`);
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
  const appliedResult = await pool.query<{ version: number; name: string; applied_at: string; checksum: string }>(
    `SELECT version, name, applied_at, checksum FROM _migrations ORDER BY version ASC`,
  );

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
