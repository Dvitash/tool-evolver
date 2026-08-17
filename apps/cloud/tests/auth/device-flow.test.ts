import { describe, expect, it } from "vitest";
import { AuthService, createAuthService } from "../../src/auth/index.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool } from "../../src/db/index.js";
import { MemoryDurableQueue } from "../../src/queue/index.js";
import { CloudServer, createCloudServer } from "../../src/server/index.js";
import { MemoryObjectStore } from "../../src/storage/index.js";

describe("RFC 8628 Device Authorization Flow Engine", () => {
  it("should initiate device authorization flow and return valid codes", async () => {
    const auth = createAuthService();

    const response = await auth.deviceFlow.initiate({
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
      hostname: "developer-laptop",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "1.0.0",
      scopes: ["device:connect", "observations:write"],
    });

    expect(response.deviceCode).toMatch(/^dc_[a-f0-9]{64}$/);
    expect(response.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(response.verificationUri).toContain("/device");
    expect(response.verificationUriComplete).toContain(encodeURIComponent(response.userCode));
    expect(response.expiresIn).toBe(900);
    expect(response.interval).toBe(5);
  });

  it("should return authorization_pending when polled before user approval", async () => {
    const auth = createAuthService();

    const init = await auth.deviceFlow.initiate({
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
      hostname: "developer-laptop",
      platform: "linux",
      arch: "x64",
      clientVersion: "1.0.0",
      scopes: ["device:connect"],
    });

    await expect(
      auth.deviceFlow.poll({
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
        deviceCode: init.deviceCode,
        deviceId: "dev_01JABCDEF0123456",
        installationId: "inst_01JABCDEF0123456",
      }),
    ).rejects.toThrow(/Authorization is pending/);
  });

  it("should enforce RFC 8628 rate limiting (slow_down) when polled too frequently", async () => {
    const auth = createAuthService();

    const init = await auth.deviceFlow.initiate({
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
      hostname: "developer-laptop",
      platform: "linux",
      arch: "x64",
      clientVersion: "1.0.0",
      scopes: ["device:connect"],
    });

    // First poll -> pending
    try {
      await auth.deviceFlow.poll({
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
        deviceCode: init.deviceCode,
        deviceId: "dev_01JABCDEF0123456",
        installationId: "inst_01JABCDEF0123456",
      });
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe("authorization_pending");
    }

    // Immediate second poll -> slow_down with incremented interval (+5s = 10s)
    try {
      await auth.deviceFlow.poll({
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
        deviceCode: init.deviceCode,
        deviceId: "dev_01JABCDEF0123456",
        installationId: "inst_01JABCDEF0123456",
      });
      expect.fail("Expected slow_down error");
    } catch (err: unknown) {
      const error = err as { code: string; interval: number };
      expect(error.code).toBe("slow_down");
      expect(error.interval).toBe(10);
    }
  });

  it("should complete token exchange when user authorizes the code", async () => {
    const auth = createAuthService();

    const init = await auth.deviceFlow.initiate({
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
      hostname: "developer-laptop",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "1.0.0",
      scopes: ["device:connect", "observations:write", "catalog:read"],
    });

    // User approves via web portal or CLI
    const authResult = await auth.deviceFlow.authorizeUserCode(init.userCode, {
      accountId: "acc_enterprise_01",
      workspaceId: "ws_production_01",
      userId: "usr_alice_01",
      rawUploadConsent: true,
    });
    expect(authResult.success).toBe(true);

    // Client polls for tokens
    const tokens = await auth.deviceFlow.poll({
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: init.deviceCode,
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
    });

    expect(tokens.accessToken).toBeDefined();
    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.refreshToken).toMatch(/^rt_[a-f0-9]{64}$/);
    expect(tokens.claims.accountId).toBe("acc_enterprise_01");
    expect(tokens.claims.workspaceId).toBe("ws_production_01");
    expect(tokens.claims.deviceId).toBe("dev_01JABCDEF0123456");
    expect(tokens.claims.rawUploadConsent).toBe(true);

    // Verify device record was saved in account repository
    const device = await auth.accountRepository.getDevice("dev_01JABCDEF0123456");
    expect(device).not.toBeNull();
    expect(device?.status).toBe("active");
  });

  it("should handle user denial properly (access_denied)", async () => {
    const auth = createAuthService();

    const init = await auth.deviceFlow.initiate({
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
      hostname: "developer-laptop",
      platform: "linux",
      arch: "x64",
      clientVersion: "1.0.0",
      scopes: ["device:connect"],
    });

    // User denies authorization
    const denyResult = await auth.deviceFlow.denyUserCode(init.userCode);
    expect(denyResult.success).toBe(true);

    // Client poll returns access_denied
    try {
      await auth.deviceFlow.poll({
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
        deviceCode: init.deviceCode,
        deviceId: "dev_01JABCDEF0123456",
        installationId: "inst_01JABCDEF0123456",
      });
      expect.fail("Expected access_denied error");
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe("access_denied");
    }
  });

  it("should reject polling with mismatched deviceId", async () => {
    const auth = createAuthService();

    const init = await auth.deviceFlow.initiate({
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
      hostname: "developer-laptop",
      platform: "linux",
      arch: "x64",
      clientVersion: "1.0.0",
      scopes: ["device:connect"],
    });

    await expect(
      auth.deviceFlow.poll({
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
        deviceCode: init.deviceCode,
        deviceId: "dev_different_device",
        installationId: "inst_01JABCDEF0123456",
      }),
    ).rejects.toThrow(/Device ID does not match/);
  });
});

describe("End-to-End Device Auth HTTP Routes", () => {
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

  it("should complete full HTTP device authorization lifecycle", async () => {
    const { baseUrl, stop } = await setupServer();
    try {
      // 1. Initiate Device Flow (POST /v1/auth/device/code)
      const initRes = await fetch(`${baseUrl}/v1/auth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "dev_01JABCDEF0123456",
          installationId: "inst_01JABCDEF0123456",
          hostname: "test-node",
          platform: "linux",
          arch: "arm64",
          clientVersion: "1.0.0",
        }),
      });

      expect(initRes.status).toBe(200);
      const initData = (await initRes.json()) as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        verificationUriComplete: string;
      };

      expect(initData.deviceCode).toBeDefined();
      expect(initData.userCode).toBeDefined();

      // 2. Poll before authorization -> 400 authorization_pending
      const pollPendingRes = await fetch(`${baseUrl}/v1/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          deviceCode: initData.deviceCode,
          deviceId: "dev_01JABCDEF0123456",
          installationId: "inst_01JABCDEF0123456",
        }),
      });

      expect(pollPendingRes.status).toBe(400);
      const pollPendingData = (await pollPendingRes.json()) as { error: string };
      expect(pollPendingData.error).toBe("authorization_pending");

      // 3. User verification lookup (GET /v1/auth/device/verify?user_code=...)
      const verifyRes = await fetch(
        `${baseUrl}/v1/auth/device/verify?user_code=${initData.userCode}`,
      );
      expect(verifyRes.status).toBe(200);
      const verifyData = (await verifyRes.json()) as { userCode: string; status: string };
      expect(verifyData.userCode).toBe(initData.userCode);
      expect(verifyData.status).toBe("pending");

      // 4. User Authorizes (POST /v1/auth/device/authorize)
      const authRes = await fetch(`${baseUrl}/v1/auth/device/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userCode: initData.userCode,
          accountId: "acc_acme_corp",
          workspaceId: "ws_main",
          userId: "usr_bob",
          rawUploadConsent: false,
        }),
      });

      expect(authRes.status).toBe(200);
      const authData = (await authRes.json()) as { authorized: boolean };
      expect(authData.authorized).toBe(true);

      // 5. Successful Token Exchange (POST /v1/auth/device/token)
      const tokenRes = await fetch(`${baseUrl}/v1/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          deviceCode: initData.deviceCode,
          deviceId: "dev_01JABCDEF0123456",
          installationId: "inst_01JABCDEF0123456",
        }),
      });

      expect(tokenRes.status).toBe(200);
      const tokenData = (await tokenRes.json()) as {
        accessToken: string;
        refreshToken: string;
        claims: { accountId: string; workspaceId: string };
      };
      expect(tokenData.accessToken).toBeDefined();
      expect(tokenData.refreshToken).toBeDefined();
      expect(tokenData.claims.accountId).toBe("acc_acme_corp");
      expect(tokenData.claims.workspaceId).toBe("ws_main");

      // 6. Access protected API endpoint using the newly issued Bearer token
      const protectedRes = await fetch(`${baseUrl}/v1/devices`, {
        headers: {
          Authorization: `Bearer ${tokenData.accessToken}`,
        },
      });
      expect(protectedRes.status).toBe(200);
    } finally {
      await stop();
    }
  });
});
