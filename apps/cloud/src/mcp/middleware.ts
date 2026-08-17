/**
 * @tool-evolver/cloud - Cloud MCP Invocation Middleware Pipeline
 */

import {
  PermissionDeniedError,
  ProtocolError,
  RateLimitedError,
  ValidationError,
} from "@tool-evolver/protocol";
import type {
  CallToolResult,
  CloudMcpInvocationContext,
  CloudMcpMiddleware,
  CloudMcpNextFunction,
  CloudMcpToolDefinition,
} from "./types.js";
import { MCP_ERROR_CODES } from "./types.js";

/**
 * Custom error class for MCP protocol errors with specific JSON-RPC codes.
 */
export class McpInvocationError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpInvocationError";
    this.code = code;
    this.data = data;
  }
}

/**
 * 1. Tenant Authentication & Workspace Scope Middleware.
 * Enforces valid tenant context and ensures caller is authorized for the tool scope.
 */
export function createTenantAuthMiddleware(): CloudMcpMiddleware {
  return async (
    context: CloudMcpInvocationContext,
    tool: CloudMcpToolDefinition,
    _params: Record<string, unknown>,
    next: CloudMcpNextFunction,
  ): Promise<CallToolResult> => {
    if (!context.tenant || !context.tenant.accountId || !context.tenant.workspaceId) {
      throw new McpInvocationError(
        MCP_ERROR_CODES.UNAUTHORIZED,
        "Authentication required: Tenant context missing or incomplete",
      );
    }

    // Platform tools are accessible to all authenticated tenants
    if (tool.scope === "platform" || tool.scope === "public") {
      return next();
    }

    // If tool specifies a manifest with workspace ID, verify tenant isolation
    if (tool.manifest?.metadata?.workspaceId) {
      const toolWorkspaceId = tool.manifest.metadata.workspaceId;
      if (toolWorkspaceId !== context.tenant.workspaceId) {
        throw new McpInvocationError(
          MCP_ERROR_CODES.RESOURCE_NOT_FOUND,
          `Access denied: Tool '${tool.name}' belongs to a different workspace`,
        );
      }
    }

    return next();
  };
}

/**
 * Helper to validate a value against basic JSON schema types.
 */
function validateSchemaType(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const expectedType = schema.type as string | undefined;
  if (!expectedType) return null;

  if (expectedType === "string" && typeof value !== "string") {
    return `Field '${path}' must be a string (got ${typeof value})`;
  }
  if (expectedType === "number" && typeof value !== "number") {
    return `Field '${path}' must be a number (got ${typeof value})`;
  }
  if (expectedType === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
    return `Field '${path}' must be an integer (got ${typeof value})`;
  }
  if (expectedType === "boolean" && typeof value !== "boolean") {
    return `Field '${path}' must be a boolean (got ${typeof value})`;
  }
  if (expectedType === "array" && !Array.isArray(value)) {
    return `Field '${path}' must be an array (got ${typeof value})`;
  }
  if (
    expectedType === "object" &&
    (typeof value !== "object" || value === null || Array.isArray(value))
  ) {
    return `Field '${path}' must be an object (got ${typeof value})`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `Field '${path}' must be one of [${schema.enum.join(", ")}] (got ${JSON.stringify(value)})`;
  }

  return null;
}

/**
 * 2. Parameter Validation Middleware.
 * Validates tool arguments against the tool's inputSchema.
 */
export function createParameterValidationMiddleware(): CloudMcpMiddleware {
  return async (
    _context: CloudMcpInvocationContext,
    tool: CloudMcpToolDefinition,
    params: Record<string, unknown>,
    next: CloudMcpNextFunction,
  ): Promise<CallToolResult> => {
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object") {
      return next();
    }

    const errors: string[] = [];
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const properties = (schema.properties as Record<string, Record<string, unknown>>) || {};

    // Check required properties
    for (const key of required) {
      if (params[key] === undefined || params[key] === null) {
        errors.push(`Missing required parameter: '${key}'`);
      }
    }

    // Check property types
    for (const [key, propSchema] of Object.entries(properties)) {
      if (params[key] !== undefined) {
        const typeErr = validateSchemaType(params[key], propSchema, key);
        if (typeErr) {
          errors.push(typeErr);
        }
      }
    }

    if (errors.length > 0) {
      throw new McpInvocationError(
        MCP_ERROR_CODES.INVALID_PARAMS,
        `Invalid tool parameters for '${tool.name}': ${errors.join("; ")}`,
        { validationErrors: errors },
      );
    }

    return next();
  };
}

/**
 * Rate limit tracker.
 */
interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  defaultRequestsPerMinute?: number;
  defaultBurst?: number;
}

/**
 * 3. Rate Limit Middleware.
 * Enforces sliding window rate limits per tenant/workspace/tool.
 */
export function createRateLimitMiddleware(options: RateLimitOptions = {}): CloudMcpMiddleware {
  const buckets = new Map<string, RateLimitBucket>();
  const defaultLimit = options.defaultRequestsPerMinute ?? 120;

  return async (
    context: CloudMcpInvocationContext,
    tool: CloudMcpToolDefinition,
    _params: Record<string, unknown>,
    next: CloudMcpNextFunction,
  ): Promise<CallToolResult> => {
    const limit = tool.rateLimit?.maxRequestsPerMinute ?? defaultLimit;
    const now = Date.now();
    const key = `${context.tenant.workspaceId}:${tool.name}`;

    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 1, resetAt: now + 60000 };
      buckets.set(key, bucket);
    } else {
      bucket.count++;
    }

    if (bucket.count > limit) {
      const retryAfterMs = Math.max(100, bucket.resetAt - now);
      throw new McpInvocationError(
        MCP_ERROR_CODES.RATE_LIMITED,
        `Rate limit exceeded for tool '${tool.name}' in workspace '${context.tenant.workspaceId}'. Limit: ${limit} req/min. Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
        { retryAfterMs, limit, windowSeconds: 60 },
      );
    }

    return next();
  };
}

/**
 * 4. Timeout Middleware.
 * Enforces execution timeout per tool or default.
 */
export function createTimeoutMiddleware(defaultTimeoutMs = 30000): CloudMcpMiddleware {
  return async (
    context: CloudMcpInvocationContext,
    tool: CloudMcpToolDefinition,
    _params: Record<string, unknown>,
    next: CloudMcpNextFunction,
  ): Promise<CallToolResult> => {
    const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
    const abortController = new AbortController();

    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      abortController.abort(new Error(`Tool execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Link parent signal if present
    const onParentAbort = () => {
      abortController.abort(context.signal?.reason ?? new Error("Parent request aborted"));
    };
    if (context.signal) {
      context.signal.addEventListener("abort", onParentAbort);
    }

    const linkedContext: CloudMcpInvocationContext = {
      ...context,
      signal: abortController.signal,
    };

    try {
      return await next();
    } catch (error: unknown) {
      if (didTimeout) {
        throw new McpInvocationError(
          MCP_ERROR_CODES.REQUEST_TIMEOUT,
          `Tool '${tool.name}' execution timed out after ${timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (context.signal) {
        context.signal.removeEventListener("abort", onParentAbort);
      }
    }
  };
}

/**
 * 5. Cancellation Middleware.
 * Checks for client cancellation before and during execution.
 */
export function createCancellationMiddleware(): CloudMcpMiddleware {
  return async (
    context: CloudMcpInvocationContext,
    tool: CloudMcpToolDefinition,
    _params: Record<string, unknown>,
    next: CloudMcpNextFunction,
  ): Promise<CallToolResult> => {
    if (context.signal?.aborted) {
      throw new McpInvocationError(
        MCP_ERROR_CODES.CANCELLED,
        `Tool invocation for '${tool.name}' was cancelled by caller`,
      );
    }

    return next();
  };
}

/**
 * Audit log entry.
 */
export interface InvocationAuditRecord {
  timestamp: string;
  workspaceId: string;
  accountId: string;
  toolName: string;
  classification: string;
  privacyLevel: string;
  durationMs: number;
  isError: boolean;
  errorCode?: number;
  traceId?: string;
}

/**
 * 6. Audit & Privacy Classification Middleware.
 * Tracks metrics and classifies data privacy boundaries.
 */
export function createAuditPrivacyMiddleware(
  options: {
    onAuditRecord?: (record: InvocationAuditRecord) => void;
  } = {},
): CloudMcpMiddleware {
  return async (
    context: CloudMcpInvocationContext,
    tool: CloudMcpToolDefinition,
    _params: Record<string, unknown>,
    next: CloudMcpNextFunction,
  ): Promise<CallToolResult> => {
    const startTime = Date.now();
    const classification = tool.classification ?? "read_only";
    const privacyLevel = tool.privacyLevel ?? "direct";

    try {
      const result = await next();
      const durationMs = Date.now() - startTime;

      options.onAuditRecord?.({
        timestamp: new Date().toISOString(),
        workspaceId: context.tenant.workspaceId,
        accountId: context.tenant.accountId,
        toolName: tool.name,
        classification,
        privacyLevel,
        durationMs,
        isError: !!result.isError,
        traceId: context.traceId,
      });

      return result;
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const errorCode =
        error instanceof McpInvocationError ? error.code : MCP_ERROR_CODES.INTERNAL_ERROR;

      options.onAuditRecord?.({
        timestamp: new Date().toISOString(),
        workspaceId: context.tenant.workspaceId,
        accountId: context.tenant.accountId,
        toolName: tool.name,
        classification,
        privacyLevel,
        durationMs,
        isError: true,
        errorCode,
        traceId: context.traceId,
      });

      throw error;
    }
  };
}

/**
 * Compose multiple middleware functions into a single execution function.
 */
export function composeMiddleware(middlewares: CloudMcpMiddleware[]): CloudMcpMiddleware {
  return (context, tool, params, next) => {
    let index = -1;

    const dispatch = (i: number): Promise<CallToolResult> => {
      if (i <= index) {
        return Promise.reject(new Error("next() called multiple times in middleware chain"));
      }
      index = i;
      const fn = middlewares[i];
      if (i === middlewares.length) {
        return next();
      }
      if (!fn) {
        return next();
      }
      return fn(context, tool, params, () => dispatch(i + 1));
    };

    return dispatch(0);
  };
}
