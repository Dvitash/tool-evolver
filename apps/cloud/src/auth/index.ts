import { AuthConfig } from "../config.js";
import { ConsentManager } from "./consent.js";
import { DeviceFlowEngine } from "./device-flow.js";
import {
  DevelopmentIdentityProvider,
  IdentityProvider,
} from "./provider.js";
import {
  AccountRepository,
  MemoryAccountRepository,
} from "./repositories/account-repository.js";
import {
  MemoryTokenRepository,
  TokenRepository,
} from "./repositories/token-repository.js";
import { TokenService } from "./tokens.js";

export * from "./provider.js";
export * from "./consent.js";
export * from "./repositories/index.js";
export * from "./tokens.js";
export * from "./device-flow.js";
export * from "./middleware.js";
export * from "./routes.js";

/**
 * Options for initializing AuthService.
 */
export interface AuthServiceOptions {
  jwtSecret?: string;
  deviceTokenSecret?: string;
  issuer?: string;
  audience?: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  accountRepository?: AccountRepository;
  tokenRepository?: TokenRepository;
  identityProvider?: IdentityProvider;
  consentManager?: ConsentManager;
  config?: AuthConfig;
}

/**
 * Unified Authentication & Identity Service.
 */
export class AuthService {
  readonly identityProvider: IdentityProvider;
  readonly accountRepository: AccountRepository;
  readonly tokenRepository: TokenRepository;
  readonly consentManager: ConsentManager;
  readonly tokens: TokenService;
  readonly deviceFlow: DeviceFlowEngine;

  constructor(options: AuthServiceOptions = {}) {
    const config = options.config;
    const jwtSecret = options.jwtSecret ?? config?.jwtSecret ?? "dev-jwt-secret-min-16-characters-long";
    const issuer = options.issuer ?? config?.issuer ?? "tool-evolver-cloud";
    const audience = options.audience ?? config?.audience ?? "tool-evolver-client";
    const accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? config?.tokenTtlSeconds ?? 3600;

    this.accountRepository = options.accountRepository ?? new MemoryAccountRepository();
    this.tokenRepository = options.tokenRepository ?? new MemoryTokenRepository();
    this.identityProvider = options.identityProvider ?? new DevelopmentIdentityProvider();
    this.consentManager = options.consentManager ?? new ConsentManager();

    this.tokens = new TokenService({
      jwtSecret,
      deviceTokenSecret: options.deviceTokenSecret ?? config?.deviceTokenSecret,
      issuer,
      audience,
      accessTokenTtlSeconds,
      refreshTokenTtlSeconds: options.refreshTokenTtlSeconds ?? 2592000,
      tokenRepository: this.tokenRepository,
      accountRepository: this.accountRepository,
    });

    this.deviceFlow = new DeviceFlowEngine({
      tokenService: this.tokens,
      accountRepository: this.accountRepository,
      consentManager: this.consentManager,
      defaultExpiresInSeconds: 900,
      defaultIntervalSeconds: 5,
    });
  }

  /**
   * Revoke a device and its installation and token family.
   */
  async revokeDevice(deviceId: string, installationId?: string, reason?: string): Promise<void> {
    await this.tokens.revokeDevice(deviceId, reason);
    if (installationId) {
      await this.tokens.revokeInstallation(installationId, reason);
    }
  }

  /**
   * Revoke an installation identity.
   */
  async revokeInstallation(installationId: string, reason?: string): Promise<void> {
    await this.tokens.revokeInstallation(installationId, reason);
  }
}

/**
 * Factory function creating an AuthService instance.
 */
export function createAuthService(options: AuthServiceOptions = {}): AuthService {
  return new AuthService(options);
}
