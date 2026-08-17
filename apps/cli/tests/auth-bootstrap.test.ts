import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SecretManager } from "@tool-evolver/crypto";
import type {
  DeviceAuthBootstrapResponse,
  DeviceTokenExchangeResponse,
} from "@tool-evolver/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceAuthClient } from "../src/service/auth-bootstrap.js";

describe("DeviceAuthClient & Auth Bootstrap", () => {
  let tempDir: string;
  let tokenFilePath: string;
  let vaultPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "te-auth-test-"));
    tokenFilePath = path.join(tempDir, "device-token.json");
    vaultPath = path.join(tempDir, "vault.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("requests device authorization code from cloud endpoint", async () => {
    const mockBootstrapResponse: DeviceAuthBootstrapResponse = {
      deviceCode: "device_code_1234567890abcdef",
      userCode: "ABCD-9876",
      verificationUri: "https://auth.tool-evolver.dev/device",
      verificationUriComplete: "https://auth.tool-evolver.dev/device?code=ABCD-9876",
      expiresIn: 900,
      interval: 1,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockBootstrapResponse,
    } as Response);

    const client = new DeviceAuthClient({
      cloudUrl: "https://mock-cloud.tool-evolver.dev",
      customFetch: mockFetch as unknown as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    const response = await client.requestDeviceCode({
      deviceId: "dev_mock_test",
      workspaceId: "ws_test_1",
    });

    expect(response.userCode).toBe("ABCD-9876");
    expect(response.deviceCode).toBe("device_code_1234567890abcdef");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mock-cloud.tool-evolver.dev/api/v1/auth/device/code",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("polls for token exchange handling pending state and returning tokens", async () => {
    const mockTokenResponse: DeviceTokenExchangeResponse = {
      accessToken: "atk_live_test_access_token_12345",
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken: "rtk_live_test_refresh_token_67890",
      claims: {
        accountId: "acc_test_user",
        deviceId: "dev_mock_test",
        installationId: "inst_test",
        workspaceId: "ws_test_1",
        scopes: ["device:connect", "observations:write", "catalog:read", "artifacts:read"],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        tokenType: "access",
      },
    };

    let pollCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) {
        return {
          ok: false,
          json: async () => ({ error: "authorization_pending" }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => mockTokenResponse,
      } as Response;
    });

    const client = new DeviceAuthClient({
      cloudUrl: "https://mock-cloud.tool-evolver.dev",
      customFetch: mockFetch as unknown as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    const tokenResult = await client.pollTokenExchange({
      deviceCode: "device_code_1234567890abcdef",
      deviceId: "dev_mock_test",
      interval: 0.05, // 50ms for fast tests
      timeoutMs: 2000,
    });

    expect(tokenResult.accessToken).toBe("atk_live_test_access_token_12345");
    expect(tokenResult.refreshToken).toBe("rtk_live_test_refresh_token_67890");
    expect(tokenResult.claims.workspaceId).toBe("ws_test_1");
    expect(pollCount).toBe(2);
  });

  it("handles authorization errors: expired_token and access_denied", async () => {
    const mockExpiredFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "expired_token" }),
    } as Response);

    const client1 = new DeviceAuthClient({
      customFetch: mockExpiredFetch as unknown as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    await expect(
      client1.pollTokenExchange({
        deviceCode: "device_code_expired",
        deviceId: "dev_1",
        interval: 0.01,
      }),
    ).rejects.toThrow("Device code has expired");

    const mockDeniedFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "access_denied" }),
    } as Response);

    const client2 = new DeviceAuthClient({
      customFetch: mockDeniedFetch as unknown as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    await expect(
      client2.pollTokenExchange({
        deviceCode: "device_code_denied",
        deviceId: "dev_1",
        interval: 0.01,
      }),
    ).rejects.toThrow("Device authorization was denied by user");
  });

  it("stores, loads, and purges credentials securely", async () => {
    const mockTokenResponse: DeviceTokenExchangeResponse = {
      accessToken: "atk_secure_stored_token",
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken: "rtk_secure_stored_refresh_token",
      claims: {
        accountId: "acc_1",
        deviceId: "dev_test",
        installationId: "inst_test",
        workspaceId: "ws_secure_1",
        scopes: ["device:connect", "observations:write", "catalog:read", "artifacts:read"],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        tokenType: "access",
      },
    };

    const client = new DeviceAuthClient({
      tokenFilePath,
      vaultPath,
      passphrase: "test-passphrase-1234",
    });

    // 1. Store credentials
    const storeRes = await client.storeCredentials(mockTokenResponse, "dev_test", "ws_secure_1");
    expect(storeRes.storedInSecretStore).toBe(true);
    expect(storeRes.tokenFilePath).toBe(tokenFilePath);

    // Verify token file was written
    const fileContent = await fs.readFile(tokenFilePath, "utf8");
    const parsedFile = JSON.parse(fileContent);
    expect(parsedFile.accessToken).toBe("atk_secure_stored_token");
    expect(parsedFile.workspaceId).toBe("ws_secure_1");

    // 2. Load credentials
    const loaded = await client.loadCredentials();
    expect(loaded).not.toBeNull();
    expect(loaded?.accessToken).toBe("atk_secure_stored_token");
    expect(loaded?.workspaceId).toBe("ws_secure_1");

    // 3. Purge credentials
    const purgeRes = await client.purgeCredentials();
    expect(purgeRes.purgedSecrets).toBe(true);
    expect(purgeRes.purgedFile).toBe(true);

    // Verify token file removed
    const fileExists = await fs
      .stat(tokenFilePath)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(false);
  });

  it("completes full bootstrap workflow end-to-end with user notification", async () => {
    const mockBootstrapResponse: DeviceAuthBootstrapResponse = {
      deviceCode: "device_code_full_bootstrap",
      userCode: "BOOT-1234",
      verificationUri: "https://auth.tool-evolver.dev/device",
      expiresIn: 900,
      interval: 1,
    };

    const mockTokenResponse: DeviceTokenExchangeResponse = {
      accessToken: "atk_full_bootstrap_token",
      refreshToken: "rtk_full_bootstrap_token",
      tokenType: "Bearer",
      expiresIn: 3600,
      claims: {
        accountId: "acc_bootstrap",
        deviceId: "dev_bootstrap",
        installationId: "inst_bootstrap",
        workspaceId: "ws_bootstrap",
        scopes: ["device:connect", "observations:write", "catalog:read", "artifacts:read"],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        tokenType: "access",
      },
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/auth/device/code")) {
        return { ok: true, json: async () => mockBootstrapResponse } as Response;
      }
      if (url.includes("/api/v1/auth/device/token")) {
        return { ok: true, json: async () => mockTokenResponse } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const client = new DeviceAuthClient({
      cloudUrl: "https://auth-cloud.tool-evolver.dev",
      customFetch: mockFetch as unknown as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    let notifiedUserCode = "";
    const bootstrapResult = await client.bootstrap({
      deviceId: "dev_bootstrap",
      workspaceId: "ws_bootstrap",
      pollIntervalMs: 20,
      onUserCodeReceived: (info) => {
        notifiedUserCode = info.userCode;
      },
    });

    expect(bootstrapResult.success).toBe(true);
    expect(bootstrapResult.accessToken).toBe("atk_full_bootstrap_token");
    expect(bootstrapResult.workspaceId).toBe("ws_bootstrap");
    expect(notifiedUserCode).toBe("BOOT-1234");
  });
});
