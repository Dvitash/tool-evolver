/**
 * @tool-evolver/cloud - Cloud MCP Server Implementation
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthContext } from "../auth/middleware.js";
import type { CloudCatalogService } from "./catalog-service.js";
import {
  McpInvocationError,
  composeMiddleware,
  createAuditPrivacyMiddleware,
  createCancellationMiddleware,
  createParameterValidationMiddleware,
  createRateLimitMiddleware,
  createTenantAuthMiddleware,
  createTimeoutMiddleware,
} from "./middleware.js";
import type {
  CallToolResult,
  CloudMcpInvocationContext,
  CloudMcpMiddleware,
  CloudMcpSessionContext,
  CloudMcpToolDefinition,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpCallToolParams,
  McpCancelNotificationParams,
  McpInitializeParams,
  McpInitializeResult,
  McpToolsListResult,
} from "./types.js";
import { MCP_ERROR_CODES, MCP_PROTOCOL_VERSION, SUPPORTED_MCP_VERSIONS } from "./types.js";

/**
 * Options for configuring CloudMcpServer.
 */
export interface CloudMcpServerOptions {
  catalogService: CloudCatalogService;
  middlewares?: CloudMcpMiddleware[];
  defaultTimeoutMs?: number;
  serverInfo?: {
    name: string;
    version: string;
  };
}

/**
 * Cloud MCP Server providing standard Model Context Protocol (2024-11-05)
 * JSON-RPC, HTTP, and SSE streamable transport with tenant isolation.
 */
export class CloudMcpServer {
  readonly catalogService: CloudCatalogService;
  readonly serverInfo: { name: string; version: string };
  private readonly defaultTimeoutMs: number;
  private readonly composedMiddleware: CloudMcpMiddleware;

  // Active in-flight requests tracked for cancellation
  private readonly activeRequests = new Map<string, AbortController>();

  // Active SSE client sessions
  private readonly sseSessions = new Map<
    string,
    { res: ServerResponse; authContext: AuthContext }
  >();

  constructor(options: CloudMcpServerOptions) {
    this.catalogService = options.catalogService;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
    this.serverInfo = options.serverInfo ?? {
      name: "@tool-evolver/cloud",
      version: "0.1.0",
    };

    // Construct default middleware pipeline if not supplied
    const middlewares = options.middlewares ?? [
      createTenantAuthMiddleware(),
      createCancellationMiddleware(),
      createParameterValidationMiddleware(),
      createRateLimitMiddleware(),
      createTimeoutMiddleware(this.defaultTimeoutMs),
      createAuditPrivacyMiddleware(),
    ];

    this.composedMiddleware = composeMiddleware(middlewares);

    // Subscribe to catalog invalidations to notify SSE subscribers
    this.catalogService.onInvalidation((event) => {
      this.broadcastCatalogInvalidation(event.workspaceId);
    });
  }

  /**
   * Handle JSON-RPC 2.0 Request Object.
   */
  async handleJsonRpcRequest(
    req: JsonRpcRequest,
    context: CloudMcpInvocationContext,
  ): Promise<JsonRpcResponse> {
    const id = req.id ?? null;

    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: MCP_ERROR_CODES.INVALID_REQUEST,
          message: "Invalid JSON-RPC 2.0 request",
        },
      };
    }

    try {
      switch (req.method) {
        case "initialize": {
          const result = await this.handleInitialize(
            req.params as unknown as McpInitializeParams,
            context,
          );
          return { jsonrpc: "2.0", id, result };
        }

        case "tools/list": {
          const result = await this.handleToolsList(context);
          return { jsonrpc: "2.0", id, result };
        }

        case "tools/call": {
          const result = await this.handleToolsCall(
            id,
            req.params as unknown as McpCallToolParams,
            context,
          );
          return { jsonrpc: "2.0", id, result };
        }

        case "ping": {
          return { jsonrpc: "2.0", id, result: {} };
        }

        case "resources/list": {
          return { jsonrpc: "2.0", id, result: { resources: [] } };
        }

        case "prompts/list": {
          return { jsonrpc: "2.0", id, result: { prompts: [] } };
        }

        default: {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
              message: `MCP method '${req.method}' not found`,
            },
          };
        }
      }
    } catch (error: unknown) {
      return {
        jsonrpc: "2.0",
        id,
        error: this.formatJsonRpcError(error),
      };
    }
  }

  /**
   * Handle JSON-RPC Notification (no response expected).
   */
  async handleJsonRpcNotification(
    notif: JsonRpcNotification,
    _context: CloudMcpInvocationContext,
  ): Promise<void> {
    if (notif.method === "notifications/cancelled") {
      const params = notif.params as unknown as McpCancelNotificationParams;
      if (params?.requestId !== undefined && params.requestId !== null) {
        const reqKey = String(params.requestId);
        const controller = this.activeRequests.get(reqKey);
        if (controller) {
          controller.abort(new Error(params.reason ?? "Request cancelled by client notification"));
          this.activeRequests.delete(reqKey);
        }
      }
    }
  }

  /**
   * Handle standard HTTP POST /v1/mcp JSON-RPC request.
   */
  async handleHttpJsonRpc(
    req: IncomingMessage,
    res: ServerResponse,
    authContext: AuthContext,
  ): Promise<void> {
    const rawBody = await this.readBody(req);
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.sendJsonResponse(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: MCP_ERROR_CODES.PARSE_ERROR,
          message: "Failed to parse JSON-RPC request payload",
        },
      });
      return;
    }

    const context = this.createInvocationContext(req, authContext);

    // Handle single or batch requests
    if (Array.isArray(parsed)) {
      const responses: JsonRpcResponse[] = [];
      for (const singleReq of parsed) {
        if ("id" in singleReq && singleReq.id !== undefined) {
          const resp = await this.handleJsonRpcRequest(singleReq as JsonRpcRequest, context);
          responses.push(resp);
        } else {
          await this.handleJsonRpcNotification(singleReq as JsonRpcNotification, context);
        }
      }
      this.sendJsonResponse(res, 200, responses);
      return;
    }

    const singleReq = parsed as Record<string, unknown>;
    if ("id" in singleReq && singleReq.id !== undefined) {
      const resp = await this.handleJsonRpcRequest(singleReq as unknown as JsonRpcRequest, context);
      const statusCode = resp.error && resp.error.code === MCP_ERROR_CODES.UNAUTHORIZED ? 401 : 200;
      this.sendJsonResponse(res, statusCode, resp);
    } else {
      await this.handleJsonRpcNotification(singleReq as unknown as JsonRpcNotification, context);
      res.writeHead(204);
      res.end();
    }
  }

  /**
   * Handle Gateway proxy compatibility endpoint: POST /v1/tools/invoke
   */
  async handleToolInvoke(
    req: IncomingMessage,
    res: ServerResponse,
    authContext: AuthContext,
  ): Promise<void> {
    const rawBody = await this.readBody(req);
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.sendJsonResponse(res, 400, {
        isError: true,
        content: [{ type: "text", text: "Invalid JSON body" }],
      });
      return;
    }

    const toolId = (parsed.toolId as string) || (parsed.name as string);
    const args =
      (parsed.arguments as Record<string, unknown>) ||
      (parsed.params as Record<string, unknown>) ||
      {};
    const invocationCtx = this.createInvocationContext(req, authContext);

    if (!toolId) {
      this.sendJsonResponse(res, 400, {
        isError: true,
        content: [{ type: "text", text: "Missing required parameter: toolId" }],
      });
      return;
    }

    const tool = await this.catalogService.getTool(authContext.tenant, toolId);
    if (!tool) {
      this.sendJsonResponse(res, 404, {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${toolId}' not found in workspace '${authContext.tenant.workspaceId}'`,
          },
        ],
      });
      return;
    }

    try {
      const result = await this.executeToolWithMiddleware(tool, args, invocationCtx);
      this.sendJsonResponse(res, 200, result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJsonResponse(res, 500, {
        isError: true,
        content: [{ type: "text", text: `Execution failed: ${message}` }],
      });
    }
  }

  /**
   * Handle Catalog Snapshot Endpoint: GET/POST /v1/catalog/snapshot
   */
  async handleCatalogSnapshot(
    req: IncomingMessage,
    res: ServerResponse,
    authContext: AuthContext,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let currentVersion = url.searchParams.get("currentVersion") || undefined;
    let filterScopes: string[] | undefined;

    if (req.method === "POST") {
      try {
        const body = JSON.parse(await this.readBody(req));
        if (body.currentVersion) currentVersion = body.currentVersion;
        if (Array.isArray(body.filterScopes)) filterScopes = body.filterScopes;
      } catch {
        // Fall back to query params
      }
    }

    try {
      const snapshot = await this.catalogService.getCatalogSnapshot(
        authContext.tenant,
        currentVersion,
        filterScopes,
      );

      this.sendJsonResponse(res, 200, snapshot);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJsonResponse(res, 500, {
        error: "SNAPSHOT_FAILED",
        message,
      });
    }
  }

  /**
   * Handle SSE Streaming Transport: GET /v1/mcp/sse
   */
  async handleSseStream(
    req: IncomingMessage,
    res: ServerResponse,
    authContext: AuthContext,
  ): Promise<void> {
    const sessionId = randomUUID();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send endpoint event with POST target URL
    const endpointUrl = `/v1/mcp?sessionId=${sessionId}`;
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

    this.sseSessions.set(sessionId, { res, authContext });

    req.on("close", () => {
      this.sseSessions.delete(sessionId);
    });
  }

  /**
   * Broadcast catalog list changed notification to all SSE subscribers in a workspace.
   */
  private broadcastCatalogInvalidation(workspaceId: string): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };
    const message = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;

    for (const [, session] of this.sseSessions) {
      if (session.authContext.tenant.workspaceId === workspaceId) {
        try {
          session.res.write(message);
        } catch {
          // Client disconnected
        }
      }
    }
  }

  /**
   * MCP Method: initialize
   */
  private async handleInitialize(
    params: McpInitializeParams,
    context: CloudMcpInvocationContext,
  ): Promise<McpInitializeResult> {
    const requestedVersion = params?.protocolVersion ?? "2024-11-05";

    return {
      protocolVersion: SUPPORTED_MCP_VERSIONS.includes(
        requestedVersion as unknown as (typeof SUPPORTED_MCP_VERSIONS)[number],
      )
        ? requestedVersion
        : MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          subscribe: false,
          listChanged: false,
        },
        prompts: {
          listChanged: false,
        },
        logging: {},
      },
      serverInfo: this.serverInfo,
    };
  }

  /**
   * MCP Method: tools/list
   */
  private async handleToolsList(context: CloudMcpInvocationContext): Promise<McpToolsListResult> {
    const tools = await this.catalogService.getTools(context.tenant);

    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  /**
   * MCP Method: tools/call
   */
  private async handleToolsCall(
    id: JsonRpcId,
    params: McpCallToolParams,
    context: CloudMcpInvocationContext,
  ): Promise<CallToolResult> {
    if (!params || typeof params.name !== "string") {
      throw new McpInvocationError(
        MCP_ERROR_CODES.INVALID_PARAMS,
        "Missing required tool name in params",
      );
    }

    const tool = await this.catalogService.getTool(context.tenant, params.name);
    if (!tool) {
      throw new McpInvocationError(
        MCP_ERROR_CODES.RESOURCE_NOT_FOUND,
        `Tool '${params.name}' not found in workspace '${context.tenant.workspaceId}'`,
      );
    }

    // Set up request cancellation tracking
    const abortController = new AbortController();
    const reqKey = id !== null && id !== undefined ? String(id) : randomUUID();
    this.activeRequests.set(reqKey, abortController);

    // Link parent signal if present
    if (context.signal) {
      if (context.signal.aborted) {
        abortController.abort(context.signal.reason);
      } else {
        context.signal.addEventListener("abort", () => {
          abortController.abort(context.signal?.reason);
        });
      }
    }

    const toolContext: CloudMcpInvocationContext = {
      ...context,
      signal: abortController.signal,
    };

    try {
      return await this.executeToolWithMiddleware(tool, params.arguments ?? {}, toolContext);
    } finally {
      this.activeRequests.delete(reqKey);
    }
  }

  /**
   * Executes a tool through the composed middleware pipeline.
   */
  private async executeToolWithMiddleware(
    tool: CloudMcpToolDefinition,
    params: Record<string, unknown>,
    context: CloudMcpInvocationContext,
  ): Promise<CallToolResult> {
    return this.composedMiddleware(context, tool, params, async () => {
      return tool.handler(params, context);
    });
  }

  /**
   * Create invocation context from request and auth context.
   */
  private createInvocationContext(
    req: IncomingMessage,
    authContext: AuthContext,
  ): CloudMcpInvocationContext {
    const traceId =
      (req.headers["x-trace-id"] as string | undefined) ||
      (req.headers["traceparent"] as string | undefined) ||
      randomUUID();

    return {
      tenant: authContext.tenant,
      claims: authContext.claims,
      sessionId: req.headers["x-session-id"] as string | undefined,
      deviceId: req.headers["x-device-id"] as string | undefined,
      installationId: req.headers["x-installation-id"] as string | undefined,
      traceId,
      spanId: req.headers["x-span-id"] as string | undefined,
      parentSpanId: req.headers["x-parent-span-id"] as string | undefined,
      protocolVersion: req.headers["x-protocol-version"] as string | undefined,
    };
  }

  /**
   * Helper to format any error into a standard JSON-RPC error object.
   */
  private formatJsonRpcError(error: unknown): JsonRpcErrorObject {
    if (error instanceof McpInvocationError) {
      return {
        code: error.code,
        message: error.message,
        data: error.data,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      code: MCP_ERROR_CODES.INTERNAL_ERROR,
      message,
    };
  }

  /**
   * Helper to read full body from IncomingMessage.
   */
  private async readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  /**
   * Helper to send a JSON HTTP response.
   */
  private sendJsonResponse(res: ServerResponse, statusCode: number, data: unknown): void {
    const json = JSON.stringify(data);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(json);
  }
}

/**
 * Factory function creating a CloudMcpServer instance.
 */
export function createCloudMcpServer(options: CloudMcpServerOptions): CloudMcpServer {
  return new CloudMcpServer(options);
}
