import path from "node:path";
import {
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  type HarnessWorkspace,
  NodeConfigFsBridge,
  applyConfigMutation,
  computeConfigHash,
  planConfigMutation,
  rollbackConfigMutation,
  verifyConfigIntegrity,
} from "@tool-evolver/harness-contracts";
import { resolveOmpHome } from "./discovery.js";

export const DEFAULT_OMP_CONFIG_FILENAME = "config.json";
export const DEFAULT_GATEWAY_SERVER_NAME = "tool-evolver-gateway";

export interface PlanOmpMcpConfigOptions {
  workspace?: HarnessWorkspace;
  gatewayUrl: string;
  ompHome?: string;
  customConfigPath?: string;
  fsBridge?: ConfigFsBridge;
  serverName?: string;
  serverType?: "sse" | "http" | "stdio";
}

export interface VerifyOmpMcpConfigOptions {
  workspace?: HarnessWorkspace;
  gatewayUrl?: string;
  fsBridge?: ConfigFsBridge;
  customConfigPath?: string;
  ompHome?: string;
  serverName?: string;
}

/**
 * Resolves the target configuration path for an OMP workspace or global install.
 */
export function resolveOmpConfigPath(
  workspace?: HarnessWorkspace,
  options?: { customConfigPath?: string; ompHome?: string },
): string {
  if (options?.customConfigPath) {
    return path.resolve(options.customConfigPath);
  }
  if (workspace?.mcpConfigPath) {
    return path.resolve(workspace.mcpConfigPath);
  }
  if (workspace?.configPath) {
    return path.resolve(workspace.configPath);
  }
  if (workspace?.rootPath) {
    return path.resolve(workspace.rootPath, ".omp", DEFAULT_OMP_CONFIG_FILENAME);
  }
  const ompHome = resolveOmpHome({ customHome: options?.ompHome });
  return path.resolve(ompHome, DEFAULT_OMP_CONFIG_FILENAME);
}

/**
 * Plans a configuration mutation that registers the Tool Evolver Gateway in OMP's MCP configuration.
 * Preserves all existing extensions, user settings, and other MCP servers.
 */
export async function planOmpMcpConfig(
  options: PlanOmpMcpConfigOptions,
): Promise<ConfigMutationPlan> {
  const fsBridge = options.fsBridge ?? new NodeConfigFsBridge();
  const targetPath = resolveOmpConfigPath(options.workspace, {
    customConfigPath: options.customConfigPath,
    ompHome: options.ompHome,
  });

  const serverName = options.serverName ?? DEFAULT_GATEWAY_SERVER_NAME;
  const currentContent = await fsBridge.readFile(targetPath);

  let currentConfig: Record<string, unknown> = {};
  if (currentContent !== null && currentContent.trim().length > 0) {
    try {
      currentConfig = JSON.parse(currentContent) as Record<string, unknown>;
    } catch {
      currentConfig = {};
    }
  }

  // Preserve existing mcpServers, extensions, tools, settings, etc.
  const existingMcpServers =
    typeof currentConfig.mcpServers === "object" && currentConfig.mcpServers !== null
      ? { ...(currentConfig.mcpServers as Record<string, unknown>) }
      : {};

  const serverEntry: Record<string, unknown> = {
    url: options.gatewayUrl,
    type: options.serverType ?? "sse",
  };

  const updatedMcpServers = {
    ...existingMcpServers,
    [serverName]: serverEntry,
  };

  const updatedConfig: Record<string, unknown> = {
    ...currentConfig,
    mcpServers: updatedMcpServers,
  };

  const plannedContent = `${JSON.stringify(updatedConfig, null, 2)}\n`;

  return planConfigMutation({
    harnessId: "omp",
    targetPath,
    currentContent,
    plannedContent,
    description: `Register Tool Evolver Gateway MCP server "${serverName}" in OMP configuration`,
    metadata: {
      changesSummary: `Add/update mcpServers.${serverName} -> ${options.gatewayUrl}`,
    },
  });
}

/**
 * Atomically applies a planned OMP MCP configuration mutation with automatic backup creation.
 */
export async function applyOmpMcpConfig(
  plan: ConfigMutationPlan,
  fsBridge?: ConfigFsBridge,
): Promise<ConfigBackup> {
  const bridge = fsBridge ?? new NodeConfigFsBridge();
  return applyConfigMutation(plan, bridge);
}

/**
 * Verifies that OMP configuration correctly contains the Tool Evolver Gateway MCP registration.
 */
export async function verifyOmpMcpConfig(
  optionsOrWorkspace: VerifyOmpMcpConfigOptions | HarnessWorkspace,
  options?: VerifyOmpMcpConfigOptions,
): Promise<boolean> {
  const mergedOptions: VerifyOmpMcpConfigOptions =
    "workspaceId" in optionsOrWorkspace
      ? { workspace: optionsOrWorkspace as HarnessWorkspace, ...options }
      : optionsOrWorkspace;

  const bridge = mergedOptions.fsBridge ?? new NodeConfigFsBridge();
  const targetPath = resolveOmpConfigPath(mergedOptions.workspace, {
    customConfigPath: mergedOptions.customConfigPath,
    ompHome: mergedOptions.ompHome,
  });

  const content = await bridge.readFile(targetPath);
  if (content === null) {
    return false;
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || typeof mcpServers !== "object") {
      return false;
    }

    const serverName = mergedOptions.serverName ?? DEFAULT_GATEWAY_SERVER_NAME;
    const serverEntry = mcpServers[serverName] as Record<string, unknown> | undefined;
    if (!serverEntry || typeof serverEntry !== "object") {
      return false;
    }

    if (mergedOptions.gatewayUrl) {
      const entryUrl = serverEntry.url ?? serverEntry.endpoint;
      return entryUrl === mergedOptions.gatewayUrl;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Rolls back a previous OMP configuration mutation from backup.
 */
export async function rollbackOmpMcpConfig(
  backup: ConfigBackup,
  fsBridge?: ConfigFsBridge,
): Promise<void> {
  const bridge = fsBridge ?? new NodeConfigFsBridge();
  await rollbackConfigMutation(backup, bridge);
}

export { computeConfigHash, verifyConfigIntegrity };
