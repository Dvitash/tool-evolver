import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  type AuthClaims,
  type AuthScope,
  PROTOCOL_VERSION,
  hasRequiredScope,
} from "@tool-evolver/protocol";
import type { TenantContext } from "../tenant.js";
import type { AuthService } from "./index.js";
import { TokenError } from "./tokens.js";

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
function parseDevTenantToken(token: string): { accountId: string; workspaceId: string } | null {
  const parts = token.split(":");
  if (parts.length !== 2) return null;
  const [accountId, workspaceId] = parts.map((part) => part.trim());
  if (!accountId || !workspaceId) return null;
  return { accountId, workspaceId };
}

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
  const authHeader = req.headers.authorization;
  const accountIdHeader = req.headers["x-account-id"] as string | undefined;
  const workspaceIdHeader = req.headers["x-workspace-id"] as string | undefined;
  const protocolVersionHeader = req.headers["x-protocol-version"] as string | undefined;
  const traceId =
    (req.headers["x-trace-id"] as string | undefined) ||
    (req.headers.traceparent as string | undefined);
  const correlationId = (req.headers["x-request-id"] as string | undefined) || randomUUID();

  // 1. Enforce Protocol Version Header if provided
  if (protocolVersionHeader && options.requiredProtocolVersion) {
    if (protocolVersionHeader !== options.requiredProtocolVersion) {
      throw new TokenError(
        "unsupported_grant_type",
        `Protocol version mismatch: expected ${options.requiredProtocolVersion}, got ${protocolVersionHeader}`,
        400,
      );
    }
  }

  // 2. Standard Bearer JWT Authentication
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();

    // Check for dev token shorthand: "Bearer <accountId>:<workspaceId>"
    const devTenant =
      options.allowDevHeaders && !token.includes(".") ? parseDevTenantToken(token) : null;
    if (devTenant) {
      const tenant: TenantContext = {
        accountId: devTenant.accountId,
        workspaceId: devTenant.workspaceId,
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
    // 1. Standard Authorization header. Query-string tokens are intentionally rejected.
    // They leak through browser history, reverse-proxy logs, and referrer headers.
    const authHeader = req.headers.authorization;
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

    // 2. Try Sec-WebSocket-Protocol token
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

    // 3. Dev headers
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
