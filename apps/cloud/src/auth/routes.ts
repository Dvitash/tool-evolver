import type { IncomingMessage, ServerResponse } from "node:http";
import { sha256 } from "@tool-evolver/crypto";
import {
  DeviceAuthBootstrapRequestSchema,
  DeviceRevocationRequestSchema,
  DeviceTokenExchangeRequestSchema,
  TokenRotationRequestSchema,
} from "@tool-evolver/protocol";
import type { AuthService } from "./index.js";
import { TokenError } from "./tokens.js";

/**
 * Helper to send JSON responses.
 */
function sendJsonResponse(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Handle incoming HTTP requests destined for /v1/auth/* endpoints.
 */
export async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: Record<string, unknown>,
  authService: AuthService,
  headers: Record<string, string> = {},
): Promise<boolean> {
  const method = req.method?.toUpperCase();

  // 1. POST /v1/auth/device/code - Initiate Device Authorization Flow
  if (path === "/v1/auth/device/code" && method === "POST") {
    try {
      const parsed = DeviceAuthBootstrapRequestSchema.parse(body);
      const host = (req.headers.host as string) || "127.0.0.1";
      const proto = req.headers["x-forwarded-proto"] || "http";
      const verificationUri = `${proto}://${host}/device`;

      const response = await authService.deviceFlow.initiate(parsed, verificationUri);
      sendJsonResponse(res, 200, response, headers);
      return true;
    } catch (err) {
      if (err instanceof TokenError) {
        sendJsonResponse(
          res,
          err.httpStatus,
          { error: err.code, error_description: err.message },
          headers,
        );
        return true;
      }
      sendJsonResponse(
        res,
        400,
        { error: "invalid_request", error_description: (err as Error).message },
        headers,
      );
      return true;
    }
  }

  // 2. POST /v1/auth/device/token - Poll / Exchange Device Code
  if (path === "/v1/auth/device/token" && method === "POST") {
    try {
      const parsed = DeviceTokenExchangeRequestSchema.parse(body);
      const response = await authService.deviceFlow.poll(parsed);
      sendJsonResponse(res, 200, response, headers);
      return true;
    } catch (err) {
      if (err instanceof TokenError) {
        sendJsonResponse(
          res,
          err.httpStatus,
          {
            error: err.code,
            error_description: err.message,
            ...(err.interval ? { interval: err.interval } : {}),
          },
          headers,
        );
        return true;
      }
      sendJsonResponse(
        res,
        400,
        { error: "invalid_request", error_description: (err as Error).message },
        headers,
      );
      return true;
    }
  }

  // 3. POST /v1/auth/token/refresh - Token Rotation & Refresh
  if (path === "/v1/auth/token/refresh" && method === "POST") {
    try {
      const parsed = TokenRotationRequestSchema.parse(body);
      const response = await authService.tokens.rotateRefreshToken(parsed);
      sendJsonResponse(res, 200, response, headers);
      return true;
    } catch (err) {
      if (err instanceof TokenError) {
        sendJsonResponse(
          res,
          err.httpStatus,
          { error: err.code, error_description: err.message },
          headers,
        );
        return true;
      }
      sendJsonResponse(
        res,
        400,
        { error: "invalid_request", error_description: (err as Error).message },
        headers,
      );
      return true;
    }
  }

  // 4. POST /v1/auth/device/revoke - Revoke Device & Associated Tokens
  if (path === "/v1/auth/device/revoke" && method === "POST") {
    try {
      const parsed = DeviceRevocationRequestSchema.parse(body);
      await authService.revokeDevice(parsed.deviceId, parsed.installationId);
      sendJsonResponse(
        res,
        200,
        {
          revoked: true,
          revokedAt: new Date().toISOString(),
          deviceId: parsed.deviceId,
          message: `Device ${parsed.deviceId} authorization and all active tokens revoked`,
        },
        headers,
      );
      return true;
    } catch (err) {
      sendJsonResponse(
        res,
        400,
        { error: "invalid_request", error_description: (err as Error).message },
        headers,
      );
      return true;
    }
  }

  // 5. POST /v1/auth/logout - Logout & Invalidate Session
  if (path === "/v1/auth/logout" && method === "POST") {
    try {
      const refreshToken = body.refreshToken as string | undefined;
      const familyId = body.familyId as string | undefined;

      if (refreshToken) {
        const tokenHash = sha256(refreshToken);
        const record = await authService.tokens.tokenRepository.getRefreshToken(tokenHash);
        if (record) {
          await authService.tokens.revokeTokenFamily(record.familyId, "user_logout");
        }
      } else if (familyId) {
        await authService.tokens.revokeTokenFamily(familyId, "user_logout");
      }

      sendJsonResponse(res, 200, { loggedOut: true, message: "Successfully logged out" }, headers);
      return true;
    } catch (err) {
      sendJsonResponse(
        res,
        400,
        { error: "invalid_request", error_description: (err as Error).message },
        headers,
      );
      return true;
    }
  }

  // 6. POST /v1/auth/device/authorize - User Approval (from Web Portal / Test helper)
  if (path === "/v1/auth/device/authorize" && method === "POST") {
    try {
      const userCode = body.userCode as string;
      const accountId = (body.accountId as string) || "acc_default";
      const workspaceId = (body.workspaceId as string) || "ws_default";
      const userId = body.userId as string | undefined;
      const rawUploadConsent = (body.rawUploadConsent as boolean) ?? false;

      if (!userCode) {
        sendJsonResponse(
          res,
          400,
          { error: "invalid_request", error_description: "Missing userCode" },
          headers,
        );
        return true;
      }

      const result = await authService.deviceFlow.authorizeUserCode(userCode, {
        accountId,
        workspaceId,
        userId,
        rawUploadConsent,
      });

      if (!result.success) {
        sendJsonResponse(
          res,
          400,
          { error: "authorization_failed", error_description: result.error },
          headers,
        );
        return true;
      }

      sendJsonResponse(res, 200, { authorized: true, userCode }, headers);
      return true;
    } catch (err) {
      sendJsonResponse(
        res,
        400,
        { error: "invalid_request", error_description: (err as Error).message },
        headers,
      );
      return true;
    }
  }

  // 7. POST /v1/auth/device/deny - User Denial
  if (path === "/v1/auth/device/deny" && method === "POST") {
    try {
      const userCode = body.userCode as string;
      if (!userCode) {
        sendJsonResponse(
          res,
          400,
          { error: "invalid_request", error_description: "Missing userCode" },
          headers,
        );
        return true;
      }

      const result = await authService.deviceFlow.denyUserCode(userCode);
      if (!result.success) {
        sendJsonResponse(
          res,
          400,
          { error: "denial_failed", error_description: result.error },
          headers,
        );
        return true;
      }

      sendJsonResponse(res, 200, { denied: true, userCode }, headers);
      return true;
    } catch (err) {
      sendJsonResponse(
        res,
        400,
        { error: "invalid_request", error_description: (err as Error).message },
        headers,
      );
      return true;
    }
  }

  // 8. GET /v1/auth/device/verify - Inspection of user code for UI
  if (path === "/v1/auth/device/verify" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const userCode = url.searchParams.get("user_code");

    if (!userCode) {
      sendJsonResponse(
        res,
        400,
        { error: "invalid_request", error_description: "Missing user_code parameter" },
        headers,
      );
      return true;
    }

    const session = authService.deviceFlow.getSessionByUserCode(userCode);
    if (!session) {
      sendJsonResponse(
        res,
        404,
        { error: "not_found", error_description: "User code not found or expired" },
        headers,
      );
      return true;
    }

    sendJsonResponse(
      res,
      200,
      {
        userCode: session.userCode,
        deviceId: session.deviceId,
        hostname: session.hostname,
        platform: session.platform,
        scopes: session.scopes,
        status: session.status,
        expiresInSeconds: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
      },
      headers,
    );
    return true;
  }

  return false;
}
