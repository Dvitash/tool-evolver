import { isSafetyGateBypassTool } from "@tool-evolver/contracts";
import type { SafetyGateEvaluator } from "@tool-evolver/runtime";
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

function normalizeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameRegisteredVersion(left: RegistryTool, right: RegistryTool): boolean {
  return left.toolId === right.toolId && left.version === right.version;
}

/**
 * Factory for creating the invoke_tool handler.
 */
export function createInvokeToolHandler(
  registry: ToolRegistry,
  invocationRouter: ToolInvocationRouter,
  safetyGateEvaluator?: SafetyGateEvaluator,
): ToolHandler {
  return async (
    context: WorkspaceContext,
    rawParams: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> => {
    const params = (rawParams || {}) as InvokeToolParams;
    const publicName = normalizeIdentifier(params.name) ?? normalizeIdentifier(params.tool_name);
    const toolId = normalizeIdentifier(params.toolId);
    const displayIdentifier = publicName ?? toolId;

    if (!displayIdentifier) {
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

    const controls = await registry.controls.getControls(context.workspaceId);
    const accessibleTools = registry
      .getAllRegisteredTools()
      .filter((candidate) => isToolInScope(candidate, context));
    const nameMatches = publicName
      ? accessibleTools.filter(
          (candidate) => candidate.name === publicName || candidate.exposedName === publicName,
        )
      : [];
    const idMatches = toolId
      ? accessibleTools.filter((candidate) => candidate.toolId === toolId)
      : [];

    let matchingTools: RegistryTool[];
    if (nameMatches.length > 0 && idMatches.length > 0) {
      const intersection = nameMatches.filter((nameMatch) =>
        idMatches.some((idMatch) => sameRegisteredVersion(nameMatch, idMatch)),
      );
      if (intersection.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Conflicting tool identifiers: name '${publicName}' and toolId '${toolId}' resolve to different tools.`,
            },
          ],
        };
      }
      matchingTools = intersection;
    } else if (nameMatches.length > 0) {
      // Public names remain stable across local/cloud registry revisions. A stale internal
      // toolId must not make an otherwise unambiguous public-name invocation fail.
      matchingTools = nameMatches;
    } else {
      matchingTools = idMatches;
    }

    if (matchingTools.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${displayIdentifier}' not found or not accessible in workspace '${context.workspaceId}'.`,
          },
        ],
      };
    }

    let resolvedTool: RegistryTool | undefined;
    if (params.version && typeof params.version === "string") {
      const requestedVer = params.version.trim();
      resolvedTool = matchingTools.find((candidate) => candidate.version === requestedVer);
      if (!resolvedTool) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Version '${requestedVer}' of tool '${displayIdentifier}' not found. Available versions: ${matchingTools.map((candidate) => candidate.version).join(", ")}.`,
            },
          ],
        };
      }
    } else {
      const pinnedVer = controls.pinnedVersions[matchingTools[0].toolId];
      if (pinnedVer) {
        resolvedTool = matchingTools.find((candidate) => candidate.version === pinnedVer);
      }
      if (!resolvedTool) {
        const latestVer = registry.getLatestRegisteredVersion(matchingTools[0].toolId);
        if (latestVer) {
          resolvedTool = matchingTools.find((candidate) => candidate.version === latestVer);
        }
      }
      if (!resolvedTool) {
        resolvedTool = matchingTools[0];
      }
    }

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

    if (
      safetyGateEvaluator &&
      !resolvedTool.isSystem &&
      !isSafetyGateBypassTool(resolvedTool.name) &&
      !isSafetyGateBypassTool(resolvedTool.toolId)
    ) {
      const gateCheck = safetyGateEvaluator.canExecuteTool(
        resolvedTool.toolId,
        resolvedTool.name,
        Boolean(resolvedTool.isSystem),
      );
      if (!gateCheck.allowed && gateCheck.refusal) {
        return {
          isError: true,
          content: gateCheck.refusal.content,
          _meta: { refusal: gateCheck.refusal },
        };
      }
    }

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

    const timeoutMs =
      (typeof params.timeout_ms === "number" && params.timeout_ms > 0
        ? params.timeout_ms
        : undefined) ??
      options?.timeoutMs ??
      resolvedTool.manifest?.limits?.timeoutMs ??
      30000;

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
      return await invocationRouter.invoke({
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
    } catch (error) {
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
      const message = error instanceof Error ? error.message : String(error);
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
