import type { DatabasePool, Queryable } from "../../../db/client.js";
import type {
  SigningKeyAlgorithm,
  SigningKeyMetadata,
  SigningKeyStatus,
  SigningKeyTrustLevel,
} from "../types.js";

/**
 * Repository managing cryptographic signing keys, trust metadata,
 * rotation lineage, and revocation lists.
 */
export class SigningKeyRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Saves or registers a signing key.
   */
  async saveKey(key: SigningKeyMetadata, db?: Queryable): Promise<void> {
    const client = db ?? this.pool;
    const now = new Date().toISOString();

    const existing = await this.getKey(key.keyId, client);
    if (existing) {
      await client.query(
        `UPDATE signing_keys SET
          algorithm = $1,
          public_key_pem = $2,
          private_key_pem = $3,
          status = $4,
          trust_level = $5,
          revocation_reason = $6,
          revoked_at = $7,
          rotated_at = $8
        WHERE key_id = $9`,
        [
          key.algorithm,
          key.publicKeyPem,
          key.privateKeyPem ?? null,
          key.status,
          key.trustLevel,
          key.revocationReason ?? null,
          key.revokedAt ?? null,
          key.rotatedAt ?? null,
          key.keyId,
        ],
      );
      return;
    }

    await client.query(
      `INSERT INTO signing_keys (
        key_id, algorithm, public_key_pem, private_key_pem, status, trust_level,
        revocation_reason, revoked_at, created_at, rotated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        key.keyId,
        key.algorithm,
        key.publicKeyPem,
        key.privateKeyPem ?? null,
        key.status,
        key.trustLevel,
        key.revocationReason ?? null,
        key.revokedAt ?? null,
        key.createdAt ?? now,
        key.rotatedAt ?? null,
      ],
    );
  }

  /**
   * Retrieves a signing key by ID.
   */
  async getKey(keyId: string, db?: Queryable): Promise<SigningKeyMetadata | null> {
    const client = db ?? this.pool;
    const res = await client.query<Record<string, unknown>>(
      `SELECT key_id, algorithm, public_key_pem, private_key_pem, status, trust_level,
              revocation_reason, revoked_at, created_at, rotated_at
       FROM signing_keys
       WHERE key_id = $1`,
      [keyId],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    return {
      keyId: String(row.key_id),
      algorithm: row.algorithm as SigningKeyAlgorithm,
      publicKeyPem: String(row.public_key_pem),
      privateKeyPem: row.private_key_pem ? String(row.private_key_pem) : undefined,
      status: row.status as SigningKeyStatus,
      trustLevel: row.trust_level as SigningKeyTrustLevel,
      revocationReason: row.revocation_reason ? String(row.revocation_reason) : undefined,
      revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
      createdAt: String(row.created_at),
      rotatedAt: row.rotated_at ? String(row.rotated_at) : undefined,
    };
  }

  /**
   * Retrieves the currently active signing key for a given algorithm.
   */
  async getActiveKey(
    algorithm: SigningKeyAlgorithm = "ed25519",
    db?: Queryable,
  ): Promise<SigningKeyMetadata | null> {
    const client = db ?? this.pool;
    const res = await client.query<Record<string, unknown>>(
      `SELECT key_id, algorithm, public_key_pem, private_key_pem, status, trust_level,
              revocation_reason, revoked_at, created_at, rotated_at
       FROM signing_keys
       WHERE status = 'active' AND algorithm = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [algorithm],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    return {
      keyId: String(row.key_id),
      algorithm: row.algorithm as SigningKeyAlgorithm,
      publicKeyPem: String(row.public_key_pem),
      privateKeyPem: row.private_key_pem ? String(row.private_key_pem) : undefined,
      status: row.status as SigningKeyStatus,
      trustLevel: row.trust_level as SigningKeyTrustLevel,
      revocationReason: row.revocation_reason ? String(row.revocation_reason) : undefined,
      revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
      createdAt: String(row.created_at),
      rotatedAt: row.rotated_at ? String(row.rotated_at) : undefined,
    };
  }

  /**
   * Lists signing keys matching optional filter criteria.
   */
  async listKeys(
    options?: { status?: SigningKeyStatus; algorithm?: SigningKeyAlgorithm },
    db?: Queryable,
  ): Promise<SigningKeyMetadata[]> {
    const client = db ?? this.pool;
    let query = `SELECT key_id, algorithm, public_key_pem, private_key_pem, status, trust_level,
                       revocation_reason, revoked_at, created_at, rotated_at
                FROM signing_keys
                WHERE 1=1`;
    const params: unknown[] = [];

    if (options?.status) {
      params.push(options.status);
      query += ` AND status = $${params.length}`;
    }

    if (options?.algorithm) {
      params.push(options.algorithm);
      query += ` AND algorithm = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const res = await client.query<Record<string, unknown>>(query, params);

    return res.rows.map((row) => ({
      keyId: String(row.key_id),
      algorithm: row.algorithm as SigningKeyAlgorithm,
      publicKeyPem: String(row.public_key_pem),
      privateKeyPem: row.private_key_pem ? String(row.private_key_pem) : undefined,
      status: row.status as SigningKeyStatus,
      trustLevel: row.trust_level as SigningKeyTrustLevel,
      revocationReason: row.revocation_reason ? String(row.revocation_reason) : undefined,
      revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
      createdAt: String(row.created_at),
      rotatedAt: row.rotated_at ? String(row.rotated_at) : undefined,
    }));
  }

  /**
   * Rotates an active key: marks the old key as 'rotated' and saves the new active key.
   */
  async rotateKey(oldKeyId: string, newKey: SigningKeyMetadata, db?: Queryable): Promise<void> {
    const client = db ?? this.pool;
    const now = new Date().toISOString();

    // Mark old key as rotated
    await client.query(
      `UPDATE signing_keys SET status = 'rotated', rotated_at = $1 WHERE key_id = $2`,
      [now, oldKeyId],
    );

    // Save new active key
    await this.saveKey(
      {
        ...newKey,
        status: "active",
        createdAt: now,
      },
      client,
    );
  }

  /**
   * Revokes a signing key.
   */
  async revokeKey(keyId: string, reason: string, db?: Queryable): Promise<void> {
    const client = db ?? this.pool;
    const now = new Date().toISOString();

    await client.query(
      `UPDATE signing_keys SET status = 'revoked', revocation_reason = $1, revoked_at = $2 WHERE key_id = $3`,
      [reason, now, keyId],
    );
  }

  /**
   * Checks whether a signing key is revoked.
   */
  async isRevoked(keyId: string, db?: Queryable): Promise<boolean> {
    const key = await this.getKey(keyId, db);
    return key?.status === "revoked";
  }
}
