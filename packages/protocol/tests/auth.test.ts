import { describe, expect, it } from "vitest";
import {
  AuthClaimsSchema,
  AuthScopeSchema,
  DeviceAuthBootstrapRequestSchema,
  DeviceAuthBootstrapResponseSchema,
  DeviceRevocationRequestSchema,
  DeviceRevocationResponseSchema,
  DeviceTokenExchangeRequestSchema,
  DeviceTokenExchangeResponseSchema,
  TokenErrorCodeSchema,
  TokenErrorResponseSchema,
  TokenRotationRequestSchema,
  TokenRotationResponseSchema,
  areClaimsExpired,
  hasRequiredScope,
} from "../src/index.js";

describe("Device Authentication & Token Protocols", () => {
  it("validates DeviceAuthBootstrapRequest and Response schemas", () => {
    const validRequest = {
      deviceId: "dev-001",
      installationId: "inst-001",
      hostname: "macbook-pro.local",
      platform: "darwin" as const,
      arch: "arm64" as const,
      clientVersion: "1.0.0",
      scopes: ["device:connect" as const, "observations:write" as const],
    };

    const parsedRequest = DeviceAuthBootstrapRequestSchema.parse(validRequest);
    expect(parsedRequest.deviceId).toBe("dev-001");
    expect(parsedRequest.platform).toBe("darwin");

    const validResponse = {
      deviceCode: "dcode_abcdef1234567890",
      userCode: "UC-XYZ123",
      verificationUri: "https://auth.toolevolver.com/activate",
      verificationUriComplete: "https://auth.toolevolver.com/activate?user_code=UC-XYZ123",
      expiresIn: 900,
      interval: 5,
    };

    const parsedResponse = DeviceAuthBootstrapResponseSchema.parse(validResponse);
    expect(parsedResponse.userCode).toBe("UC-XYZ123");
    expect(parsedResponse.interval).toBe(5);
  });

  it("validates DeviceTokenExchange and Claims schemas", () => {
    const request = {
      grantType: "urn:ietf:params:oauth:grant-type:device_code" as const,
      deviceCode: "dcode_abcdef1234567890",
      deviceId: "dev-001",
      installationId: "inst-001",
    };

    const parsedRequest = DeviceTokenExchangeRequestSchema.parse(request);
    expect(parsedRequest.deviceCode).toBe("dcode_abcdef1234567890");

    const claims = {
      accountId: "acc-001",
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      scopes: ["device:connect" as const, "observations:write" as const, "catalog:read" as const],
      rawUploadConsent: true,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: "access" as const,
    };

    const response = {
      accessToken: "atk_sample_token",
      tokenType: "Bearer" as const,
      expiresIn: 3600,
      refreshToken: "rtk_sample_refresh",
      claims,
    };

    const parsedResponse = DeviceTokenExchangeResponseSchema.parse(response);
    expect(parsedResponse.accessToken).toBe("atk_sample_token");
    expect(parsedResponse.claims.scopes).toContain("observations:write");
  });

  it("validates TokenRotationRequest and TokenRotationResponse schemas", () => {
    const rotationRequest = {
      grantType: "refresh_token" as const,
      refreshToken: "rtk_old_refresh",
      deviceId: "dev-001",
      installationId: "inst-001",
    };

    const parsedRequest = TokenRotationRequestSchema.parse(rotationRequest);
    expect(parsedRequest.refreshToken).toBe("rtk_old_refresh");

    const rotationResponse = {
      accessToken: "atk_new_access",
      tokenType: "Bearer" as const,
      expiresIn: 3600,
      refreshToken: "rtk_new_refresh",
      claims: {
        accountId: "acc-001",
        deviceId: "dev-001",
        installationId: "inst-001",
        workspaceId: "ws-001",
        scopes: ["device:connect" as const, "observations:write" as const],
        rawUploadConsent: true,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        tokenType: "access" as const,
      },
    };

    const parsedResponse = TokenRotationResponseSchema.parse(rotationResponse);
    expect(parsedResponse.refreshToken).toBe("rtk_new_refresh");
  });

  it("validates DeviceRevocationRequest and DeviceRevocationResponse schemas", () => {
    const revokeRequest = {
      deviceId: "dev-001",
      installationId: "inst-001",
      reason: "security_compromise",
    };

    const parsedRequest = DeviceRevocationRequestSchema.parse(revokeRequest);
    expect(parsedRequest.deviceId).toBe("dev-001");
    expect(parsedRequest.tokenTypeHint).toBe("device");

    const revokeResponse = {
      revoked: true as const,
      revokedAt: new Date().toISOString(),
      deviceId: "dev-001",
      message: "Device successfully revoked",
    };

    const parsedResponse = DeviceRevocationResponseSchema.parse(revokeResponse);
    expect(parsedResponse.revoked).toBe(true);
  });

  it("evaluates claims helpers: hasRequiredScope and areClaimsExpired", () => {
    const validClaims = {
      accountId: "acc-001",
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      scopes: ["observations:write" as const, "catalog:read" as const],
      rawUploadConsent: false,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
      tokenType: "access" as const,
    };

    expect(hasRequiredScope(validClaims, "observations:write")).toBe(true);
    expect(hasRequiredScope(validClaims, "deployments:write")).toBe(false);
    expect(areClaimsExpired(validClaims)).toBe(false);

    // Admin all scope grant
    const adminClaims = {
      ...validClaims,
      scopes: ["admin:all" as const],
    };
    expect(hasRequiredScope(adminClaims, "deployments:write")).toBe(true);
    expect(hasRequiredScope(adminClaims, "telemetry:write")).toBe(true);

    // Expired claims
    const expiredClaims = {
      ...validClaims,
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    };
    expect(areClaimsExpired(expiredClaims)).toBe(true);
  });

  it("validates TokenError taxonomy and response schemas", () => {
    const errorResponse = {
      error: "authorization_pending" as const,
      error_description:
        "The authorization request is still pending as the user has not yet entered the code.",
      interval: 5,
    };

    const parsed = TokenErrorResponseSchema.parse(errorResponse);
    expect(parsed.error).toBe("authorization_pending");
    expect(parsed.interval).toBe(5);

    expect(TokenErrorCodeSchema.safeParse("revoked_device").success).toBe(true);
    expect(TokenErrorCodeSchema.safeParse("slow_down").success).toBe(true);
    expect(TokenErrorCodeSchema.safeParse("invalid_scope").success).toBe(true);
  });
});
