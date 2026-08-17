/**
 * @tool-evolver/cloud - Deterministic Dev & Test Fixture Tools
 */

import type {
  CallToolResult,
  CloudMcpInvocationContext,
  CloudMcpToolDefinition,
} from "../types.js";
import { McpInvocationError } from "../middleware.js";
import { MCP_ERROR_CODES } from "../types.js";

/**
 * Echo fixture tool: returns input parameters back to caller.
 */
export const echoFixtureTool: CloudMcpToolDefinition = {
  name: "echo",
  description: "Dev fixture tool that echoes back provided parameters and session metadata.",
  source: "fixture",
  scope: "platform",
  classification: "read_only",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Echo text message" },
      payload: { type: "object", description: "Optional arbitrary payload" },
    },
    required: ["message"],
  },
  handler: async (
    params: Record<string, unknown>,
    context: CloudMcpInvocationContext,
  ): Promise<CallToolResult> => {
    const data = {
      echoed: params.message,
      payload: params.payload ?? null,
      workspaceId: context.tenant.workspaceId,
      accountId: context.tenant.accountId,
      sessionId: context.sessionId ?? null,
      timestamp: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
      isError: false,
      structuredData: data,
    };
  },
};

/**
 * Status fixture tool: returns cloud runtime status and health.
 */
export const statusFixtureTool: CloudMcpToolDefinition = {
  name: "status",
  description: "Dev fixture tool that returns cloud runtime status and timestamps.",
  source: "fixture",
  scope: "platform",
  classification: "read_only",
  inputSchema: {
    type: "object",
    properties: {
      includeUptime: { type: "boolean", description: "Whether to include process uptime" },
    },
  },
  handler: async (
    params: Record<string, unknown>,
    context: CloudMcpInvocationContext,
  ): Promise<CallToolResult> => {
    const data = {
      status: "online",
      service: "@tool-evolver/cloud",
      version: "0.1.0",
      workspaceId: context.tenant.workspaceId,
      uptimeSeconds: params.includeUptime !== false ? Math.round(process.uptime()) : undefined,
      timestamp: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
      isError: false,
      structuredData: data,
    };
  },
};

/**
 * Test failure fixture tool: simulates deterministic failure scenarios.
 */
export const testFailureFixtureTool: CloudMcpToolDefinition = {
  name: "test_failure",
  description: "Dev fixture tool to deterministically trigger specific error modes for testing.",
  source: "fixture",
  scope: "platform",
  classification: "idempotent",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["throw", "error_result", "timeout", "delay", "custom_code"],
        description: "Error mode to simulate",
      },
      message: { type: "string", description: "Error message to emit" },
      delayMs: { type: "number", description: "Simulated execution delay in milliseconds" },
      errorCode: { type: "number", description: "Custom JSON-RPC error code to throw" },
    },
    required: ["mode"],
  },
  handler: async (
    params: Record<string, unknown>,
    context: CloudMcpInvocationContext,
  ): Promise<CallToolResult> => {
    const mode = params.mode as string;
    const message = (params.message as string) || `Simulated failure in mode '${mode}'`;
    const delayMs = (params.delayMs as number) || 0;

    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        if (context.signal) {
          context.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new McpInvocationError(MCP_ERROR_CODES.CANCELLED, "Execution aborted during delay"));
          });
        }
      });
    }

    if (mode === "throw") {
      throw new Error(message);
    }

    if (mode === "custom_code") {
      const code = (params.errorCode as number) || MCP_ERROR_CODES.INTERNAL_ERROR;
      throw new McpInvocationError(code, message);
    }

    if (mode === "timeout") {
      throw new McpInvocationError(MCP_ERROR_CODES.REQUEST_TIMEOUT, message);
    }

    if (mode === "error_result") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "FAILED", message }, null, 2),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "ok", mode, delayMs }, null, 2),
        },
      ],
      isError: false,
    };
  },
};
