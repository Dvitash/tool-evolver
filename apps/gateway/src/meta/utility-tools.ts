import type { ToolManifest } from "@tool-evolver/contracts";
import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@tool-evolver/contracts";
import { MCP_ERROR_CODES, McpProtocolError } from "../protocol/errors.js";
import type { RegistryTool } from "../registry/types.js";
import { computeManifestDigest } from "../registry/validator.js";
import { withResolvers } from "../utils/deferred.js";

const UTILITY_RUNTIME = ToolRuntimeRequirementSchema.parse({ runtime: "builtin" });
const UTILITY_CAPABILITIES = CapabilityManifestSchema.parse({});
const UTILITY_LIMITS = ToolLimitConfigSchema.parse({});

function utilityManifest(raw: {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}): ToolManifest {
  const base = {
    version: "1.0.0",
    runtime: UTILITY_RUNTIME,
    capabilities: UTILITY_CAPABILITIES,
    limits: UTILITY_LIMITS,
    scope: "global" as const,
    metadata: { tags: ["utility", "builtin"] },
    createdAt: "2026-08-17T00:00:00.000Z",
    id: raw.id,
    name: raw.name,
    description: raw.description,
    parameters: ToolParameterSchema.parse({
      required: [],
      additionalProperties: true,
      ...raw.parameters,
    }),
  };
  return { ...base, digest: computeManifestDigest(base) };
}

/**
 * Default workspace utility tools (echo, workspace_info, fail_tool, slow_tool)
 * served by the standalone gateway so harnesses always have baseline tools.
 */
export function createDefaultUtilityTools(): RegistryTool[] {
  const echoManifest = utilityManifest({
    id: "tool_utility_echo",
    name: "echo",
    description: "Echoes back provided parameters",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "Message to echo back" } },
      required: ["message"],
    },
  });

  const echo: RegistryTool = {
    toolId: "tool_utility_echo",
    name: "echo",
    exposedName: "echo",
    version: "1.0.0",
    scope: "global",
    status: "active",
    description: echoManifest.description,
    parameters: echoManifest.parameters as Record<string, unknown>,
    manifest: echoManifest,
    handler: async (_ctx, params) => ({
      content: [
        {
          type: "text",
          text: `Echo: ${typeof params.message === "string" ? params.message : JSON.stringify(params)}`,
        },
      ],
    }),
  };

  const workspaceInfoManifest = utilityManifest({
    id: "tool_utility_workspace_info",
    name: "workspace_info",
    description: "Returns active workspace context info",
    parameters: { type: "object", properties: {} },
  });

  const workspaceInfo: RegistryTool = {
    toolId: "tool_utility_workspace_info",
    name: "workspace_info",
    exposedName: "workspace_info",
    version: "1.0.0",
    scope: "global",
    status: "active",
    description: workspaceInfoManifest.description,
    parameters: workspaceInfoManifest.parameters as Record<string, unknown>,
    manifest: workspaceInfoManifest,
    handler: async (ctx) => ({
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
            2,
          ),
        },
      ],
    }),
  };

  const failManifest = utilityManifest({
    id: "tool_utility_fail_tool",
    name: "fail_tool",
    description: "Intentionally throws an error with provided message",
    parameters: {
      type: "object",
      properties: {
        errorMessage: { type: "string" },
        isToolResultError: { type: "boolean" },
      },
    },
  });

  const failTool: RegistryTool = {
    toolId: "tool_utility_fail_tool",
    name: "fail_tool",
    exposedName: "fail_tool",
    version: "1.0.0",
    scope: "global",
    status: "active",
    description: failManifest.description,
    parameters: failManifest.parameters as Record<string, unknown>,
    manifest: failManifest,
    handler: async (_ctx, params) => {
      const msg =
        typeof params.errorMessage === "string" ? params.errorMessage : "Intentional tool failure";
      if (params.isToolResultError) {
        return { content: [{ type: "text", text: msg }], isError: true };
      }
      throw new Error(msg);
    },
  };

  const slowManifest = utilityManifest({
    id: "tool_utility_slow_tool",
    name: "slow_tool",
    description: "Asynchronous tool that delays and supports progress and cancellation",
    parameters: {
      type: "object",
      properties: {
        durationMs: { type: "number" },
        steps: { type: "number" },
      },
    },
  });

  const slowTool: RegistryTool = {
    toolId: "tool_utility_slow_tool",
    name: "slow_tool",
    exposedName: "slow_tool",
    version: "1.0.0",
    scope: "global",
    status: "active",
    description: slowManifest.description,
    parameters: slowManifest.parameters as Record<string, unknown>,
    manifest: slowManifest,
    handler: async (_ctx, params, options) => {
      const durationMs = typeof params.durationMs === "number" ? params.durationMs : 300;
      const steps = typeof params.steps === "number" ? params.steps : 3;
      const stepDelay = Math.max(10, Math.floor(durationMs / steps));

      for (let i = 1; i <= steps; i++) {
        if (options?.signal?.aborted) {
          throw new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Operation cancelled by client");
        }

        const { promise, resolve, reject } = withResolvers<void>();
        const timeout = setTimeout(() => {
          cleanup();
          resolve();
        }, stepDelay);

        const onAbort = () => {
          cleanup();
          reject(new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Operation cancelled by client"));
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
    },
  };

  return [echo, workspaceInfo, failTool, slowTool];
}
