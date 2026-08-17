import { randomUUID } from "node:crypto";
import {
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  ToolVersionSchema,
  type ToolVersionStatus,
} from "@tool-evolver/contracts";
import type { DatabasePool, Queryable } from "../../../db/client.js";
import { TenantGuard } from "../../../tenant.js";
import type {
  PublicationState,
  ToolEntity,
  ToolPublicationRecord,
  ToolVersionAliasEntity,
} from "../types.js";

/**
 * Repository for managing logical tools, immutable tool versions,
 * publication lifecycle records, version aliases, and supersession links.
 */
export class ToolRegistryRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Saves or updates logical tool metadata.
   */
  async saveTool(
    tenant: { accountId?: string; workspaceId: string },
    tool: {
      id: string;
      name: string;
      description?: string;
      activeVersion?: string;
      metadata?: Record<string, unknown>;
    },
    db?: Queryable,
  ): Promise<ToolEntity> {
    const client = db ?? this.pool;
    const accountId = tenant.accountId || "system";
    const now = new Date().toISOString();

    const existing = await this.getTool(tenant, tool.id, client);
    if (existing) {
      await client.query(
        `UPDATE tools SET
          name = $1,
          description = $2,
          active_version = $3,
          metadata = $4,
          updated_at = $5
        WHERE workspace_id = $6 AND id = $7`,
        [
          tool.name,
          tool.description ?? null,
          tool.activeVersion ?? existing.activeVersion ?? null,
          JSON.stringify(tool.metadata ?? existing.metadata ?? {}),
          now,
          tenant.workspaceId,
          tool.id,
        ],
      );
      return {
        id: tool.id,
        accountId: existing.accountId,
        workspaceId: tenant.workspaceId,
        name: tool.name,
        description: tool.description ?? existing.description,
        activeVersion: tool.activeVersion ?? existing.activeVersion,
        metadata: tool.metadata ?? existing.metadata,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
    }

    await client.query(
      `INSERT INTO tools (
        id, account_id, workspace_id, name, description, active_version, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tool.id,
        accountId,
        tenant.workspaceId,
        tool.name,
        tool.description ?? null,
        tool.activeVersion ?? null,
        JSON.stringify(tool.metadata ?? {}),
        now,
        now,
      ],
    );

    return {
      id: tool.id,
      accountId,
      workspaceId: tenant.workspaceId,
      name: tool.name,
      description: tool.description,
      activeVersion: tool.activeVersion,
      metadata: tool.metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Retrieves logical tool metadata by ID within a workspace.
   */
  async getTool(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    db?: Queryable,
  ): Promise<ToolEntity | null> {
    const client = db ?? this.pool;
    const res = await client.query<Record<string, unknown>>(
      `SELECT id, account_id, workspace_id, name, description, active_version, metadata, created_at, updated_at
       FROM tools
       WHERE workspace_id = $1 AND id = $2`,
      [tenant.workspaceId, toolId],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    if (tenant.accountId && row.account_id && tenant.accountId !== row.account_id) {
      TenantGuard.assertAccess({ accountId: String(row.account_id), workspaceId: String(row.workspace_id) });
    }

    return {
      id: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      description: row.description ? String(row.description) : undefined,
      activeVersion: row.active_version ? String(row.active_version) : undefined,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown> | undefined),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Lists all logical tools within a workspace.
   */
  async listTools(
    tenant: { accountId?: string; workspaceId: string },
    db?: Queryable,
  ): Promise<ToolEntity[]> {
    const client = db ?? this.pool;
    const res = await client.query<Record<string, unknown>>(
      `SELECT id, account_id, workspace_id, name, description, active_version, metadata, created_at, updated_at
       FROM tools
       WHERE workspace_id = $1
       ORDER BY name ASC`,
      [tenant.workspaceId],
    );

    return res.rows.map((row) => ({
      id: String(row.id),
      accountId: String(row.account_id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      description: row.description ? String(row.description) : undefined,
      activeVersion: row.active_version ? String(row.active_version) : undefined,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown> | undefined),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /**
   * Sets the active version pointer on a logical tool.
   */
  async setActiveVersion(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    version: string,
    db?: Queryable,
  ): Promise<void> {
    const client = db ?? this.pool;
    const now = new Date().toISOString();
    await client.query(
      `UPDATE tools SET active_version = $1, updated_at = $2 WHERE workspace_id = $3 AND id = $4`,
      [version, now, tenant.workspaceId, toolId],
    );
  }

  /**
   * Saves an immutable tool version.
   * Enforces immutability: rejects conflicting duplicate versions.
   */
  async saveToolVersion(
    tenant: { accountId?: string; workspaceId: string },
    toolVersion: ToolVersion,
    db?: Queryable,
  ): Promise<ToolVersion> {
    const client = db ?? this.pool;
    const accountId = tenant.accountId || "system";
    const now = new Date().toISOString();
    const versionId = `${tenant.workspaceId}:${toolVersion.toolId}:${toolVersion.version}`;

    // Verify immutability if existing
    const existing = await this.getToolVersion(tenant, toolVersion.toolId, toolVersion.version, client);
    if (existing) {
      if (
        existing.artifactDigest !== toolVersion.artifactDigest ||
        existing.manifestDigest !== toolVersion.manifestDigest
      ) {
        throw new Error(
          `Immutable version conflict: tool '${toolVersion.toolId}' version '${toolVersion.version}' already exists with different digests`,
        );
      }
      return existing;
    }

    await client.query(
      `INSERT INTO tool_versions (
        id, account_id, workspace_id, tool_id, version,
        manifest_digest, artifact_digest, manifest, artifact, provenance,
        signature, status, superseded_by, created_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        versionId,
        accountId,
        tenant.workspaceId,
        toolVersion.toolId,
        toolVersion.version,
        toolVersion.manifestDigest,
        toolVersion.artifactDigest,
        JSON.stringify(toolVersion.manifest),
        JSON.stringify(toolVersion.artifact),
        JSON.stringify(toolVersion.provenance),
        toolVersion.signature ? JSON.stringify(toolVersion.signature) : null,
        toolVersion.status ?? "active",
        null,
        toolVersion.createdAt ?? now,
        toolVersion.createdBy ?? "system",
      ],
    );

    return toolVersion;
  }

  /**
   * Retrieves a specific immutable tool version.
   */
  async getToolVersion(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    version: string,
    db?: Queryable,
  ): Promise<ToolVersion | null> {
    const client = db ?? this.pool;
    const res = await client.query<Record<string, unknown>>(
      `SELECT id, account_id, workspace_id, tool_id, version,
              manifest_digest, artifact_digest, manifest, artifact, provenance,
              signature, status, superseded_by, created_at, created_by
       FROM tool_versions
       WHERE workspace_id = $1 AND tool_id = $2 AND version = $3`,
      [tenant.workspaceId, toolId, version],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    const parseJson = (val: unknown) => (typeof val === "string" ? JSON.parse(val) : val);

    return {
      toolId: String(row.tool_id),
      version: String(row.version),
      manifestDigest: String(row.manifest_digest),
      artifactDigest: String(row.artifact_digest),
      manifest: parseJson(row.manifest),
      artifact: parseJson(row.artifact),
      provenance: parseJson(row.provenance),
      signature: row.signature ? parseJson(row.signature) : undefined,
      status: row.status as ToolVersionStatus,
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
    };
  }

  /**
   * Lists all versions for a given tool within a workspace.
   */
  async listToolVersions(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    options?: { status?: ToolVersionStatus[] },
    db?: Queryable,
  ): Promise<ToolVersion[]> {
    const client = db ?? this.pool;
    const res = await client.query<Record<string, unknown>>(
      `SELECT id, account_id, workspace_id, tool_id, version,
              manifest_digest, artifact_digest, manifest, artifact, provenance,
              signature, status, superseded_by, created_at, created_by
       FROM tool_versions
       WHERE workspace_id = $1 AND tool_id = $2
       ORDER BY created_at DESC`,
      [tenant.workspaceId, toolId],
    );

    const parseJson = (val: unknown) => (typeof val === "string" ? JSON.parse(val) : val);

    const versions: ToolVersion[] = res.rows.map((row) => ({
      toolId: String(row.tool_id),
      version: String(row.version),
      manifestDigest: String(row.manifest_digest),
      artifactDigest: String(row.artifact_digest),
      manifest: parseJson(row.manifest),
      artifact: parseJson(row.artifact),
      provenance: parseJson(row.provenance),
      signature: row.signature ? parseJson(row.signature) : undefined,
      status: row.status as ToolVersionStatus,
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
    }));

    if (options?.status && options.status.length > 0) {
      const allowed = new Set(options.status);
      return versions.filter((v) => allowed.has(v.status));
    }

    return versions;
  }

  /**
   * Retrieves the currently active tool version.
   */
  async getLatestActiveVersion(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    db?: Queryable,
  ): Promise<ToolVersion | null> {
    const tool = await this.getTool(tenant, toolId, db);
    if (tool?.activeVersion) {
      const active = await this.getToolVersion(tenant, toolId, tool.activeVersion, db);
      if (active && active.status === "active") {
        return active;
      }
    }

    const versions = await this.listToolVersions(tenant, toolId, { status: ["active"] }, db);
    return versions.length > 0 ? versions[0] : null;
  }

  /**
   * Retrieves eligible rollback targets for a tool.
   * Returns all active or deprecated prior versions, excluding revoked/quarantined versions.
   */
  async getEligibleRollbackTargets(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    db?: Queryable,
  ): Promise<ToolVersion[]> {
    const versions = await this.listToolVersions(tenant, toolId, { status: ["active", "deprecated"] }, db);
    return versions;
  }

  /**
   * Updates status and supersession link for a tool version.
   */
  async setVersionStatus(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    version: string,
    status: ToolVersionStatus,
    supersededBy?: string,
    db?: Queryable,
  ): Promise<void> {
    const client = db ?? this.pool;
    await client.query(
      `UPDATE tool_versions SET status = $1, superseded_by = $2 WHERE workspace_id = $3 AND tool_id = $4 AND version = $5`,
      [status, supersededBy ?? null, tenant.workspaceId, toolId, version],
    );
  }

  /**
   * Saves a tool publication lifecycle record.
   */
  async savePublicationRecord(
    tenant: { accountId?: string; workspaceId: string },
    record: ToolPublicationRecord,
    db?: Queryable,
  ): Promise<ToolPublicationRecord> {
    const client = db ?? this.pool;
    const accountId = tenant.accountId || record.accountId || "system";

    await client.query(
      `INSERT INTO tool_publication_records (
        id, account_id, workspace_id, tool_id, version, candidate_id, revision_id,
        state, manifest_digest, artifact_digest, storage_uri, signed_by, signature_algorithm,
        provenance_digest, version_diff, error_message, created_at, updated_at, published_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        record.id,
        accountId,
        tenant.workspaceId,
        record.toolId,
        record.version,
        record.candidateId,
        record.revisionId ?? null,
        record.state,
        record.manifestDigest,
        record.artifactDigest,
        record.storageUri,
        record.signedBy ?? null,
        record.signatureAlgorithm ?? null,
        record.provenanceDigest ?? null,
        record.versionDiff ? JSON.stringify(record.versionDiff) : null,
        record.errorMessage ?? null,
        record.createdAt,
        record.updatedAt,
        record.publishedAt ?? null,
      ],
    );

    return record;
  }

  /**
   * Updates state of a publication record.
   */
  async updatePublicationState(
    id: string,
    state: PublicationState,
    options?: { errorMessage?: string; publishedAt?: string },
    db?: Queryable,
  ): Promise<void> {
    const client = db ?? this.pool;
    const now = new Date().toISOString();

    await client.query(
      `UPDATE tool_publication_records SET
        state = $1,
        error_message = $2,
        published_at = $3,
        updated_at = $4
       WHERE id = $5`,
      [
        state,
        options?.errorMessage ?? null,
        options?.publishedAt ?? (state === "published" ? now : null),
        now,
        id,
      ],
    );
  }

  /**
   * Retrieves a publication record by ID.
   */
  async getPublicationRecord(
    tenant: { accountId?: string; workspaceId: string },
    id: string,
    db?: Queryable,
  ): Promise<ToolPublicationRecord | null> {
    const client = db ?? this.pool;
    const res = await client.query<Record<string, unknown>>(
      `SELECT id, account_id, workspace_id, tool_id, version, candidate_id, revision_id,
              state, manifest_digest, artifact_digest, storage_uri, signed_by, signature_algorithm,
              provenance_digest, version_diff, error_message, created_at, updated_at, published_at
       FROM tool_publication_records
       WHERE workspace_id = $1 AND id = $2`,
      [tenant.workspaceId, id],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    const parseJson = (val: unknown) => (typeof val === "string" ? JSON.parse(val) : val);

    return {
      id: String(row.id),
      accountId: row.account_id ? String(row.account_id) : undefined,
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      version: String(row.version),
      candidateId: String(row.candidate_id),
      revisionId: row.revision_id ? String(row.revision_id) : undefined,
      state: row.state as PublicationState,
      manifestDigest: String(row.manifest_digest),
      artifactDigest: String(row.artifact_digest),
      storageUri: String(row.storage_uri),
      signedBy: row.signed_by ? String(row.signed_by) : undefined,
      signatureAlgorithm: row.signature_algorithm ? String(row.signature_algorithm) : undefined,
      provenanceDigest: row.provenance_digest ? String(row.provenance_digest) : undefined,
      versionDiff: row.version_diff ? parseJson(row.version_diff) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      publishedAt: row.published_at ? String(row.published_at) : undefined,
    };
  }

  /**
   * Lists publication records for a workspace, optionally filtered by tool ID.
   */
  async listPublicationRecords(
    tenant: { accountId?: string; workspaceId: string },
    toolId?: string,
    db?: Queryable,
  ): Promise<ToolPublicationRecord[]> {
    const client = db ?? this.pool;
    let query = `SELECT id, account_id, workspace_id, tool_id, version, candidate_id, revision_id,
                       state, manifest_digest, artifact_digest, storage_uri, signed_by, signature_algorithm,
                       provenance_digest, version_diff, error_message, created_at, updated_at, published_at
                FROM tool_publication_records
                WHERE workspace_id = $1`;
    const params: unknown[] = [tenant.workspaceId];

    if (toolId) {
      query += ` AND tool_id = $2`;
      params.push(toolId);
    }
    query += ` ORDER BY created_at DESC`;

    const res = await client.query<Record<string, unknown>>(query, params);
    const parseJson = (val: unknown) => (typeof val === "string" ? JSON.parse(val) : val);

    return res.rows.map((row) => ({
      id: String(row.id),
      accountId: row.account_id ? String(row.account_id) : undefined,
      workspaceId: String(row.workspace_id),
      toolId: String(row.tool_id),
      version: String(row.version),
      candidateId: String(row.candidate_id),
      revisionId: row.revision_id ? String(row.revision_id) : undefined,
      state: row.state as PublicationState,
      manifestDigest: String(row.manifest_digest),
      artifactDigest: String(row.artifact_digest),
      storageUri: String(row.storage_uri),
      signedBy: row.signed_by ? String(row.signed_by) : undefined,
      signatureAlgorithm: row.signature_algorithm ? String(row.signature_algorithm) : undefined,
      provenanceDigest: row.provenance_digest ? String(row.provenance_digest) : undefined,
      versionDiff: row.version_diff ? parseJson(row.version_diff) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      publishedAt: row.published_at ? String(row.published_at) : undefined,
    }));
  }

  /**
   * Sets a version alias (e.g. latest, active, stable) pointing to a specific version.
   */
  async setAlias(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    alias: string,
    version: string,
    db?: Queryable,
  ): Promise<void> {
    const client = db ?? this.pool;
    const accountId = tenant.accountId || "system";
    const now = new Date().toISOString();
    const aliasId = `${tenant.workspaceId}:${toolId}:${alias}`;

    const existing = await this.getAlias(tenant, toolId, alias, client);
    if (existing) {
      await client.query(
        `UPDATE tool_version_aliases SET version = $1, updated_at = $2 WHERE workspace_id = $3 AND tool_id = $4 AND alias = $5`,
        [version, now, tenant.workspaceId, toolId, alias],
      );
    } else {
      await client.query(
        `INSERT INTO tool_version_aliases (id, account_id, workspace_id, tool_id, alias, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [aliasId, accountId, tenant.workspaceId, toolId, alias, version, now, now],
      );
    }
  }

  /**
   * Retrieves the version pointed to by an alias.
   */
  async getAlias(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    alias: string,
    db?: Queryable,
  ): Promise<string | null> {
    const client = db ?? this.pool;
    const res = await client.query<Record<string, unknown>>(
      `SELECT version FROM tool_version_aliases WHERE workspace_id = $1 AND tool_id = $2 AND alias = $3`,
      [tenant.workspaceId, toolId, alias],
    );
    if (res.rows.length === 0) return null;
    return String(res.rows[0].version);
  }

  /**
   * Resolves a version string or alias to a ToolVersion.
   */
  async resolveVersion(
    tenant: { accountId?: string; workspaceId: string },
    toolId: string,
    versionOrAlias: string,
    db?: Queryable,
  ): Promise<ToolVersion | null> {
    // Check if direct version exists
    const direct = await this.getToolVersion(tenant, toolId, versionOrAlias, db);
    if (direct) return direct;

    // Check alias
    const aliasedVersion = await this.getAlias(tenant, toolId, versionOrAlias, db);
    if (aliasedVersion) {
      return this.getToolVersion(tenant, toolId, aliasedVersion, db);
    }

    if (versionOrAlias === "latest" || versionOrAlias === "active") {
      return this.getLatestActiveVersion(tenant, toolId, db);
    }

    return null;
  }
}
