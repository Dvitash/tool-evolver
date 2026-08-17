import { type DatabasePool, Queryable } from "../../db/client.js";

/**
 * Refresh Token Family for rotating token tracking and reuse detection.
 */
export interface RefreshTokenFamily {
  familyId: string;
  accountId: string;
  workspaceId: string;
  deviceId: string;
  installationId: string;
  activeTokenHash: string;
  status: "active" | "revoked";
  revokedReason?: "reuse_detected" | "user_logout" | "device_revoked" | "manual";
  createdAt: string;
  updatedAt: string;
}

/**
 * Individual Refresh Token record in the rotation history.
 */
export interface RefreshTokenRecord {
  tokenHash: string;
  familyId: string;
  sequence: number;
  status: "active" | "consumed" | "revoked";
  expiresAt: string;
  createdAt: string;
}

/**
 * Revoked Device record.
 */
export interface RevokedDeviceRecord {
  deviceId: string;
  revokedAt: string;
  reason?: string;
}

/**
 * Revoked Installation record.
 */
export interface RevokedInstallationRecord {
  installationId: string;
  revokedAt: string;
  reason?: string;
}

/**
 * Proof of Possession Key record for asymmetric client binding.
 */
export interface ProofOfPossessionKeyRecord {
  keyId: string;
  deviceId: string;
  publicKey: string;
  algorithm: string;
  createdAt: string;
  expiresAt?: string;
}

/**
 * Common Token Repository interface.
 */
export interface TokenRepository {
  createTokenFamily(family: {
    familyId: string;
    accountId: string;
    workspaceId: string;
    deviceId: string;
    installationId: string;
    activeTokenHash: string;
  }): Promise<RefreshTokenFamily>;

  getTokenFamily(familyId: string): Promise<RefreshTokenFamily | null>;
  revokeTokenFamily(
    familyId: string,
    reason?: "reuse_detected" | "user_logout" | "device_revoked" | "manual",
  ): Promise<void>;

  saveRefreshToken(record: RefreshTokenRecord): Promise<void>;
  getRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>;
  consumeAndRotateRefreshToken(
    oldTokenHash: string,
    newRecord: RefreshTokenRecord,
  ): Promise<boolean>;

  revokeDevice(deviceId: string, reason?: string): Promise<void>;
  isDeviceRevoked(deviceId: string): Promise<boolean>;

  revokeInstallation(installationId: string, reason?: string): Promise<void>;
  isInstallationRevoked(installationId: string): Promise<boolean>;

  saveProofOfPossessionKey(record: ProofOfPossessionKeyRecord): Promise<void>;
  getProofOfPossessionKey(keyId: string): Promise<ProofOfPossessionKeyRecord | null>;
}

/**
 * In-Memory implementation of TokenRepository for fast tests and standalone runs.
 */
export class MemoryTokenRepository implements TokenRepository {
  private families = new Map<string, RefreshTokenFamily>();
  private tokens = new Map<string, RefreshTokenRecord>();
  private revokedDevices = new Map<string, RevokedDeviceRecord>();
  private revokedInstallations = new Map<string, RevokedInstallationRecord>();
  private popKeys = new Map<string, ProofOfPossessionKeyRecord>();

  async createTokenFamily(family: {
    familyId: string;
    accountId: string;
    workspaceId: string;
    deviceId: string;
    installationId: string;
    activeTokenHash: string;
  }): Promise<RefreshTokenFamily> {
    const now = new Date().toISOString();
    const created: RefreshTokenFamily = {
      familyId: family.familyId,
      accountId: family.accountId,
      workspaceId: family.workspaceId,
      deviceId: family.deviceId,
      installationId: family.installationId,
      activeTokenHash: family.activeTokenHash,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.families.set(family.familyId, created);
    return created;
  }

  async getTokenFamily(familyId: string): Promise<RefreshTokenFamily | null> {
    return this.families.get(familyId) ?? null;
  }

  async revokeTokenFamily(
    familyId: string,
    reason: "reuse_detected" | "user_logout" | "device_revoked" | "manual" = "manual",
  ): Promise<void> {
    const family = this.families.get(familyId);
    if (family) {
      family.status = "revoked";
      family.revokedReason = reason;
      family.updatedAt = new Date().toISOString();
      this.families.set(familyId, family);
    }

    // Revoke all tokens belonging to this family
    for (const [hash, record] of this.tokens.entries()) {
      if (record.familyId === familyId) {
        record.status = "revoked";
        this.tokens.set(hash, record);
      }
    }
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.tokens.set(record.tokenHash, record);
  }

  async getRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.tokens.get(tokenHash) ?? null;
  }

  async consumeAndRotateRefreshToken(
    oldTokenHash: string,
    newRecord: RefreshTokenRecord,
  ): Promise<boolean> {
    const oldRecord = this.tokens.get(oldTokenHash);
    if (!oldRecord) return false;

    // Mark old token consumed
    oldRecord.status = "consumed";
    this.tokens.set(oldTokenHash, oldRecord);

    // Save new active token
    this.tokens.set(newRecord.tokenHash, newRecord);

    // Update active token hash on family
    const family = this.families.get(newRecord.familyId);
    if (family) {
      family.activeTokenHash = newRecord.tokenHash;
      family.updatedAt = new Date().toISOString();
      this.families.set(family.familyId, family);
    }

    return true;
  }

  async revokeDevice(deviceId: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    this.revokedDevices.set(deviceId, {
      deviceId,
      revokedAt: now,
      reason: reason ?? "Device revoked",
    });

    // Revoke all token families associated with this device
    for (const family of this.families.values()) {
      if (family.deviceId === deviceId) {
        await this.revokeTokenFamily(family.familyId, "device_revoked");
      }
    }
  }

  async isDeviceRevoked(deviceId: string): Promise<boolean> {
    return this.revokedDevices.has(deviceId);
  }

  async revokeInstallation(installationId: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    this.revokedInstallations.set(installationId, {
      installationId,
      revokedAt: now,
      reason: reason ?? "Installation revoked",
    });

    // Revoke all token families associated with this installation
    for (const family of this.families.values()) {
      if (family.installationId === installationId) {
        await this.revokeTokenFamily(family.familyId, "device_revoked");
      }
    }
  }

  async isInstallationRevoked(installationId: string): Promise<boolean> {
    return this.revokedInstallations.has(installationId);
  }

  async saveProofOfPossessionKey(record: ProofOfPossessionKeyRecord): Promise<void> {
    this.popKeys.set(record.keyId, record);
  }

  async getProofOfPossessionKey(keyId: string): Promise<ProofOfPossessionKeyRecord | null> {
    return this.popKeys.get(keyId) ?? null;
  }

  clear(): void {
    this.families.clear();
    this.tokens.clear();
    this.revokedDevices.clear();
    this.revokedInstallations.clear();
    this.popKeys.clear();
  }
}

/**
 * Database-backed implementation of TokenRepository.
 */
export class DatabaseTokenRepository implements TokenRepository {
  constructor(private pool: DatabasePool) {}

  async createTokenFamily(family: {
    familyId: string;
    accountId: string;
    workspaceId: string;
    deviceId: string;
    installationId: string;
    activeTokenHash: string;
  }): Promise<RefreshTokenFamily> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO refresh_token_families (family_id, account_id, workspace_id, device_id, installation_id, active_token_hash, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
       ON CONFLICT (family_id) DO UPDATE SET active_token_hash = $6, updated_at = $8`,
      [
        family.familyId,
        family.accountId,
        family.workspaceId,
        family.deviceId,
        family.installationId,
        family.activeTokenHash,
        now,
        now,
      ],
    );
    return {
      ...family,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  }

  async getTokenFamily(familyId: string): Promise<RefreshTokenFamily | null> {
    const res = await this.pool.query<{
      family_id: string;
      account_id: string;
      workspace_id: string;
      device_id: string;
      installation_id: string;
      active_token_hash: string;
      status: "active" | "revoked";
      revoked_reason?: "reuse_detected" | "user_logout" | "device_revoked" | "manual";
      created_at: string;
      updated_at: string;
    }>(`SELECT * FROM refresh_token_families WHERE family_id = $1 LIMIT 1`, [familyId]);

    const row = res.rows[0];
    if (!row) return null;
    return {
      familyId: row.family_id,
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      deviceId: row.device_id,
      installationId: row.installation_id,
      activeTokenHash: row.active_token_hash,
      status: row.status,
      revokedReason: row.revoked_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async revokeTokenFamily(
    familyId: string,
    reason: "reuse_detected" | "user_logout" | "device_revoked" | "manual" = "manual",
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE refresh_token_families SET status = 'revoked', revoked_reason = $1, updated_at = $2 WHERE family_id = $3`,
      [reason, now, familyId],
    );
    await this.pool.query(`UPDATE refresh_tokens SET status = 'revoked' WHERE family_id = $1`, [
      familyId,
    ]);
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_tokens (token_hash, family_id, sequence, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (token_hash) DO UPDATE SET status = $4`,
      [
        record.tokenHash,
        record.familyId,
        record.sequence,
        record.status,
        record.expiresAt,
        record.createdAt,
      ],
    );
  }

  async getRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const res = await this.pool.query<{
      token_hash: string;
      family_id: string;
      sequence: number;
      status: "active" | "consumed" | "revoked";
      expires_at: string;
      created_at: string;
    }>(`SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`, [tokenHash]);

    const row = res.rows[0];
    if (!row) return null;
    return {
      tokenHash: row.token_hash,
      familyId: row.family_id,
      sequence: row.sequence,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  async consumeAndRotateRefreshToken(
    oldTokenHash: string,
    newRecord: RefreshTokenRecord,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    await this.pool.query(`UPDATE refresh_tokens SET status = 'consumed' WHERE token_hash = $1`, [
      oldTokenHash,
    ]);
    await this.saveRefreshToken(newRecord);
    await this.pool.query(
      `UPDATE refresh_token_families SET active_token_hash = $1, updated_at = $2 WHERE family_id = $3`,
      [newRecord.tokenHash, now, newRecord.familyId],
    );
    return true;
  }

  async revokeDevice(deviceId: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO revoked_devices (device_id, revoked_at, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_id) DO UPDATE SET revoked_at = $2, reason = $3`,
      [deviceId, now, reason ?? "Device revoked"],
    );
    // Also revoke all families for this device
    await this.pool.query(
      `UPDATE refresh_token_families SET status = 'revoked', revoked_reason = 'device_revoked', updated_at = $1 WHERE device_id = $2`,
      [now, deviceId],
    );
  }

  async isDeviceRevoked(deviceId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM revoked_devices WHERE device_id = $1 LIMIT 1`,
      [deviceId],
    );
    return res.rowCount > 0;
  }

  async revokeInstallation(installationId: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO revoked_installations (installation_id, revoked_at, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (installation_id) DO UPDATE SET revoked_at = $2, reason = $3`,
      [installationId, now, reason ?? "Installation revoked"],
    );
    await this.pool.query(
      `UPDATE refresh_token_families SET status = 'revoked', revoked_reason = 'device_revoked', updated_at = $1 WHERE installation_id = $2`,
      [now, installationId],
    );
  }

  async isInstallationRevoked(installationId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM revoked_installations WHERE installation_id = $1 LIMIT 1`,
      [installationId],
    );
    return res.rowCount > 0;
  }

  async saveProofOfPossessionKey(record: ProofOfPossessionKeyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO pop_keys (key_id, device_id, public_key, algorithm, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key_id) DO UPDATE SET public_key = $3, expires_at = $5`,
      [
        record.keyId,
        record.deviceId,
        record.publicKey,
        record.algorithm,
        record.expiresAt ?? null,
        record.createdAt,
      ],
    );
  }

  async getProofOfPossessionKey(keyId: string): Promise<ProofOfPossessionKeyRecord | null> {
    const res = await this.pool.query<{
      key_id: string;
      device_id: string;
      public_key: string;
      algorithm: string;
      expires_at?: string;
      created_at: string;
    }>(`SELECT * FROM pop_keys WHERE key_id = $1 LIMIT 1`, [keyId]);

    const row = res.rows[0];
    if (!row) return null;
    return {
      keyId: row.key_id,
      deviceId: row.device_id,
      publicKey: row.public_key,
      algorithm: row.algorithm,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }
}
