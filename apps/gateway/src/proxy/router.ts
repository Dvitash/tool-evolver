import { randomUUID } from "node:crypto";
import { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES, McpProtocolError } from "../protocol/errors.js";
import type { CallToolResult } from "../protocol/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { CloudCatalogCache } from "./cache.js";
import { CloudCircuitBreaker } from "./circuit-breaker.js";
import type { CloudInvocationContext, MockCloudMcpService } from "./mock-service.js";

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface CloudInvocationRouterOptions {
  circuitBreaker?: CloudCircuitBreaker;
  catalogCache?: CloudCatalogCache;
  mockService?: MockCloudMcpService;
  baseUrl?: string;
  authToken?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
  invocationForwarder?: (
    toolId: string,
    params: Record<string, unknown>,
    context: CloudInvocationContext
  ) => Promise<CallToolResult>;
}

export class CloudInvocationRouter {
  private readonly circuitBreaker: CloudCircuitBreaker;
  private readonly catalogCache?: CloudCatalogCache;
  private readonly mockService?: MockCloudMcpService;
  private readonly baseUrl?: string;
  private readonly authToken?: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly invocationForwarder?: (
    toolId: string,
    params: Record<string, unknown>,
    context: CloudInvocationContext
  ) => Promise<CallToolResult>;

  constructor(options: CloudInvocationRouterOptions = {}) {
    this.circuitBreaker = options.circuitBreaker ?? new CloudCircuitBreaker();
    this.catalogCache = options.catalogCache;
    this.mockService = options.mockService;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.invocationForwarder = options.invocationForwarder;
  }

  getCircuitBreaker(): CloudCircuitBreaker {
    return this.circuitBreaker;
  }

  getCatalogCache(): CloudCatalogCache | undefined {
    return this.catalogCache;
  }

  /**
   * Factory returning a ToolHandler bound to this cloud router.
   */
  createToolHandler(toolIdOrName: string): ToolHandler {
    return async (context: WorkspaceContext, params: Record<string, unknown>, options?: ToolCallOptions) => {
      return await this.forwardInvocation(toolIdOrName, params, context, options);
    };
  }

  /**
   * Forwards a tool invocation to cloud MCP service.
   *
   * Invariants:
   * 1. Pre-flight circuit check (fail fast if OPEN).
   * 2. Cache TTL & Hard-expiry check (blocks execution past hard expiry).
   * 3. Zero silent queuing: failures are returned immediately to caller.
   * 4. Context forwarding (workspace, session, trace, idempotency, deadline).
   * 5. Cancellation & timeout management.
   * 6. Structured error translation to standard McpProtocolError.
   */
  async forwardInvocation(
    toolIdOrName: string,
    params: Record<string, unknown>,
    workspaceContext: WorkspaceContext,
    options: ToolCallOptions = {}
  ): Promise<CallToolResult> {
    // 1. Check Hard Expiry & Cache Availability
    if (this.catalogCache) {
      const availabilityInfo = this.catalogCache.getToolAvailability(toolIdOrName, workspaceContext.workspaceId);
      if (availabilityInfo.availability === "expired") {
        throw new McpProtocolError(
          MCP_ERROR_CODES.TOOL_NOT_FOUND,
          availabilityInfo.reason || `Cloud tool '${toolIdOrName}' has expired past hard TTL and cannot be executed offline`
        );
      }
    }

    // 2. Pre-flight Circuit Breaker Check
    if (!this.circuitBreaker.canExecute()) {
      const health = this.circuitBreaker.getHealth();
      throw new McpProtocolError(
        MCP_ERROR_CODES.CONNECTION_CLOSED,
        `Cloud service is currently offline/unavailable (circuit: ${health.circuitState}, status: ${health.status}). Invocation rejected (no silent queuing).`
      );
    }

    // 3. Setup Deadline, Idempotency & Trace Context
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const idempotencyKey = randomUUID();
    const traceContext: TraceContext = {
      traceId: randomUUID().replace(/-/g, ""),
      spanId: randomUUID().replace(/-/g, "").slice(0, 16),
    };

    // 4. Setup Combined AbortController for Signal & Timeout
    const abortController = new AbortController();
    let timeoutTimer: NodeJS.Timeout | undefined;
    let didTimeout = false;

    if (options.signal) {
      if (options.signal.aborted) {
        throw new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Tool invocation was cancelled by caller");
      }
      options.signal.addEventListener("abort", () => {
        abortController.abort(new Error("Caller cancelled tool invocation"));
      });
    }

    timeoutTimer = setTimeout(() => {
      didTimeout = true;
      abortController.abort(new Error(`Tool invocation deadline exceeded (${timeoutMs}ms)`));
    }, timeoutMs);

    const invocationContext: CloudInvocationContext = {
      workspaceContext,
      idempotencyKey,
      deadline,
      traceContext,
      signal: abortController.signal,
      onProgress: options.onProgress,
    };

    try {
      // 5. Execute Forwarding
      const result = await this.dispatch(toolIdOrName, params, invocationContext);

      // Record success in circuit breaker
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      // Handle cancellation vs timeout vs network failure
      if (didTimeout) {
        this.circuitBreaker.recordFailure(error);
        throw new McpProtocolError(
          MCP_ERROR_CODES.REQUEST_TIMEOUT,
          `Tool invocation for '${toolIdOrName}' timed out after ${timeoutMs}ms`
        );
      }

      if (options.signal?.aborted) {
        // Client-side cancellation does not increment failure count on circuit breaker
        throw new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Tool invocation was cancelled");
      }

      // Record failure on circuit breaker for upstream / network issues
      this.circuitBreaker.recordFailure(error);
      throw this.translateError(error, toolIdOrName);
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  private async dispatch(
    toolIdOrName: string,
    params: Record<string, unknown>,
    context: CloudInvocationContext
  ): Promise<CallToolResult> {
    // Strategy 1: Custom forwarder function
    if (this.invocationForwarder) {
      return await this.invocationForwarder(toolIdOrName, params, context);
    }

    // Strategy 2: MockCloudMcpService
    if (this.mockService) {
      return await this.mockService.handleToolInvocation(toolIdOrName, params, context);
    }

    // Strategy 3: HTTP REST API Forwarding
    if (this.baseUrl) {
      const url = `${this.baseUrl}/v1/tools/${encodeURIComponent(toolIdOrName)}/invoke`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Idempotency-Key": context.idempotencyKey,
        "X-Workspace-Id": context.workspaceContext.workspaceId,
        "X-Session-Id": context.workspaceContext.sessionId || "",
        "X-Trace-Id": context.traceContext?.traceId || "",
        "X-Span-Id": context.traceContext?.spanId || "",
      };

      if (this.authToken) {
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }

      const body = JSON.stringify({
        toolId: toolIdOrName,
        arguments: params,
        context: {
          workspaceId: context.workspaceContext.workspaceId,
          sessionId: context.workspaceContext.sessionId,
          gitRoot: context.workspaceContext.gitRoot,
          harnessId: context.workspaceContext.harnessId,
        },
      });

      const response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: context.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData: Record<string, unknown> | null = null;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          // ignore
        }

        const msg =
          (errorData && typeof errorData.message === "string" ? errorData.message : null) ||
          `Cloud invocation failed with HTTP ${response.status}: ${response.statusText}`;

        if (response.status === 404) {
          throw new McpProtocolError(MCP_ERROR_CODES.TOOL_NOT_FOUND, msg);
        }
        if (response.status === 401 || response.status === 403) {
          throw new McpProtocolError(MCP_ERROR_CODES.UNAUTHORIZED, msg);
        }
        if (response.status === 429) {
          throw new McpProtocolError(MCP_ERROR_CODES.RATE_LIMITED, msg);
        }
        if (response.status === 408 || response.status === 504) {
          throw new McpProtocolError(MCP_ERROR_CODES.REQUEST_TIMEOUT, msg);
        }
        if (response.status === 502 || response.status === 503) {
          throw new McpProtocolError(MCP_ERROR_CODES.CONNECTION_CLOSED, msg);
        }

        throw new McpProtocolError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, msg);
      }

      const result = (await response.json()) as CallToolResult;
      return result;
    }

    throw new McpProtocolError(
      JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      `No cloud invocation transport configured for tool '${toolIdOrName}'`
    );
  }

  private translateError(error: unknown, toolName: string): Error {
    if (error instanceof McpProtocolError) {
      return error;
    }

    const msg = error instanceof Error ? error.message : String(error ?? "Unknown error");

    if (msg.includes("not found") || msg.includes("404")) {
      return new McpProtocolError(MCP_ERROR_CODES.TOOL_NOT_FOUND, `Cloud tool '${toolName}' not found: ${msg}`);
    }

    if (msg.includes("Unauthorized") || msg.includes("401") || msg.includes("unauthorized") || msg.includes("token expired")) {
      return new McpProtocolError(MCP_ERROR_CODES.UNAUTHORIZED, `Unauthorized cloud tool invocation: ${msg}`);
    }

    if (msg.includes("Rate limit") || msg.includes("429") || msg.includes("rate_limited")) {
      return new McpProtocolError(MCP_ERROR_CODES.RATE_LIMITED, `Cloud tool invocation rate limited: ${msg}`);
    }

    if (msg.includes("timed out") || msg.includes("Timeout") || msg.includes("504") || msg.includes("408")) {
      return new McpProtocolError(MCP_ERROR_CODES.REQUEST_TIMEOUT, `Cloud tool invocation timed out: ${msg}`);
    }

    if (msg.includes("aborted") || msg.includes("cancelled") || msg.includes("Cancelled")) {
      return new McpProtocolError(MCP_ERROR_CODES.CANCELLED, `Cloud tool invocation cancelled: ${msg}`);
    }

    if (msg.includes("ECONNREFUSED") || msg.includes("offline") || msg.includes("502") || msg.includes("503") || msg.includes("closed")) {
      return new McpProtocolError(
        MCP_ERROR_CODES.CONNECTION_CLOSED,
        `Cloud service unavailable for tool '${toolName}': ${msg} (no silent queuing)`
      );
    }

    return new McpProtocolError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, `Cloud tool '${toolName}' invocation error: ${msg}`);
  }
}
