import { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  AuthClaims,
  AuthScope,
  PROTOCOL_VERSION,
  hasRequiredScope,
} from "@tool-evolver/protocol";
import { TenantContext } from "../tenant.js";
import { TokenError } from "./tokens.js";
import type { AuthService } from "./index.js";

/**
 * Validated Authentication Context.
 */
export interface AuthContext {
  tenant: TenantContext;
  claims?: AuthClaims;
  rawToken?: string;
  isDevAuth: boolean;
}

/**
 * Options for HTTP Authentication Middleware.
 */
export interface AuthMiddlewareOptions {
  requiredScope?: AuthScope;
  allowDevHeaders?: boolean;
  requiredProtocolVersion?: string;
}

/**
 * Authenticate an HTTP request and establish tenant context.
 */
export async function authenticateHttpRequest(
  req: IncomingMessage,
  authService: AuthService,
  options: AuthMiddlewareOptions = {},
): Promise<AuthContext> {
  const authHeader = req.headers["authorization"];
  const accountIdHeader = req.headers["x-account-id"] as string | undefined;
  const workspaceIdHeader = req.headers["x-workspace-id"] as string | undefined;
  const protocolVersionHeader = req.headers["x-protocol-version"] as string | undefined;
  const traceId =
    (req.headers["x-trace-id"] as string | undefined) ||
    (req.headers["traceparent"] as string | undefined);
  const correlationId = (req.headers["x-request-id"] as string | undefined) || randomUUID();

  // 1. Enforce Protocol Version Header if provided
  if (protocolVersionHeader && options.requiredProtocolVersion) {
    if (protocolVersionHeader !== options.requiredProtocolVersion) {
      throw new TokenError("unsupported_grant_type", `Protocol version mismatch: expected ${options.requiredProtocolVersion}, got ${protocolVersionHeader}`, 400);
    }
  }

  // 2. Standard Bearer JWT Authentication
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();

    // Check for dev token shorthand: "Bearer <accountId>:<workspaceId>"
    if (options.allowDevHeaders && token.includes(":") && !token.includes(".")) {
      const [acc, ws] = token.split(":");
      const tenant: TenantContext = {
        accountId: acc,
        workspaceId: ws,
        traceId,
        correlationId,
        metadata: { devAuth: true },
      };
      return { tenant, rawToken: token, isDevAuth: true };
    }

    // Verify JWT Token
    const verifyResult = await authService.tokens.verifyAccessToken(token);
    if (!verifyResult.valid || !verifyResult.claims) {
      throw new TokenError(
        verifyResult.code ?? "invalid_grant",
        verifyResult.error ?? "Invalid access token",
        verifyResult.code === "revoked_device" ? 403 : 401,
      );
    }

    const claims = verifyResult.claims;

    // Check required scope
    if (options.requiredScope) {
      if (!hasRequiredScope(claims, options.requiredScope)) {
        throw new TokenError(
          "invalid_scope",
          `Missing required scope: ${options.requiredScope}`,
          403,
        );
      }
    }

    const tenant: TenantContext = {
      accountId: claims.accountId,
      workspaceId: claims.workspaceId,
      deviceId: claims.deviceId,
      userId: claims.subject,
      roles: claims.scopes.includes("admin:all") ? ["admin"] : ["member"],
      traceId,
      correlationId,
      metadata: {
        scopes: claims.scopes,
        rawUploadConsent: claims.rawUploadConsent,
        installationId: claims.installationId,
        protocolVersion: protocolVersionHeader ?? PROTOCOL_VERSION,
      },
    };

    return { tenant, claims, rawToken: token, isDevAuth: false };
  }

  // 3. Dev / Legacy Header fallback
  if (options.allowDevHeaders && accountIdHeader && workspaceIdHeader) {
    const tenant: TenantContext = {
      accountId: accountIdHeader,
      workspaceId: workspaceIdHeader,
      traceId,
      correlationId,
      metadata: { devAuth: true },
    };
    return { tenant, isDevAuth: true };
  }

  throw new TokenError("unauthorized_client", "Missing or invalid authorization credentials", 401);
}

/**
 * Authenticate incoming WebSocket upgrade request for control stream.
 */
export async function authenticateWebSocket(
  req: IncomingMessage,
  authService: AuthService,
  options: { allowDevHeaders?: boolean } = {},
): Promise<AuthContext | null> {
  try {
    // 1. Try URL query parameter ?token=...
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const queryToken = url.searchParams.get("token") || url.searchParams.get("access_token");

    if (queryToken) {
      if (options.allowDevHeaders && queryToken.includes(":") && !queryToken.includes(".")) {
        const [acc, ws] = queryToken.split(":");
        return {
          tenant: { accountId: acc, workspaceId: ws, metadata: { devAuth: true } },
          rawToken: queryToken,
          isDevAuth: true,
        };
      }

      const verifyResult = await authService.tokens.verifyAccessToken(queryToken);
      if (verifyResult.valid && verifyResult.claims) {
        const claims = verifyResult.claims;
        const tenant: TenantContext = {
          accountId: claims.accountId,
          workspaceId: claims.workspaceId,
          deviceId: claims.deviceId,
          userId: claims.subject,
          metadata: {
            scopes: claims.scopes,
            rawUploadConsent: claims.rawUploadConsent,
            installationId: claims.installationId,
          },
        };
        return { tenant, claims, rawToken: queryToken, isDevAuth: false };
      }
      return null;
    }

    // 2. Try standard Authorization header
    const authHeader = req.headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      const verifyResult = await authService.tokens.verifyAccessToken(token);
      if (verifyResult.valid && verifyResult.claims) {
        const claims = verifyResult.claims;
        const tenant: TenantContext = {
          accountId: claims.accountId,
          workspaceId: claims.workspaceId,
          deviceId: claims.deviceId,
          userId: claims.subject,
          metadata: {
            scopes: claims.scopes,
            rawUploadConsent: claims.rawUploadConsent,
            installationId: claims.installationId,
          },
        };
        return { tenant, claims, rawToken: token, isDevAuth: false };
      }
      return null;
    }

    // 3. Try Sec-WebSocket-Protocol token
    const subprotocols = req.headers["sec-websocket-protocol"];
    if (subprotocols) {
      const protocols = subprotocols.split(",").map((p) => p.trim());
      for (const p of protocols) {
        if (p.startsWith("token.")) {
          const token = p.slice("token.".length);
          const verifyResult = await authService.tokens.verifyAccessToken(token);
          if (verifyResult.valid && verifyResult.claims) {
            const claims = verifyResult.claims;
            const tenant: TenantContext = {
              accountId: claims.accountId,
              workspaceId: claims.workspaceId,
              deviceId: claims.deviceId,
              userId: claims.subject,
              metadata: {
                scopes: claims.scopes,
                rawUploadConsent: claims.rawUploadConsent,
                installationId: claims.installationId,
              },
            };
            return { tenant, claims, rawToken: token, isDevAuth: false };
          }
        }
      }
    }

    // 4. Dev headers
    if (options.allowDevHeaders) {
      const accountId = req.headers["x-account-id"] as string | undefined;
      const workspaceId = req.headers["x-workspace-id"] as string | undefined;
      if (accountId && workspaceId) {
        return {
          tenant: { accountId, workspaceId, metadata: { devAuth: true } },
          isDevAuth: true,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
