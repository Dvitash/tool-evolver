import { randomBytes } from "node:crypto";
import {
  AuthScope,
  DeviceAuthBootstrapRequest,
  DeviceAuthBootstrapRequestSchema,
  DeviceAuthBootstrapResponse,
  DeviceTokenExchangeRequest,
  DeviceTokenExchangeRequestSchema,
  DeviceTokenExchangeResponse,
} from "@tool-evolver/protocol";
import { ConsentManager } from "./consent.js";
import { AccountRepository } from "./repositories/account-repository.js";
import { TokenError, TokenService } from "./tokens.js";

/**
 * Internal device flow session state.
 */
export interface DeviceFlowSession {
  deviceCode: string;
  userCode: string;
  deviceId: string;
  installationId: string;
  hostname: string;
  platform: string;
  arch: string;
  clientVersion: string;
  scopes: AuthScope[];
  status: "pending" | "authorized" | "denied" | "expired";
  interval: number; // in seconds
  lastPollTime: number; // timestamp in ms
  createdAt: number; // timestamp in ms
  expiresAt: number; // timestamp in ms
  authorizedData?: {
    accountId: string;
    workspaceId: string;
    userId?: string;
    rawUploadConsent?: boolean;
  };
}

/**
 * Options for configuring DeviceFlowEngine.
 */
export interface DeviceFlowEngineOptions {
  tokenService: TokenService;
  accountRepository: AccountRepository;
  consentManager?: ConsentManager;
  defaultVerificationUri?: string;
  defaultExpiresInSeconds?: number;
  defaultIntervalSeconds?: number;
}

/**
 * RFC 8628 OAuth 2.0 Device Authorization Flow Engine.
 */
export class DeviceFlowEngine {
  private sessionsByDeviceCode = new Map<string, DeviceFlowSession>();
  private sessionsByUserCode = new Map<string, string>(); // userCode -> deviceCode
  private readonly tokenService: TokenService;
  private readonly accountRepository: AccountRepository;
  private readonly consentManager: ConsentManager;
  private readonly defaultVerificationUri: string;
  private readonly defaultExpiresInSeconds: number;
  private readonly defaultIntervalSeconds: number;

  constructor(options: DeviceFlowEngineOptions) {
    this.tokenService = options.tokenService;
    this.accountRepository = options.accountRepository;
    this.consentManager = options.consentManager ?? new ConsentManager();
    this.defaultVerificationUri = options.defaultVerificationUri ?? "https://cloud.toolevolver.dev/device";
    this.defaultExpiresInSeconds = options.defaultExpiresInSeconds ?? 900; // 15 minutes
    this.defaultIntervalSeconds = options.defaultIntervalSeconds ?? 5; // 5 seconds
  }

  /**
   * Generate an unambiguous user code (e.g. "WDJB-MJHT").
   * Excludes easily confused characters (0, O, 1, I, L).
   */
  private generateUserCode(): string {
    const charset = "BCDFGHJKMNPQRSTVWXYZ23456789";
    const bytes = randomBytes(8);
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += charset[bytes[i] % charset.length];
      if (i === 3) code += "-";
    }
    return code;
  }

  /**
   * Normalize user code input (trim, uppercase, add hyphen if missing).
   */
  private normalizeUserCode(input: string): string {
    const cleaned = input.replace(/[\s-]/g, "").toUpperCase();
    if (cleaned.length === 8) {
      return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
    }
    return input.trim().toUpperCase();
  }

  /**
   * 1. Initiate Device Authorization Flow (POST /v1/auth/device/code).
   */
  async initiate(
    request: DeviceAuthBootstrapRequest,
    customVerificationUri?: string,
  ): Promise<DeviceAuthBootstrapResponse> {
    const validated = DeviceAuthBootstrapRequestSchema.parse(request);

    // Verify that the device or installation is not already revoked
    if (await this.accountRepository.isDeviceRevoked(validated.deviceId)) {
      throw new TokenError("revoked_device", "Device is revoked", 403);
    }
    if (await this.accountRepository.isInstallationRevoked(validated.installationId)) {
      throw new TokenError("revoked_device", "Installation is revoked", 403);
    }

    const deviceCode = `dc_${randomBytes(32).toString("hex")}`;
    const userCode = this.generateUserCode();
    const now = Date.now();
    const expiresAt = now + this.defaultExpiresInSeconds * 1000;

    const session: DeviceFlowSession = {
      deviceCode,
      userCode,
      deviceId: validated.deviceId,
      installationId: validated.installationId,
      hostname: validated.hostname,
      platform: validated.platform,
      arch: validated.arch,
      clientVersion: validated.clientVersion,
      scopes: validated.scopes,
      status: "pending",
      interval: this.defaultIntervalSeconds,
      lastPollTime: 0,
      createdAt: now,
      expiresAt,
    };

    this.sessionsByDeviceCode.set(deviceCode, session);
    this.sessionsByUserCode.set(userCode, deviceCode);

    const baseUri = customVerificationUri ?? this.defaultVerificationUri;
    const verificationUriComplete = `${baseUri}?user_code=${encodeURIComponent(userCode)}`;

    return {
      deviceCode,
      userCode,
      verificationUri: baseUri,
      verificationUriComplete,
      expiresIn: this.defaultExpiresInSeconds,
      interval: this.defaultIntervalSeconds,
    };
  }

  /**
   * 2. Poll / Exchange Device Code for Tokens (POST /v1/auth/device/token).
   * Implements RFC 8628 rate limiting (slow_down), expiration, denial, and success.
   */
  async poll(request: DeviceTokenExchangeRequest): Promise<DeviceTokenExchangeResponse> {
    const validated = DeviceTokenExchangeRequestSchema.parse(request);
    const session = this.sessionsByDeviceCode.get(validated.deviceCode);

    if (!session) {
      throw new TokenError("invalid_grant", "Invalid or unknown device code", 400);
    }

    // Validate client identity consistency
    if (session.deviceId !== validated.deviceId) {
      throw new TokenError("invalid_grant", "Device ID does not match authorization request", 400);
    }
    if (session.installationId !== validated.installationId) {
      throw new TokenError("invalid_grant", "Installation ID does not match authorization request", 400);
    }

    const now = Date.now();

    // Check expiration
    if (now >= session.expiresAt || session.status === "expired") {
      session.status = "expired";
      throw new TokenError("expired_token", "Device authorization code has expired", 400);
    }

    // Rate Limiting / Slow Down Check (RFC 8628 Section 3.5)
    if (session.lastPollTime > 0) {
      const elapsedSeconds = (now - session.lastPollTime) / 1000;
      if (elapsedSeconds < session.interval) {
        // Increment polling interval by 5 seconds as specified by RFC 8628
        session.interval += 5;
        session.lastPollTime = now;
        throw new TokenError(
          "slow_down",
          `Polling too fast. Please increase polling interval to ${session.interval} seconds.`,
          400,
          session.interval,
        );
      }
    }
    session.lastPollTime = now;

    // Check status
    if (session.status === "pending") {
      throw new TokenError("authorization_pending", "Authorization is pending user approval", 400);
    }

    if (session.status === "denied") {
      this.sessionsByDeviceCode.delete(validated.deviceCode);
      this.sessionsByUserCode.delete(session.userCode);
      throw new TokenError("access_denied", "The user denied the authorization request", 400);
    }

    if (session.status === "authorized" && session.authorizedData) {
      const { accountId, workspaceId, userId, rawUploadConsent } = session.authorizedData;

      // Verify that device or installation was not revoked in the meantime
      if (await this.accountRepository.isDeviceRevoked(session.deviceId)) {
        throw new TokenError("revoked_device", "Device has been revoked", 403);
      }
      if (await this.accountRepository.isInstallationRevoked(session.installationId)) {
        throw new TokenError("revoked_device", "Installation has been revoked", 403);
      }

      // Register / update device and installation records in repository
      await this.accountRepository.createOrUpdateDevice({
        id: session.deviceId,
        accountId,
        workspaceId,
        installationId: session.installationId,
        name: `${session.hostname}-${session.platform}`,
        platform: session.platform,
        arch: session.arch,
        status: "active",
      });

      await this.accountRepository.createOrUpdateInstallation({
        id: session.installationId,
        deviceId: session.deviceId,
        accountId,
        workspaceId,
        clientVersion: session.clientVersion,
        hostname: session.hostname,
        status: "active",
      });

      // Update consent records
      await this.consentManager.setConsent({
        accountId,
        workspaceId,
        deviceId: session.deviceId,
        installationId: session.installationId,
        rawTranscriptUpload: rawUploadConsent ?? false,
        grantedByUserId: userId,
      });

      // Issue Access Token & Rotating Refresh Token Pair
      const tokenPair = await this.tokenService.issueTokenPair({
        accountId,
        workspaceId,
        deviceId: session.deviceId,
        installationId: session.installationId,
        scopes: session.scopes,
        rawUploadConsent: rawUploadConsent ?? false,
        subject: userId ?? accountId,
      });

      // Clean up consumed device session
      this.sessionsByDeviceCode.delete(validated.deviceCode);
      this.sessionsByUserCode.delete(session.userCode);

      return {
        accessToken: tokenPair.accessToken,
        tokenType: "Bearer",
        expiresIn: tokenPair.expiresIn,
        refreshToken: tokenPair.refreshToken,
        claims: tokenPair.claims,
      };
    }

    throw new TokenError("invalid_grant", "Invalid authorization state", 400);
  }

  /**
   * Authorize a pending device session by user code (called from web portal or CLI approval).
   */
  async authorizeUserCode(
    userCodeInput: string,
    authData: {
      accountId: string;
      workspaceId: string;
      userId?: string;
      rawUploadConsent?: boolean;
    },
  ): Promise<{ success: boolean; error?: string; session?: DeviceFlowSession }> {
    const userCode = this.normalizeUserCode(userCodeInput);
    const deviceCode = this.sessionsByUserCode.get(userCode);

    if (!deviceCode) {
      return { success: false, error: "Invalid user code" };
    }

    const session = this.sessionsByDeviceCode.get(deviceCode);
    if (!session) {
      return { success: false, error: "Session not found" };
    }

    if (Date.now() >= session.expiresAt || session.status === "expired") {
      session.status = "expired";
      return { success: false, error: "Code has expired" };
    }

    if (session.status !== "pending") {
      return { success: false, error: `Session is already ${session.status}` };
    }
    session.status = "authorized";
    session.lastPollTime = 0;
    session.authorizedData = authData;

    return { success: true, session };
  }

  /**
   * Deny a pending device session by user code.
   */
  async denyUserCode(userCodeInput: string): Promise<{ success: boolean; error?: string }> {
    const userCode = this.normalizeUserCode(userCodeInput);
    const deviceCode = this.sessionsByUserCode.get(userCode);

    if (!deviceCode) {
      return { success: false, error: "Invalid user code" };
    }

    const session = this.sessionsByDeviceCode.get(deviceCode);
    if (!session) {
      return { success: false, error: "Session not found" };
    }

    session.status = "denied";
    return { success: true };
  }

  /**
   * Inspect a session by user code.
   */
  getSessionByUserCode(userCodeInput: string): DeviceFlowSession | null {
    const userCode = this.normalizeUserCode(userCodeInput);
    const deviceCode = this.sessionsByUserCode.get(userCode);
    if (!deviceCode) return null;
    return this.sessionsByDeviceCode.get(deviceCode) ?? null;
  }

  /**
   * Inspect a session by device code.
   */
  getSessionByDeviceCode(deviceCode: string): DeviceFlowSession | null {
    return this.sessionsByDeviceCode.get(deviceCode) ?? null;
  }

  clear(): void {
    this.sessionsByDeviceCode.clear();
    this.sessionsByUserCode.clear();
  }
}
