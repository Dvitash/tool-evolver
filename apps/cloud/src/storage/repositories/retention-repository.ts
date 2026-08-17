import { randomUUID } from "node:crypto";
import { DatabasePool, Queryable } from "../../db/client.js";
import { TenantContext } from "../../tenant.js";
import {
  DeletionJobEntity,
  DeletionJobStatus,
  DeletionScope,
  ExportJobEntity,
  ExportJobStatus,
  ExportScope,
  RetentionHoldEntity,
  RetentionHoldTargetType,
  RetentionHoldType,
} from "../models/retention.js";

export class RetentionRepository {
  constructor(private pool: DatabasePool | Queryable) {}

  /**
   * Create a retention hold on a target entity.
   */
  async createHold(
    tenant: TenantContext,
    input: {
      id?: string;
      targetType: RetentionHoldTargetType;
      targetId: string;
      holdType: RetentionHoldType;
      reason: string;
      expiresAt?: string | null;
      metadata?: Record<string, unknown>;
    },
    db?: Queryable,
  ): Promise<RetentionHoldEntity> {
    const client = db ?? this.pool;
    const holdId = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ?? null;
    const metadata = input.metadata ?? {};

    await client.query(
      `INSERT INTO retention_holds (
        id, account_id, workspace_id, target_type, target_id,
        hold_type, reason, expires_at, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        holdId,
        tenant.accountId,
        tenant.workspaceId,
        input.targetType,
        input.targetId,
        input.holdType,
        input.reason,
        expiresAt,
        metadata,
        now,
        now,
      ],
    );

    return {
      id: holdId,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      holdType: input.holdType,
      reason: input.reason,
      expiresAt,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Retrieve a hold by ID.
   */
  async getHoldById(
    tenant: TenantContext,
    holdId: string,
    db?: Queryable,
  ): Promise<RetentionHoldEntity | null> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM retention_holds WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenant.accountId, tenant.workspaceId, holdId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToHold(result.rows[0]);
  }

  /**
   * List active holds for a tenant (optionally filtered by target).
   */
  async listActiveHolds(
    tenant: TenantContext,
    filter: { targetType?: RetentionHoldTargetType; targetId?: string; now?: string } = {},
    db?: Queryable,
  ): Promise<RetentionHoldEntity[]> {
    const client = db ?? this.pool;
    const currentTime = filter.now ?? new Date().toISOString();
    const conditions: string[] = [
      "account_id = $1",
      "workspace_id = $2",
    ];
    const params: unknown[] = [tenant.accountId, tenant.workspaceId];
    let paramIdx = 3;

    if (filter.targetType) {
      conditions.push(`target_type = $${paramIdx++}`);
      params.push(filter.targetType);
    }

    if (filter.targetId) {
      conditions.push(`target_id = $${paramIdx++}`);
      params.push(filter.targetId);
    }

    const whereClause = conditions.join(" AND ");
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM retention_holds WHERE ${whereClause} ORDER BY created_at DESC`,
      params,
    );

    const holds = result.rows.map((r) => this.mapRowToHold(r));
    // Filter out expired holds
    return holds.filter((h) => !h.expiresAt || new Date(h.expiresAt).getTime() > new Date(currentTime).getTime());
  }

  /**
   * Check whether a target is currently held.
   */
  async isTargetHeld(
    tenant: TenantContext,
    targetType: RetentionHoldTargetType,
    targetId: string,
    now?: string,
    db?: Queryable,
  ): Promise<boolean> {
    const active = await this.listActiveHolds(tenant, { targetType, targetId, now }, db);
    return active.length > 0;
  }

  /**
   * Release a hold by ID.
   */
  async releaseHold(
    tenant: TenantContext,
    holdId: string,
    db?: Queryable,
  ): Promise<boolean> {
    const client = db ?? this.pool;
    const res = await client.query(
      `DELETE FROM retention_holds WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenant.accountId, tenant.workspaceId, holdId],
    );
    return res.rowCount > 0;
  }

  /**
   * Release all holds for a given target.
   */
  async releaseHoldsForTarget(
    tenant: TenantContext,
    targetType: RetentionHoldTargetType,
    targetId: string,
    db?: Queryable,
  ): Promise<number> {
    const client = db ?? this.pool;
    const res = await client.query(
      `DELETE FROM retention_holds WHERE account_id = $1 AND workspace_id = $2 AND target_type = $3 AND target_id = $4`,
      [tenant.accountId, tenant.workspaceId, targetType, targetId],
    );
    return res.rowCount;
  }

  /**
   * Create an export job.
   */
  async createExportJob(
    tenant: TenantContext,
    input: {
      id?: string;
      requestedBy?: string;
      scope: ExportScope;
      targetId: string;
      format?: "json" | "zip" | "ndjson";
    },
    db?: Queryable,
  ): Promise<ExportJobEntity> {
    const client = db ?? this.pool;
    const jobId = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const requestedBy = input.requestedBy ?? "system";
    const format = input.format ?? "json";

    await client.query(
      `INSERT INTO export_jobs (
        id, account_id, workspace_id, requested_by, scope,
        target_id, status, format, export_path, manifest,
        error, record_count, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        jobId,
        tenant.accountId,
        tenant.workspaceId,
        requestedBy,
        input.scope,
        input.targetId,
        "pending",
        format,
        null,
        {},
        null,
        0,
        now,
        null,
      ],
    );

    return {
      id: jobId,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      requestedBy,
      scope: input.scope,
      targetId: input.targetId,
      status: "pending",
      format,
      exportPath: null,
      manifest: {},
      error: null,
      recordCount: 0,
      createdAt: now,
      completedAt: null,
    };
  }

  /**
   * Get an export job by ID.
   */
  async getExportJobById(
    tenant: TenantContext,
    jobId: string,
    db?: Queryable,
  ): Promise<ExportJobEntity | null> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM export_jobs WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenant.accountId, tenant.workspaceId, jobId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToExportJob(result.rows[0]);
  }

  /**
   * Update an export job status.
   */
  async updateExportJob(
    tenant: TenantContext,
    jobId: string,
    update: {
      status: ExportJobStatus;
      exportPath?: string | null;
      manifest?: Record<string, unknown>;
      error?: string | null;
      recordCount?: number;
      completedAt?: string | null;
    },
    db?: Queryable,
  ): Promise<void> {
    const client = db ?? this.pool;
    const exportPath = update.exportPath !== undefined ? update.exportPath : null;
    const manifest = update.manifest ?? {};
    const error = update.error !== undefined ? update.error : null;
    const recordCount = update.recordCount ?? 0;
    const completedAt = update.completedAt !== undefined ? update.completedAt : new Date().toISOString();

    await client.query(
      `UPDATE export_jobs SET
        status = $1,
        export_path = $2,
        manifest = $3,
        error = $4,
        record_count = $5,
        completed_at = $6
      WHERE account_id = $7 AND workspace_id = $8 AND id = $9`,
      [
        update.status,
        exportPath,
        manifest,
        error,
        recordCount,
        completedAt,
        tenant.accountId,
        tenant.workspaceId,
        jobId,
      ],
    );
  }

  /**
   * List export jobs for tenant.
   */
  async listExportJobs(tenant: TenantContext, db?: Queryable): Promise<ExportJobEntity[]> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM export_jobs WHERE account_id = $1 AND workspace_id = $2 ORDER BY created_at DESC`,
      [tenant.accountId, tenant.workspaceId],
    );
    return result.rows.map((r) => this.mapRowToExportJob(r));
  }

  /**
   * Create a deletion job.
   */
  async createDeletionJob(
    tenant: TenantContext,
    input: {
      id?: string;
      requestedBy?: string;
      scope: DeletionScope;
      targetId: string;
    },
    db?: Queryable,
  ): Promise<DeletionJobEntity> {
    const client = db ?? this.pool;
    const jobId = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const requestedBy = input.requestedBy ?? "system";

    await client.query(
      `INSERT INTO deletion_jobs (
        id, account_id, workspace_id, requested_by, scope,
        target_id, status, deleted_records_count, summary,
        error, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        jobId,
        tenant.accountId,
        tenant.workspaceId,
        requestedBy,
        input.scope,
        input.targetId,
        "pending",
        0,
        {},
        null,
        now,
        null,
      ],
    );

    return {
      id: jobId,
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      requestedBy,
      scope: input.scope,
      targetId: input.targetId,
      status: "pending",
      deletedRecordsCount: 0,
      summary: {},
      error: null,
      createdAt: now,
      completedAt: null,
    };
  }

  /**
   * Get a deletion job by ID.
   */
  async getDeletionJobById(
    tenant: TenantContext,
    jobId: string,
    db?: Queryable,
  ): Promise<DeletionJobEntity | null> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM deletion_jobs WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
      [tenant.accountId, tenant.workspaceId, jobId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToDeletionJob(result.rows[0]);
  }

  /**
   * Update a deletion job status.
   */
  async updateDeletionJob(
    tenant: TenantContext,
    jobId: string,
    update: {
      status: DeletionJobStatus;
      deletedRecordsCount?: number;
      summary?: Record<string, unknown>;
      error?: string | null;
      completedAt?: string | null;
    },
    db?: Queryable,
  ): Promise<void> {
    const client = db ?? this.pool;
    const deletedCount = update.deletedRecordsCount ?? 0;
    const summary = update.summary ?? {};
    const error = update.error !== undefined ? update.error : null;
    const completedAt = update.completedAt !== undefined ? update.completedAt : new Date().toISOString();

    await client.query(
      `UPDATE deletion_jobs SET
        status = $1,
        deleted_records_count = $2,
        summary = $3,
        error = $4,
        completed_at = $5
      WHERE account_id = $6 AND workspace_id = $7 AND id = $8`,
      [
        update.status,
        deletedCount,
        summary,
        error,
        completedAt,
        tenant.accountId,
        tenant.workspaceId,
        jobId,
      ],
    );
  }

  /**
   * List deletion jobs for tenant.
   */
  async listDeletionJobs(tenant: TenantContext, db?: Queryable): Promise<DeletionJobEntity[]> {
    const client = db ?? this.pool;
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM deletion_jobs WHERE account_id = $1 AND workspace_id = $2 ORDER BY created_at DESC`,
      [tenant.accountId, tenant.workspaceId],
    );
    return result.rows.map((r) => this.mapRowToDeletionJob(r));
  }

  /**
   * Map row to RetentionHoldEntity.
   */
  private mapRowToHold(row: Record<string, unknown>): RetentionHoldEntity {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      targetType: String(row.target_type) as RetentionHoldTargetType,
      targetId: String(row.target_id),
      holdType: String(row.hold_type) as RetentionHoldType,
      reason: String(row.reason),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      metadata: (typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata ?? {}) as Record<string, unknown>,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Map row to ExportJobEntity.
   */
  private mapRowToExportJob(row: Record<string, unknown>): ExportJobEntity {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      requestedBy: String(row.requested_by ?? "system"),
      scope: String(row.scope) as ExportScope,
      targetId: String(row.target_id),
      status: String(row.status) as ExportJobStatus,
      format: String(row.format ?? "json") as "json" | "zip" | "ndjson",
      exportPath: row.export_path ? String(row.export_path) : null,
      manifest: (typeof row.manifest === "string"
        ? JSON.parse(row.manifest)
        : row.manifest ?? {}) as Record<string, unknown>,
      error: row.error ? String(row.error) : null,
      recordCount: Number(row.record_count ?? 0),
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
    };
  }

  /**
   * Map row to DeletionJobEntity.
   */
  private mapRowToDeletionJob(row: Record<string, unknown>): DeletionJobEntity {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      requestedBy: String(row.requested_by ?? "system"),
      scope: String(row.scope) as DeletionScope,
      targetId: String(row.target_id),
      status: String(row.status) as DeletionJobStatus,
      deletedRecordsCount: Number(row.deleted_records_count ?? 0),
      summary: (typeof row.summary === "string"
        ? JSON.parse(row.summary)
        : row.summary ?? {}) as Record<string, unknown>,
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
    };
  }
}
