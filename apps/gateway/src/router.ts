import { MCP_ERROR_CODES, McpProtocolError } from "./protocol/errors.js";
import type { CallToolResult, McpTool, McpToolInput } from "./protocol/types.js";
import type { CatalogSnapshotRecord, ToolRegistry } from "./registry/index.js";
import { withResolvers } from "./utils/deferred.js";
import type { WorkspaceContext } from "./workspace-resolver.js";

export interface ToolCallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number) => void;
  timeoutMs?: number;
}

export type ToolHandler = (
  context: WorkspaceContext,
  params: Record<string, unknown>,
  options?: ToolCallOptions
) => Promise<CallToolResult>;

export interface GatewayRouter {
  listTools(context: WorkspaceContext): Promise<McpTool[]>;
  callTool(
    context: WorkspaceContext,
    name: string,
    params: Record<string, unknown>,
    options?: ToolCallOptions
  ): Promise<CallToolResult>;
  onToolListChanged?(listener: () => void): () => void;
}

export interface RegisteredTool {
  tool: McpTool;
  handler: ToolHandler;
  workspaceId?: string;
}

/**
 * Fake in-memory GatewayRouter implementation for testing and development.
 */
export class FakeGatewayRouter implements GatewayRouter {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly listeners = new Set<() => void>();
  private readonly delays = new Map<string, number>();

  constructor() {
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    // 1. Echo tool
    this.registerTool(
      {
        name: "echo",
        description: "Echoes back provided parameters",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Message to echo back" },
          },
          required: ["message"],
        },
      },
      async (_ctx, params) => ({
        content: [
          {
            type: "text",
            text: `Echo: ${typeof params.message === "string" ? params.message : JSON.stringify(params)}`,
          },
        ],
      })
    );

    // 2. Workspace info tool
    this.registerTool(
      {
        name: "workspace_info",
        description: "Returns active workspace context info",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      async (ctx) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workspaceId: ctx.workspaceId,
                canonicalRoot: ctx.canonicalRoot,
                name: ctx.name,
                source: ctx.source,
                rootsCount: ctx.roots.length,
                gitRoot: ctx.gitRoot,
                harnessId: ctx.harnessId,
              },
              null,
              2
            ),
          },
        ],
      })
    );

    // 3. Fail tool (for testing error handling & redaction)
    this.registerTool(
      {
        name: "fail_tool",
        description: "Intentionally throws an error with provided message",
        inputSchema: {
          type: "object",
          properties: {
            errorMessage: { type: "string" },
            isToolResultError: { type: "boolean" },
          },
        },
      },
      async (_ctx, params) => {
        const msg =
          typeof params.errorMessage === "string"
            ? params.errorMessage
            : "Intentional tool failure";
        if (params.isToolResultError) {
          return {
            content: [{ type: "text", text: msg }],
            isError: true,
          };
        }
        throw new Error(msg);
      }
    );

    // 4. Slow tool (for testing progress and cancellation)
    this.registerTool(
      {
        name: "slow_tool",
        description: "Asynchronous tool that delays and supports progress and cancellation",
        inputSchema: {
          type: "object",
          properties: {
            durationMs: { type: "number" },
            steps: { type: "number" },
          },
        },
      },
      async (_ctx, params, options) => {
        const durationMs =
          typeof params.durationMs === "number" ? params.durationMs : 300;
        const steps = typeof params.steps === "number" ? params.steps : 3;
        const stepDelay = Math.max(10, Math.floor(durationMs / steps));

        for (let i = 1; i <= steps; i++) {
          if (options?.signal?.aborted) {
            throw new McpProtocolError(
              MCP_ERROR_CODES.CANCELLED,
              "Operation cancelled by client"
            );
          }

          const { promise, resolve, reject } = withResolvers<void>();
          const timeout = setTimeout(() => {
            cleanup();
            resolve();
          }, stepDelay);

          const onAbort = () => {
            cleanup();
            reject(
              new McpProtocolError(
                MCP_ERROR_CODES.CANCELLED,
                "Operation cancelled by client"
              )
            );
          };

          const cleanup = () => {
            clearTimeout(timeout);
            options?.signal?.removeEventListener("abort", onAbort);
          };

          options?.signal?.addEventListener("abort", onAbort);
          await promise;

          options?.onProgress?.(i, steps);
        }

        return {
          content: [
            {
              type: "text",
              text: `Completed ${steps} steps in ${durationMs}ms`,
            },
          ],
        };
      }
    );
  }

  registerTool(
    tool: McpTool,
    handler: ToolHandler,
    workspaceId?: string
  ): void {
    const key = workspaceId ? `${workspaceId}:${tool.name}` : tool.name;
    this.tools.set(key, { tool, handler, workspaceId });
    this.triggerToolListChanged();
  }

  unregisterTool(name: string, workspaceId?: string): boolean {
    const key = workspaceId ? `${workspaceId}:${name}` : name;
    const deleted = this.tools.delete(key);
    if (deleted) {
      this.triggerToolListChanged();
    }
    return deleted;
  }

  setToolDelay(name: string, delayMs: number): void {
    this.delays.set(name, delayMs);
  }

  async listTools(context: WorkspaceContext): Promise<McpTool[]> {
    const result: McpTool[] = [];
    for (const entry of this.tools.values()) {
      if (!entry.workspaceId || entry.workspaceId === context.workspaceId) {
        result.push(entry.tool);
      }
    }
    return result;
  }

  async callTool(
    context: WorkspaceContext,
    name: string,
    params: Record<string, unknown>,
    options?: ToolCallOptions
  ): Promise<CallToolResult> {
    // Check workspace-specific first, then global
    const wsKey = `${context.workspaceId}:${name}`;
    const entry = this.tools.get(wsKey) ?? this.tools.get(name);

    if (!entry) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        `Tool '${name}' not found`
      );
    }

    const delay = this.delays.get(name);
    if (delay && delay > 0) {
      const { promise, resolve } = withResolvers<void>();
      setTimeout(resolve, delay);
      await promise;
    }

    return entry.handler(context, params, options);
  }

  onToolListChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  triggerToolListChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }
}
function toMcpInputSchema(rawSchema?: Record<string, unknown>): McpToolInput {
  if (!rawSchema || typeof rawSchema !== "object") {
    return { type: "object", properties: {} };
  }
  const properties =
    rawSchema.properties && typeof rawSchema.properties === "object"
      ? (rawSchema.properties as Record<string, unknown>)
      : undefined;
  const required = Array.isArray(rawSchema.required)
    ? (rawSchema.required as string[])
    : undefined;
  const additionalProperties =
    typeof rawSchema.additionalProperties === "boolean" ||
    (rawSchema.additionalProperties && typeof rawSchema.additionalProperties === "object")
      ? (rawSchema.additionalProperties as boolean | Record<string, unknown>)
      : undefined;
  const description =
    typeof rawSchema.description === "string" ? rawSchema.description : undefined;

  return {
    type: "object",
    properties,
    required,
    additionalProperties,
    description,
  };
}


/**
 * Dynamic GatewayRouter implementation backed by a ToolRegistry.
 */
export class RegistryGatewayRouter implements GatewayRouter {
  private readonly registry: ToolRegistry;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeEvents?: () => void;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    if (this.registry.events) {
      this.unsubscribeEvents = this.registry.events.onCatalogChanged(() => {
        this.triggerToolListChanged();
      });
    }
  }

  async listTools(context: WorkspaceContext): Promise<McpTool[]> {
    const snapshot = await this.registry.resolveCatalog(context.workspaceId, context.sessionId);
    const mcpTools: McpTool[] = [];
    const record = snapshot as CatalogSnapshotRecord;

    if (record.entries && Object.keys(record.entries).length > 0) {
      for (const entry of Object.values(record.entries)) {
        const schema = toMcpInputSchema(entry.parameters ?? entry.manifest?.parameters);
        mcpTools.push({
          name: entry.exposedName,
          description: entry.description || entry.manifest?.description || `Tool ${entry.name}`,
          inputSchema: schema,
        });
      }
    } else {
      for (const summary of Object.values(snapshot.tools)) {
        const tool = await this.registry.getTool(summary.toolId, context.workspaceId, context.sessionId);
        if (tool) {
          const schema = toMcpInputSchema(tool.parameters ?? tool.manifest?.parameters);
          mcpTools.push({
            name: tool.exposedName || tool.name,
            description: tool.description || tool.manifest?.description || `Tool ${tool.name}`,
            inputSchema: schema,
          });
        }
      }
    }
    return mcpTools;
  }
  async callTool(
    context: WorkspaceContext,
    name: string,
    params: Record<string, unknown>,
    options?: ToolCallOptions
  ): Promise<CallToolResult> {
    const tool = await this.registry.getTool(name, context.workspaceId, context.sessionId);

    if (!tool) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        `Tool '${name}' not found`
      );
    }

    const isToolDisabled = await this.registry.controls.isToolDisabled(context.workspaceId, tool.toolId);
    if (tool.isDisabled || isToolDisabled) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        `Tool '${name}' is disabled in this workspace`
      );
    }

    if (tool.handler) {
      return tool.handler(context, params, options);
    }

    // Default fallback output
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "executed",
            tool: tool.name,
            version: tool.version,
            params,
          }),
        },
      ],
    };
  }

  onToolListChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  triggerToolListChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  destroy(): void {
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
    }
    this.listeners.clear();
  }
}

/**
 * Creates a GatewayRouter backed by a ToolRegistry.
 */
export function createRegistryGatewayRouter(registry: ToolRegistry): RegistryGatewayRouter {
  return new RegistryGatewayRouter(registry);
}
