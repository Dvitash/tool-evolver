import type { CallToolResult } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import type { ToolInvocationRouter } from "./router-contract.js";
import { isToolInScope } from "./search-tools.js";
import { validateParameters } from "./validator-helper.js";

export interface InvokeToolParams {
  toolId?: string;
  name?: string;
  tool_name?: string;
  parameters?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  version?: string;
  timeout_ms?: number;
}

/**
 * Factory for creating the invoke_tool handler.
 */
export function createInvokeToolHandler(
  registry: ToolRegistry,
  invocationRouter: ToolInvocationRouter,
): ToolHandler {
  return async (
    context: WorkspaceContext,
    rawParams: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> => {
    const params = (rawParams || {}) as InvokeToolParams;
    const identifier = params.toolId ?? params.name ?? params.tool_name;

    if (!identifier || typeof identifier !== "string" || !identifier.trim()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Parameter 'toolId' or 'name' is required for tool invocation.",
          },
        ],
      };
    }

    const trimmedId = identifier.trim();
    const targetParams = (params.parameters ?? params.arguments ?? {}) as Record<string, unknown>;

    if (typeof targetParams !== "object" || targetParams === null || Array.isArray(targetParams)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Parameter 'parameters' must be a JSON object.",
          },
        ],
      };
    }

    // Retrieve user controls for the caller's workspace
    const controls = await registry.controls.getControls(context.workspaceId);

    // Look up installed tools matching the identifier
    const allInstalled = registry.getAllRegisteredTools();
    const matchingTools = allInstalled.filter(
      (t) =>
        (t.toolId === trimmedId || t.name === trimmedId || t.exposedName === trimmedId) &&
        isToolInScope(t, context),
    );

    if (matchingTools.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${trimmedId}' not found or not accessible in workspace '${context.workspaceId}'.`,
          },
        ],
      };
    }

    // Resolve target version
    let resolvedTool: RegistryTool | undefined;
    if (params.version && typeof params.version === "string") {
      const requestedVer = params.version.trim();
      resolvedTool = matchingTools.find((t) => t.version === requestedVer);
      if (!resolvedTool) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Version '${requestedVer}' of tool '${trimmedId}' not found. Available versions: ${matchingTools.map((t) => t.version).join(", ")}.`,
            },
          ],
        };
      }
    } else {
      // Check user pinned version
      const pinnedVer = controls.pinnedVersions[matchingTools[0].toolId];
      if (pinnedVer) {
        resolvedTool = matchingTools.find((t) => t.version === pinnedVer);
      }
      if (!resolvedTool) {
        // Use latest registered version
        const latestVer = registry.getLatestRegisteredVersion(matchingTools[0].toolId);
        if (latestVer) {
          resolvedTool = matchingTools.find((t) => t.version === latestVer);
        }
      }
      if (!resolvedTool) {
        resolvedTool = matchingTools[0];
      }
    }

    // Check if tool is disabled
    const isDisabled =
      controls.disabledTools.includes(resolvedTool.toolId) && !resolvedTool.isSystem;
    if (isDisabled) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${resolvedTool.name}' (${resolvedTool.toolId}) is disabled in workspace '${context.workspaceId}'.`,
          },
        ],
      };
    }

    // Validate parameters strictly against the manifest parameter schema
    const paramSchema = resolvedTool.parameters ?? resolvedTool.manifest?.parameters;
    const validation = validateParameters(paramSchema, targetParams);
    if (!validation.valid) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Parameter validation failed for tool '${resolvedTool.name}': ${validation.errors.join("; ")}`,
          },
        ],
      };
    }

    // Determine execution timeout
    const timeoutMs =
      (typeof params.timeout_ms === "number" && params.timeout_ms > 0
        ? params.timeout_ms
        : undefined) ??
      options?.timeoutMs ??
      resolvedTool.manifest?.limits?.timeoutMs ??
      30000;

    // Set up AbortController for timeout & caller cancellation
    const abortController = new AbortController();
    let timedOut = false;
    let timerId: NodeJS.Timeout | undefined;

    if (timeoutMs > 0 && timeoutMs < Number.POSITIVE_INFINITY) {
      timerId = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    const parentSignal = options?.signal;
    const onParentAbort = () => {
      abortController.abort(new Error("Tool invocation cancelled by caller"));
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        clearTimeout(timerId);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool invocation for '${resolvedTool.name}' was cancelled.`,
            },
          ],
        };
      }
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      const result = await invocationRouter.invoke({
        toolId: resolvedTool.toolId,
        name: resolvedTool.name,
        version: resolvedTool.version,
        parameters: targetParams,
        context,
        manifest: resolvedTool.manifest,
        signal: abortController.signal,
        onProgress: options?.onProgress,
        timeoutMs,
      });
      return result;
    } catch (err) {
      if (timedOut) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool '${resolvedTool.name}' timed out after ${timeoutMs}ms.`,
            },
          ],
        };
      }
      if (abortController.signal.aborted || parentSignal?.aborted) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool invocation for '${resolvedTool.name}' was cancelled.`,
            },
          ],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${message}`,
          },
        ],
      };
    } finally {
      clearTimeout(timerId);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onParentAbort);
      }
    }
  };
}
