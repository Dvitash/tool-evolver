import { describe, expect, it } from "vitest";
import {
  AuthService,
  createAuthService,
  signJwt,
  verifyJwt,
} from "../../src/auth/index.js";
import { CloudServer, createCloudServer } from "../../src/server/index.js";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool } from "../../src/db/index.js";
import { MemoryDurableQueue } from "../../src/queue/index.js";
import { MemoryObjectStore } from "../../src/storage/index.js";

describe("JWT & Token Management Lifecycle", () => {
  const secret = "test-jwt-secret-at-least-16-chars-long";

  it("should sign and verify valid JWT tokens", () => {
    const payload = {
      sub: "usr_123",
      accountId: "acc_abc",
      workspaceId: "ws_xyz",
      scopes: ["device:connect"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };

    const token = signJwt(payload, secret);
    expect(token.split(".")).toHaveLength(3);

    const result = verifyJwt(token, secret);
    expect(result.valid).toBe(true);
    expect(result.payload).toMatchObject(payload);
  });

  it("should reject tampered JWT token signatures", () => {
    const payload = {
      sub: "usr_123",
      accountId: "acc_abc",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };

    const token = signJwt(payload, secret);
    const parts = token.split(".");
    // Tamper with payload
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, sub: "usr_attacker" })).toString("base64url");
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const result = verifyJwt(tamperedToken, secret);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("signature");
  });

  it("should reject expired access tokens", () => {
    const payload = {
      sub: "usr_123",
      accountId: "acc_abc",
      expiresAt: new Date(Date.now() - 10000).toISOString(), // 10s in the past
    };

    const token = signJwt(payload, secret);
    const result = verifyJwt(token, secret);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("expired_token");
  });

  it("should issue and rotate refresh tokens sequentially", async () => {
    const auth = createAuthService();

    // 1. Issue initial token pair
    const initialPair = await auth.tokens.issueTokenPair({
      accountId: "acc_01JABCDEF0123456",
      workspaceId: "ws_01JABCDEF0123456",
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
      scopes: ["device:connect", "observations:write"],
    });

    expect(initialPair.refreshToken).toBeDefined();
    expect(initialPair.accessToken).toBeDefined();

    // Verify initial access token
    const verifyInitial = await auth.tokens.verifyAccessToken(initialPair.accessToken);
    expect(verifyInitial.valid).toBe(true);
    expect(verifyInitial.claims?.accountId).toBe("acc_01JABCDEF0123456");

    // 2. Rotate once
    const rotation1 = await auth.tokens.rotateRefreshToken({
      grantType: "refresh_token",
      refreshToken: initialPair.refreshToken,
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
    });

    expect(rotation1.refreshToken).not.toBe(initialPair.refreshToken);
    expect(rotation1.accessToken).toBeDefined();

    // Verify rotation 1 access token
    const verifyRot1 = await auth.tokens.verifyAccessToken(rotation1.accessToken);
    expect(verifyRot1.valid).toBe(true);

    // 3. Rotate a second time using the new refresh token
    const rotation2 = await auth.tokens.rotateRefreshToken({
      grantType: "refresh_token",
      refreshToken: rotation1.refreshToken,
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
    });

    expect(rotation2.refreshToken).not.toBe(rotation1.refreshToken);

    // Verify family active token is updated
    const family = await auth.tokenRepository.getTokenFamily(initialPair.familyId);
    expect(family?.status).toBe("active");
  });

  it("should detect refresh token reuse and immediately revoke the token family", async () => {
    const auth = createAuthService();

    // 1. Issue initial token pair
    const initialPair = await auth.tokens.issueTokenPair({
      accountId: "acc_01JABCDEF0123456",
      workspaceId: "ws_01JABCDEF0123456",
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
      scopes: ["device:connect"],
    });

    const rt0 = initialPair.refreshToken;

    // 2. Legitimate rotation: rt0 -> rt1
    const rot1 = await auth.tokens.rotateRefreshToken({
      grantType: "refresh_token",
      refreshToken: rt0,
      deviceId: "dev_01JABCDEF0123456",
      installationId: "inst_01JABCDEF0123456",
    });

    const rt1 = rot1.refreshToken;

    // 3. ATTACK: Attacker / Replay presents rt0 AGAIN!
    // This MUST trigger immediate token family revocation!
    await expect(
      auth.tokens.rotateRefreshToken({
        grantType: "refresh_token",
        refreshToken: rt0, // REUSED OLD TOKEN!
        deviceId: "dev_01JABCDEF0123456",
        installationId: "inst_01JABCDEF0123456",
      }),
    ).rejects.toThrow(/reuse detected/i);

    // 4. Verify that the entire token family was revoked
    const family = await auth.tokenRepository.getTokenFamily(initialPair.familyId);
    expect(family?.status).toBe("revoked");
    expect(family?.revokedReason).toBe("reuse_detected");

    // 5. Subsequent attempts using the legitimate rt1 must also fail now!
    await expect(
      auth.tokens.rotateRefreshToken({
        grantType: "refresh_token",
        refreshToken: rt1,
        deviceId: "dev_01JABCDEF0123456",
        installationId: "inst_01JABCDEF0123456",
      }),
    ).rejects.toThrow(/revoked/i);
  });
});

describe("End-to-End Token Refresh & Logout HTTP Routes", () => {
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

  it("should support token rotation via POST /v1/auth/token/refresh", async () => {
    const { baseUrl, authService, stop } = await setupServer();
    try {
      // Issue initial token pair directly
      const tokenPair = await authService.tokens.issueTokenPair({
        accountId: "acc_01JABCDEF0123456",
        workspaceId: "ws_01JABCDEF0123456",
        deviceId: "dev_01JABCDEF0123456",
        installationId: "inst_01JABCDEF0123456",
        scopes: ["device:connect"],
      });

      // Call refresh endpoint
      const refreshRes = await fetch(`${baseUrl}/v1/auth/token/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grantType: "refresh_token",
          refreshToken: tokenPair.refreshToken,
          deviceId: "dev_01JABCDEF0123456",
          installationId: "inst_01JABCDEF0123456",
        }),
      });

      expect(refreshRes.status).toBe(200);
      const refreshData = (await refreshRes.json()) as {
        accessToken: string;
        refreshToken: string;
      };

      expect(refreshData.accessToken).toBeDefined();
      expect(refreshData.refreshToken).not.toBe(tokenPair.refreshToken);

      // Verify the new access token can query protected APIs
      const apiRes = await fetch(`${baseUrl}/v1/devices`, {
        headers: { Authorization: `Bearer ${refreshData.accessToken}` },
      });
      expect(apiRes.status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("should support logout via POST /v1/auth/logout", async () => {
    const { baseUrl, authService, stop } = await setupServer();
    try {
      const tokenPair = await authService.tokens.issueTokenPair({
        accountId: "acc_01JABCDEF0123456",
        workspaceId: "ws_01JABCDEF0123456",
        deviceId: "dev_01JABCDEF0123456",
        installationId: "inst_01JABCDEF0123456",
        scopes: ["device:connect"],
      });

      // Logout with refreshToken
      const logoutRes = await fetch(`${baseUrl}/v1/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshToken: tokenPair.refreshToken,
        }),
      });

      expect(logoutRes.status).toBe(200);

      // Subsequent refresh attempts should fail
      const refreshRes = await fetch(`${baseUrl}/v1/auth/token/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grantType: "refresh_token",
          refreshToken: tokenPair.refreshToken,
          deviceId: "dev_01JABCDEF0123456",
          installationId: "inst_01JABCDEF0123456",
        }),
      });

      expect(refreshRes.status).toBe(400);
    } finally {
      await stop();
    }
  });
});
