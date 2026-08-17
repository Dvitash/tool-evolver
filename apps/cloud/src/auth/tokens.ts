import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AuthClaims,
  AuthClaimsSchema,
  AuthScope,
  TokenErrorCode,
  TokenRotationRequest,
  TokenRotationResponse,
} from "@tool-evolver/protocol";
import { sha256 } from "@tool-evolver/crypto";
import {
  MemoryTokenRepository,
  RefreshTokenRecord,
  TokenRepository,
} from "./repositories/token-repository.js";
import {
  AccountRepository,
  MemoryAccountRepository,
} from "./repositories/account-repository.js";

/**
 * Custom Error for Auth / Token failures.
 */
export class TokenError extends Error {
  readonly code: TokenErrorCode;
  readonly httpStatus: number;
  readonly interval?: number;

  constructor(
    code: TokenErrorCode,
    message: string,
    httpStatus = 400,
    interval?: number,
  ) {
    super(message);
    this.name = "TokenError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.interval = interval;
  }
}

/**
 * Base64URL string encoding.
 */
export function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Base64URL string decoding.
 */
export function base64UrlDecode(data: string): string {
  let base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Redact sensitive secrets from display strings and logs.
 */
export function redactSecret(secret: string): string {
  if (!secret) return "[EMPTY_SECRET]";
  if (secret.length <= 8) return "[REDACTED_SECRET]";
  return `${secret.slice(0, 4)}...[REDACTED]...${secret.slice(-4)}`;
}

/**
 * Redact raw JWT / Refresh token from logs.
 */
export function redactToken(token: string): string {
  if (!token) return "[EMPTY_TOKEN]";
  if (token.length <= 12) return "[REDACTED_TOKEN]";
  return `${token.slice(0, 6)}...[REDACTED]...${token.slice(-6)}`;
}

/**
 * JWT Header definition for HS256.
 */
interface JwtHeader {
  alg: "HS256";
  typ: "JWT";
}

const DEFAULT_JWT_HEADER: JwtHeader = {
  alg: "HS256",
  typ: "JWT",
};

/**
 * Sign a JWT payload using HMAC-SHA256.
 */
export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const headerPart = base64UrlEncode(JSON.stringify(DEFAULT_JWT_HEADER));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${headerPart}.${payloadPart}`;

  const signature = createHmac("sha256", secret)
    .update(unsignedToken)
    .digest();
  const signaturePart = base64UrlEncode(signature);

  return `${unsignedToken}.${signaturePart}`;
}

/**
 * Verify a JWT token signature and expiration.
 */
export function verifyJwt<T extends Record<string, unknown> = Record<string, unknown>>(
  token: string,
  secret: string,
  options?: { issuer?: string; audience?: string; now?: number },
): { valid: boolean; payload?: T; error?: string; code?: TokenErrorCode } {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Token is empty or invalid format", code: "invalid_grant" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Malformed JWT structure", code: "invalid_grant" };
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const unsignedToken = `${headerPart}.${payloadPart}`;

  const expectedSignature = createHmac("sha256", secret)
    .update(unsignedToken)
    .digest();
  const expectedSigBase64 = base64UrlEncode(expectedSignature);

  // Timing safe signature comparison
  const sigBuffer = Buffer.from(signaturePart);
  const expectedSigBuffer = Buffer.from(expectedSigBase64);

  if (sigBuffer.length !== expectedSigBuffer.length || !timingSafeEqual(sigBuffer, expectedSigBuffer)) {
    return { valid: false, error: "Invalid token signature", code: "invalid_grant" };
  }

  try {
    const payload = JSON.parse(base64UrlDecode(payloadPart)) as T;

    // Check expiration
    const nowMs = options?.now ?? Date.now();
    if (payload.expiresAt) {
      const expiresAtMs = new Date(payload.expiresAt as string).getTime();
      if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
        return { valid: false, payload, error: "Token has expired", code: "expired_token" };
      }
    } else if (payload.exp && typeof payload.exp === "number") {
      const expMs = payload.exp * 1000;
      if (expMs <= nowMs) {
        return { valid: false, payload, error: "Token has expired", code: "expired_token" };
      }
    }

    // Check issuer if requested
    if (options?.issuer && payload.issuer && payload.issuer !== options.issuer) {
      return { valid: false, payload, error: `Invalid issuer: expected ${options.issuer}`, code: "invalid_grant" };
    }

    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: `Failed to decode JWT payload: ${(err as Error).message}`, code: "invalid_grant" };
  }
}

/**
 * Token Service configuration options.
 */
export interface TokenServiceConfig {
  jwtSecret: string;
  deviceTokenSecret?: string;
  issuer?: string;
  audience?: string;
  accessTokenTtlSeconds?: number; // default 3600 (1 hour)
  refreshTokenTtlSeconds?: number; // default 2592000 (30 days)
  tokenRepository?: TokenRepository;
  accountRepository?: AccountRepository;
}

/**
 * Token Service managing JWT issue, validation, rotating refresh tokens, and reuse detection.
 */
export class TokenService {
  private readonly jwtSecret: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;
  readonly tokenRepository: TokenRepository;
  readonly accountRepository: AccountRepository;

  constructor(config: TokenServiceConfig) {
    this.jwtSecret = config.jwtSecret;
    this.issuer = config.issuer ?? "tool-evolver-cloud";
    this.audience = config.audience ?? "tool-evolver-client";
    this.accessTokenTtlSeconds = config.accessTokenTtlSeconds ?? 3600;
    this.refreshTokenTtlSeconds = config.refreshTokenTtlSeconds ?? 2592000;
    this.tokenRepository = config.tokenRepository ?? new MemoryTokenRepository();
    this.accountRepository = config.accountRepository ?? new MemoryAccountRepository();
  }

  /**
   * Issue a short-lived access token JWT.
   */
  issueAccessToken(params: {
    accountId: string;
    deviceId: string;
    installationId: string;
    workspaceId: string;
    scopes: AuthScope[];
    rawUploadConsent?: boolean;
    subject?: string;
    expiresInSeconds?: number;
    protocolVersion?: string;
  }): { accessToken: string; claims: AuthClaims } {
    const now = new Date();
    const ttl = params.expiresInSeconds ?? this.accessTokenTtlSeconds;
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const claims: AuthClaims = {
      accountId: params.accountId,
      deviceId: params.deviceId,
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      scopes: params.scopes.length > 0 ? params.scopes : ["device:connect"],
      rawUploadConsent: params.rawUploadConsent ?? false,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      tokenType: "access",
      subject: params.subject ?? params.accountId,
      issuer: this.issuer,
    };

    const validatedClaims = AuthClaimsSchema.parse(claims);
    const token = signJwt(
      {
        ...validatedClaims,
        aud: this.audience,
        protocolVersion: params.protocolVersion ?? "1.0.0",
      },
      this.jwtSecret,
    );

    return { accessToken: token, claims: validatedClaims };
  }

  /**
   * Verify an access token JWT and check claims validity and revocation.
   */
  async verifyAccessToken(token: string): Promise<{
    valid: boolean;
    claims?: AuthClaims;
    error?: string;
    code?: TokenErrorCode;
  }> {
    const result = verifyJwt<AuthClaims & { aud?: string }>(token, this.jwtSecret, {
      issuer: this.issuer,
    });

    if (!result.valid || !result.payload) {
      return {
        valid: false,
        error: result.error ?? "Invalid access token",
        code: result.code ?? "invalid_grant",
      };
    }

    try {
      const claims = AuthClaimsSchema.parse(result.payload);

      if (claims.tokenType !== "access") {
        return {
          valid: false,
          error: `Expected access token but got ${claims.tokenType}`,
          code: "invalid_grant",
        };
      }

      // Check if device is revoked
      const deviceRevoked = await this.tokenRepository.isDeviceRevoked(claims.deviceId);
      if (deviceRevoked) {
        return {
          valid: false,
          error: `Device ${claims.deviceId} has been revoked`,
          code: "revoked_device",
        };
      }

      const accountDeviceRevoked = await this.accountRepository.isDeviceRevoked(claims.deviceId);
      if (accountDeviceRevoked) {
        return {
          valid: false,
          error: `Device ${claims.deviceId} is revoked`,
          code: "revoked_device",
        };
      }

      // Check if installation is revoked
      if (claims.installationId) {
        const instRevoked = await this.tokenRepository.isInstallationRevoked(claims.installationId);
        if (instRevoked) {
          return {
            valid: false,
            error: `Installation ${claims.installationId} has been revoked`,
            code: "revoked_device",
          };
        }
      }

      return { valid: true, claims };
    } catch (err) {
      return {
        valid: false,
        error: `Invalid token claims structure: ${(err as Error).message}`,
        code: "invalid_grant",
      };
    }
  }

  /**
   * Issue a new Token Pair (Access Token + Rotating Refresh Token with a new Family).
   */
  async issueTokenPair(params: {
    accountId: string;
    deviceId: string;
    installationId: string;
    workspaceId: string;
    scopes: AuthScope[];
    rawUploadConsent?: boolean;
    subject?: string;
    expiresInSeconds?: number;
    protocolVersion?: string;
  }): Promise<{
    accessToken: string;
    tokenType: "Bearer";
    expiresIn: number;
    refreshToken: string;
    claims: AuthClaims;
    familyId: string;
  }> {
    const { accessToken, claims } = this.issueAccessToken(params);

    // Generate cryptographically secure refresh token
    const refreshToken = `rt_${randomBytes(32).toString("hex")}`;
    const tokenHash = sha256(refreshToken);
    const familyId = `fam_${randomBytes(16).toString("hex")}`;

    const now = new Date();
    const refreshExpiresAt = new Date(now.getTime() + this.refreshTokenTtlSeconds * 1000).toISOString();

    // Create token family
    await this.tokenRepository.createTokenFamily({
      familyId,
      accountId: params.accountId,
      workspaceId: params.workspaceId,
      deviceId: params.deviceId,
      installationId: params.installationId,
      activeTokenHash: tokenHash,
    });

    // Save initial refresh token record
    const record: RefreshTokenRecord = {
      tokenHash,
      familyId,
      sequence: 1,
      status: "active",
      expiresAt: refreshExpiresAt,
      createdAt: now.toISOString(),
    };
    await this.tokenRepository.saveRefreshToken(record);

    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: params.expiresInSeconds ?? this.accessTokenTtlSeconds,
      refreshToken,
      claims,
      familyId,
    };
  }

  /**
   * Rotate a Refresh Token and issue a new Access Token.
   * Enforces RFC 6749 / RFC 8628 Token Rotation and CRITICAL REUSE DETECTION.
   */
  async rotateRefreshToken(request: TokenRotationRequest): Promise<TokenRotationResponse> {
    const tokenHash = sha256(request.refreshToken);
    const record = await this.tokenRepository.getRefreshToken(tokenHash);

    // 1. Check if token exists in repository
    if (!record) {
      throw new TokenError("invalid_grant", "Invalid or unknown refresh token");
    }

    // 2. CRITICAL REUSE DETECTION
    // If a refresh token that has ALREADY been consumed is presented again,
    // it indicates a token replay / compromise attack. Revoke the ENTIRE token family immediately!
    if (record.status === "consumed") {
      await this.tokenRepository.revokeTokenFamily(record.familyId, "reuse_detected");
      throw new TokenError(
        "invalid_grant",
        "Refresh token reuse detected: token family has been permanently revoked",
        400,
      );
    }

    if (record.status === "revoked") {
      throw new TokenError("invalid_grant", "Refresh token has been revoked");
    }

    // 3. Check token family status
    const family = await this.tokenRepository.getTokenFamily(record.familyId);
    if (!family || family.status === "revoked") {
      throw new TokenError("invalid_grant", "Token family has been revoked");
    }

    // 4. Check device and installation ID match
    if (family.deviceId !== request.deviceId) {
      throw new TokenError("invalid_grant", "Device ID does not match refresh token authorization");
    }
    if (request.installationId && family.installationId !== request.installationId) {
      throw new TokenError("invalid_grant", "Installation ID does not match refresh token authorization");
    }

    // 5. Check expiration
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new TokenError("expired_token", "Refresh token has expired");
    }

    // 6. Check device revocation
    const deviceRevoked = await this.tokenRepository.isDeviceRevoked(request.deviceId);
    if (deviceRevoked) {
      throw new TokenError("revoked_device", "Device has been revoked");
    }

    const accountDeviceRevoked = await this.accountRepository.isDeviceRevoked(request.deviceId);
    if (accountDeviceRevoked) {
      throw new TokenError("revoked_device", "Device has been revoked");
    }

    if (request.installationId) {
      const instRevoked = await this.tokenRepository.isInstallationRevoked(request.installationId);
      if (instRevoked) {
        throw new TokenError("revoked_device", "Installation has been revoked");
      }
    }

    // 7. Generate new rotated Refresh Token and new Access Token
    const newRefreshToken = `rt_${randomBytes(32).toString("hex")}`;
    const newTokenHash = sha256(newRefreshToken);
    const now = new Date();
    const refreshExpiresAt = new Date(now.getTime() + this.refreshTokenTtlSeconds * 1000).toISOString();

    const newRecord: RefreshTokenRecord = {
      tokenHash: newTokenHash,
      familyId: record.familyId,
      sequence: record.sequence + 1,
      status: "active",
      expiresAt: refreshExpiresAt,
      createdAt: now.toISOString(),
    };

    // Atomically consume old token and set new token as active in family
    await this.tokenRepository.consumeAndRotateRefreshToken(tokenHash, newRecord);

    // Issue new access token
    const { accessToken, claims } = this.issueAccessToken({
      accountId: family.accountId,
      workspaceId: family.workspaceId,
      deviceId: family.deviceId,
      installationId: family.installationId,
      scopes: [
        "device:connect",
        "observations:write",
        "catalog:read",
        "artifacts:read",
        "deployments:read",
        "telemetry:write",
      ],
    });

    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: this.accessTokenTtlSeconds,
      refreshToken: newRefreshToken,
      claims,
    };
  }

  /**
   * Revoke device authorization and all its token families.
   */
  async revokeDevice(deviceId: string, reason?: string): Promise<void> {
    await this.tokenRepository.revokeDevice(deviceId, reason);
    await this.accountRepository.revokeDevice(deviceId);
  }

  /**
   * Revoke installation authorization.
   */
  async revokeInstallation(installationId: string, reason?: string): Promise<void> {
    await this.tokenRepository.revokeInstallation(installationId, reason);
    await this.accountRepository.revokeInstallation(installationId);
  }

  /**
   * Revoke a specific token family.
   */
  async revokeTokenFamily(
    familyId: string,
    reason: "reuse_detected" | "user_logout" | "device_revoked" | "manual" = "manual",
  ): Promise<void> {
    await this.tokenRepository.revokeTokenFamily(familyId, reason);
  }
}
