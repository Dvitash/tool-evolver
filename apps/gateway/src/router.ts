import { MCP_ERROR_CODES, McpProtocolError } from "./protocol/errors.js";
import type { CallToolResult, McpTool } from "./protocol/types.js";
import type { WorkspaceContext } from "./workspace-resolver.js";
import { withResolvers } from "./utils/deferred.js";

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
