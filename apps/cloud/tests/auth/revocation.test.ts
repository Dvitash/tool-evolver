import { describe, expect, it } from "vitest";
import {
  AuthService,
  createAuthService,
} from "../../src/auth/index.js";
import { CloudServer, createCloudServer } from "../../src/server/index.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool } from "../../src/db/index.js";
import { MemoryDurableQueue } from "../../src/queue/index.js";
import { MemoryObjectStore } from "../../src/storage/index.js";

describe("Device and Installation Revocation", () => {
  it("should revoke device and immediately reject access tokens and rotations", async () => {
    const auth = createAuthService();

    // 1. Issue token pair for device
    const pair = await auth.tokens.issueTokenPair({
      accountId: "acc_01JABCDEF0123456",
      workspaceId: "ws_01JABCDEF0123456",
      deviceId: "dev_target_to_revoke",
      installationId: "inst_target_to_revoke",
      scopes: ["device:connect"],
    });

    // Verify token is initially valid
    const initialVerify = await auth.tokens.verifyAccessToken(pair.accessToken);
    expect(initialVerify.valid).toBe(true);

    // 2. Revoke the device
    await auth.revokeDevice("dev_target_to_revoke", "inst_target_to_revoke", "Security audit revocation");

    // 3. Check token repository and account repository
    expect(await auth.tokenRepository.isDeviceRevoked("dev_target_to_revoke")).toBe(true);
    expect(await auth.accountRepository.isDeviceRevoked("dev_target_to_revoke")).toBe(true);

    // 4. Verify access token is NOW immediately rejected
    const postRevokeVerify = await auth.tokens.verifyAccessToken(pair.accessToken);
    expect(postRevokeVerify.valid).toBe(false);
    expect(postRevokeVerify.code).toBe("revoked_device");

    // 5. Verify refresh token rotation fails
    await expect(
      auth.tokens.rotateRefreshToken({
        grantType: "refresh_token",
        refreshToken: pair.refreshToken,
        deviceId: "dev_target_to_revoke",
        installationId: "inst_target_to_revoke",
      }),
    ).rejects.toThrow(/revoked/i);
  });

  it("should reject installation tokens when installation is revoked", async () => {
    const auth = createAuthService();

    const pair = await auth.tokens.issueTokenPair({
      accountId: "acc_01JABCDEF0123456",
      workspaceId: "ws_01JABCDEF0123456",
      deviceId: "dev_valid_device",
      installationId: "inst_to_revoke",
      scopes: ["device:connect"],
    });

    expect((await auth.tokens.verifyAccessToken(pair.accessToken)).valid).toBe(true);

    // Revoke installation
    await auth.revokeInstallation("inst_to_revoke", "Stolen binary");

    // Verify access token is rejected
    const result = await auth.tokens.verifyAccessToken(pair.accessToken);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("revoked_device");
  });
});

describe("End-to-End Revocation HTTP & Stream Blocking", () => {
  async function setupServer() {
    const dbPool = new MemoryDatabasePool();
    const objectStore = new MemoryObjectStore();
    const queue = new MemoryDurableQueue();
    const authService = createAuthService();

    const config = loadConfig({
      server: { port: 0, host: "127.0.0.1" },
    });

    const server = createCloudServer({
      config,
      dbPool,
      objectStore,
      queue,
      authService,
    });

    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
      server,
      baseUrl,
      authService,
      stop: () => server.stop(),
    };
  }

  it("should revoke device via POST /v1/auth/device/revoke and block subsequent API access", async () => {
    const { baseUrl, authService, stop } = await setupServer();
    try {
      const pair = await authService.tokens.issueTokenPair({
        accountId: "acc_01JABCDEF0123456",
        workspaceId: "ws_01JABCDEF0123456",
        deviceId: "dev_active_device_01",
        installationId: "inst_active_01",
        scopes: ["device:connect"],
      });

      // 1. Successful API call before revocation
      const okRes = await fetch(`${baseUrl}/v1/devices`, {
        headers: { Authorization: `Bearer ${pair.accessToken}` },
      });
      expect(okRes.status).toBe(200);

      // 2. Revoke device via API endpoint
      const revokeRes = await fetch(`${baseUrl}/v1/auth/device/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "dev_active_device_01",
          installationId: "inst_active_01",
        }),
      });
      expect(revokeRes.status).toBe(200);
      const revokeData = (await revokeRes.json()) as { revoked: boolean; deviceId: string };
      expect(revokeData.revoked).toBe(true);
      expect(revokeData.deviceId).toBe("dev_active_device_01");

      // 3. Subsequent API call with same access token MUST return 403 Forbidden
      const blockedRes = await fetch(`${baseUrl}/v1/devices`, {
        headers: { Authorization: `Bearer ${pair.accessToken}` },
      });
      expect(blockedRes.status).toBe(403);
      const blockedData = (await blockedRes.json()) as { error: string };
      expect(blockedData.error).toBe("REVOKED_DEVICE");
    } finally {
      await stop();
    }
  });
});
