import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { SecretManager } from "@tool-evolver/crypto";
import { resolvePaths } from "@tool-evolver/observer";
import {
  type AuthClaims,
  type AuthScope,
  AuthScopeSchema,
  type DeviceAuthBootstrapRequest,
  DeviceAuthBootstrapRequestSchema,
  type DeviceAuthBootstrapResponse,
  DeviceAuthBootstrapResponseSchema,
  type DeviceTokenExchangeRequest,
  DeviceTokenExchangeRequestSchema,
  type DeviceTokenExchangeResponse,
  DeviceTokenExchangeResponseSchema,
  areClaimsExpired,
} from "@tool-evolver/protocol";

export const DEFAULT_CLOUD_URL = "https://api.tool-evolver.dev";
export const DEFAULT_DEVICE_SCOPES: AuthScope[] = [
  "device:connect",
  "observations:write",
  "catalog:read",
  "artifacts:read",
];

export interface DeviceAuthClientOptions {
  cloudUrl?: string;
  customFetch?: typeof fetch;
  secretManager?: SecretManager;
  tokenFilePath?: string;
  vaultPath?: string;
  passphrase?: string;
}

export interface DeviceAuthRequestParams {
  deviceId?: string;
  deviceLabel?: string;
  requestedScopes?: AuthScope[];
  workspaceId?: string;
  clientVersion?: string;
}

export interface DeviceAuthBootstrapOptions extends DeviceAuthRequestParams {
  interactive?: boolean;
  onUserCodeReceived?: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
  }) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface DeviceAuthBootstrapResult {
  success: boolean;
  deviceId: string;
  workspaceId: string;
  accessToken: string;
  refreshToken?: string;
  claims: AuthClaims;
  storedInSecretStore: boolean;
  tokenFilePath?: string;
  error?: string;
}

export interface StoredDeviceCredentials {
  accessToken: string;
  refreshToken?: string;
  claims: AuthClaims;
  deviceId: string;
  workspaceId: string;
  storedAt: string;
}

export class DeviceAuthClient {
  private readonly cloudUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly secretManager: SecretManager;
  private readonly tokenFilePath?: string;

  constructor(options: DeviceAuthClientOptions = {}) {
    this.cloudUrl = (
      options.cloudUrl ??
      process.env.TOOL_EVOLVER_CLOUD_URL ??
      DEFAULT_CLOUD_URL
    ).replace(/\/+$/, "");
    this.fetchImpl = options.customFetch ?? globalThis.fetch;
    this.tokenFilePath = options.tokenFilePath;

    this.secretManager =
      options.secretManager ??
      new SecretManager({
        vaultPath: options.vaultPath,
        passphrase: options.passphrase ?? "tool-evolver-device-vault-key",
      });
  }

  getSecretManager(): SecretManager {
    return this.secretManager;
  }

  async requestDeviceCode(
    params: DeviceAuthRequestParams = {},
  ): Promise<DeviceAuthBootstrapResponse> {
    const deviceId =
      params.deviceId ??
      `dev_${os
        .hostname()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")}`;
    const installationId = `inst_${os
      .hostname()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")}`;
    const hostname = os.hostname() || "localhost";
    const platform =
      process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "other";
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "other";
    const clientVersion = params.clientVersion ?? "0.1.0";
    const scopes = params.requestedScopes ?? DEFAULT_DEVICE_SCOPES;

    const requestPayload: DeviceAuthBootstrapRequest = {
      deviceId,
      installationId,
      hostname,
      platform,
      arch,
      clientVersion,
      scopes,
    };

    DeviceAuthBootstrapRequestSchema.parse(requestPayload);

    const endpoint = `${this.cloudUrl}/api/v1/auth/device/code`;
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Device code request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return DeviceAuthBootstrapResponseSchema.parse(data);
  }

  async pollTokenExchange(params: {
    deviceCode: string;
    deviceId: string;
    installationId?: string;
    interval?: number;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<DeviceTokenExchangeResponse> {
    const intervalMs = Math.max(1000, (params.interval ?? 5) * 1000);
    const timeoutMs = params.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    let currentInterval = intervalMs;

    const requestPayload: DeviceTokenExchangeRequest = {
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: params.deviceCode,
      deviceId: params.deviceId,
      installationId: params.installationId ?? `inst_${params.deviceId}`,
    };
    DeviceTokenExchangeRequestSchema.parse(requestPayload);

    const endpoint = `${this.cloudUrl}/api/v1/auth/device/token`;

    while (Date.now() < deadline) {
      if (params.abortSignal?.aborted) {
        throw new Error("Device authorization was cancelled");
      }

      await new Promise<void>((resolve) => setTimeout(resolve, currentInterval));

      if (params.abortSignal?.aborted) {
        throw new Error("Device authorization was cancelled");
      }

      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (response.ok && data.accessToken) {
        return DeviceTokenExchangeResponseSchema.parse(data);
      }

      const errorCode = (data.error as string) || "";

      if (errorCode === "authorization_pending") {
        continue;
      }
      if (errorCode === "slow_down") {
        currentInterval += 5000;
        continue;
      }
      if (errorCode === "expired_token") {
        throw new Error("Device code has expired. Please restart authorization.");
      }
      if (errorCode === "access_denied") {
        throw new Error("Device authorization was denied by user.");
      }

      const desc =
        (data.errorDescription as string) || (data.error as string) || response.statusText;
      throw new Error(`Device token exchange failed: ${desc}`);
    }

    throw new Error(`Device authorization timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  async storeCredentials(
    tokenResponse: DeviceTokenExchangeResponse,
    deviceId: string,
    workspaceId: string,
  ): Promise<{ storedInSecretStore: boolean; tokenFilePath?: string }> {
    let storedInSecretStore = false;

    // 1. Store in SecretManager
    try {
      await this.secretManager.addSecret("cloud_device_access_token", tokenResponse.accessToken, {
        description: "Tool Evolver Cloud Device Access Token",
        workspaceId,
      });

      if (tokenResponse.refreshToken) {
        await this.secretManager.addSecret(
          "cloud_device_refresh_token",
          tokenResponse.refreshToken,
          {
            description: "Tool Evolver Cloud Device Refresh Token",
            workspaceId,
          },
        );
      }
      storedInSecretStore = true;
    } catch {
      storedInSecretStore = false;
    }

    // 2. Write to token file if path configured or default daemon paths
    let writtenFilePath: string | undefined;
    try {
      const paths = resolvePaths();
      const tokenPath = this.tokenFilePath ?? paths.tokenFilePath;

      const creds: StoredDeviceCredentials = {
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        claims: tokenResponse.claims,
        deviceId,
        workspaceId,
        storedAt: new Date().toISOString(),
      };

      await fs.mkdir(path.dirname(tokenPath), { recursive: true });
      await fs.writeFile(tokenPath, JSON.stringify(creds, null, 2), {
        mode: 0o600,
        encoding: "utf8",
      });
      writtenFilePath = tokenPath;
    } catch {
      // Ignored if unable to write file
    }

    return { storedInSecretStore, tokenFilePath: writtenFilePath };
  }

  async bootstrap(options: DeviceAuthBootstrapOptions = {}): Promise<DeviceAuthBootstrapResult> {
    const deviceId =
      options.deviceId ??
      `dev_${os
        .hostname()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")}`;
    const workspaceId = options.workspaceId ?? "ws_default";

    try {
      // 1. Request device code
      const bootstrapResponse = await this.requestDeviceCode({
        ...options,
        deviceId,
        workspaceId,
      });

      // 2. Notify caller of user code and verification URI
      if (options.onUserCodeReceived) {
        options.onUserCodeReceived({
          userCode: bootstrapResponse.userCode,
          verificationUri: bootstrapResponse.verificationUri,
          verificationUriComplete: bootstrapResponse.verificationUriComplete,
          expiresIn: bootstrapResponse.expiresIn,
        });
      } else if (options.interactive !== false) {
        process.stdout.write("\n=======================================================\n");
        process.stdout.write(" Tool Evolver Cloud Device Authentication\n");
        process.stdout.write("=======================================================\n");
        process.stdout.write(
          `\n1. Navigate to: ${bootstrapResponse.verificationUriComplete || bootstrapResponse.verificationUri}\n`,
        );
        process.stdout.write(`2. Enter code:   ${bootstrapResponse.userCode}\n\n`);
        process.stdout.write("Waiting for device authorization in browser...\n\n");
      }

      // 3. Poll for token exchange
      const tokenResponse = await this.pollTokenExchange({
        deviceCode: bootstrapResponse.deviceCode,
        deviceId,
        interval: options.pollIntervalMs
          ? options.pollIntervalMs / 1000
          : bootstrapResponse.interval,
        timeoutMs: options.timeoutMs ?? bootstrapResponse.expiresIn * 1000,
        abortSignal: options.abortSignal,
      });

      // 4. Store credentials securely
      const storageResult = await this.storeCredentials(tokenResponse, deviceId, workspaceId);

      return {
        success: true,
        deviceId,
        workspaceId,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        claims: tokenResponse.claims,
        storedInSecretStore: storageResult.storedInSecretStore,
        tokenFilePath: storageResult.tokenFilePath,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        deviceId,
        workspaceId,
        accessToken: "",
        claims: {
          accountId: "acc_default",
          deviceId,
          installationId: "inst_default",
          workspaceId,
          scopes: ["device:connect"],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          tokenType: "access",
        },
        storedInSecretStore: false,
        error: msg,
      };
    }
  }

  async loadCredentials(): Promise<StoredDeviceCredentials | null> {
    // 1. Try reading from token file
    try {
      const paths = resolvePaths();
      const tokenPath = this.tokenFilePath ?? paths.tokenFilePath;
      const content = await fs.readFile(tokenPath, "utf8");
      const parsed = JSON.parse(content) as StoredDeviceCredentials;
      if (parsed.accessToken && parsed.claims) {
        return parsed;
      }
    } catch {
      // Fall through to SecretManager
    }

    // 2. Try SecretManager
    try {
      const store = this.secretManager.getStore();
      const accessToken = await store.getSecret("cloud_device_access_token");
      if (accessToken) {
        const metadataList = await this.secretManager.listMetadata();
        const metadata = metadataList.find(
          (s) => s.name === "cloud_device_access_token" || s.alias === "cloud_device_access_token",
        );
        const refreshToken = await store.getSecret("cloud_device_refresh_token");

        const scopes: AuthScope[] = [
          "device:connect",
          "observations:write",
          "catalog:read",
          "artifacts:read",
        ];
        const createdAtIso = metadata?.createdAt
          ? new Date(metadata.createdAt).toISOString()
          : new Date().toISOString();
        const expiresAtIso = new Date(Date.now() + 86400000).toISOString();
        return {
          accessToken,
          refreshToken: refreshToken ?? undefined,
          claims: {
            accountId: "acc_default",
            deviceId: "stored_device",
            installationId: "inst_stored",
            workspaceId: metadata?.workspaceId ?? "ws_default",
            scopes,
            rawUploadConsent: false,
            issuedAt: createdAtIso,
            expiresAt: expiresAtIso,
            tokenType: "access",
          },
          deviceId: "stored_device",
          workspaceId: metadata?.workspaceId ?? "ws_default",
          storedAt: createdAtIso,
        };
      }
    } catch {
      // Return null
    }

    return null;
  }

  async purgeCredentials(): Promise<{ purgedSecrets: boolean; purgedFile: boolean }> {
    let purgedSecrets = false;
    let purgedFile = false;

    try {
      await this.secretManager.deleteSecret("cloud_device_access_token");
      await this.secretManager.deleteSecret("cloud_device_refresh_token");
      purgedSecrets = true;
    } catch {
      purgedSecrets = false;
    }

    try {
      const paths = resolvePaths();
      const tokenPath = this.tokenFilePath ?? paths.tokenFilePath;
      await fs.unlink(tokenPath);
      purgedFile = true;
    } catch {
      purgedFile = false;
    }

    return { purgedSecrets, purgedFile };
  }

  async revokeToken(token?: string): Promise<boolean> {
    const creds = token ? null : await this.loadCredentials();
    const tokenToRevoke = token ?? creds?.accessToken;
    if (!tokenToRevoke) {
      return false;
    }

    try {
      const endpoint = `${this.cloudUrl}/api/v1/auth/revoke`;
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenToRevoke}`,
        },
        body: JSON.stringify({ token: tokenToRevoke }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
