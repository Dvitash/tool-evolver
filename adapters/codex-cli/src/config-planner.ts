import {
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  applyConfigMutation,
  defaultFsBridge,
  planConfigMutation,
  rollbackConfigMutation,
} from "@tool-evolver/harness-contracts";
import { CODEX_HARNESS_ID } from "./discovery.js";

export const DEFAULT_GATEWAY_SERVER_NAME = "tool_evolver_gateway";

/**
 * Options for planning Codex MCP configuration mutations.
 */
export interface PlanCodexMcpConfigOptions {
  targetPath: string;
  gatewayUrl: string;
  serverName?: string;
  fsBridge?: ConfigFsBridge;
  currentContent?: string | null;
}

/**
 * Updates or inserts an MCP server definition into TOML content while preserving comments and existing structure.
 */
export function updateTomlMcpConfig(
  content: string,
  serverName: string,
  gatewayUrl: string,
): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return `# Codex CLI Configuration\n\n[mcp_servers.${serverName}]\nurl = "${gatewayUrl}"\n`;
  }

  // Look for existing section headers for this server:
  // [mcp_servers.<name>] or [mcpServers.<name>] or ["mcp_servers".<name>]
  const sectionHeaderRegex = new RegExp(
    `^\\[\\s*(?:mcp_servers|mcpServers|mcp\\.servers)\\.${escapeRegExp(serverName)}\\s*\\]`,
    "m",
  );

  const match = content.match(sectionHeaderRegex);
  if (match && match.index !== undefined) {
    const startIndex = match.index;
    // Find the end of this section (start of next section '[' at start of line or EOF)
    const afterHeaderIndex = startIndex + match[0].length;
    const rest = content.slice(afterHeaderIndex);
    const nextSectionMatch = rest.match(/\n\s*\[/);

    const sectionEnd =
      nextSectionMatch && nextSectionMatch.index !== undefined
        ? afterHeaderIndex + nextSectionMatch.index
        : content.length;

    const sectionBody = content.slice(startIndex, sectionEnd);

    // Check if url is already exactly matching
    const urlMatch = sectionBody.match(/^\s*url\s*=\s*"([^"]+)"/m);
    if (urlMatch && urlMatch[1] === gatewayUrl) {
      // No change needed
      return content;
    }

    // Replace the section with updated URL while keeping the header style
    const header = match[0];
    const newSection = `${header}\nurl = "${gatewayUrl}"`;
    const before = content.slice(0, startIndex);
    const after = content.slice(sectionEnd);

    return `${before}${newSection}${after}`;
  }

  // Section does not exist - append it cleanly to the TOML file
  const suffix = content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}\n[mcp_servers.${serverName}]\nurl = "${gatewayUrl}"\n`;
}

/**
 * Updates or inserts an MCP server definition into JSON content while preserving existing keys.
 */
export function updateJsonMcpConfig(
  content: string,
  serverName: string,
  gatewayUrl: string,
): string {
  const trimmed = content.trim();
  let parsed: Record<string, unknown> = {};

  if (trimmed) {
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // If invalid JSON, initialize new structure
      parsed = {};
    }
  }

  // Use existing convention if present (mcpServers vs mcp_servers)
  const serversKey = "mcp_servers" in parsed ? "mcp_servers" : "mcpServers";

  const currentServers =
    typeof parsed[serversKey] === "object" && parsed[serversKey] !== null
      ? (parsed[serversKey] as Record<string, unknown>)
      : {};

  const existingServer = currentServers[serverName];
  if (
    typeof existingServer === "object" &&
    existingServer !== null &&
    (existingServer as Record<string, unknown>).url === gatewayUrl
  ) {
    // Exact match: return original content to preserve byte-exact formatting
    return content;
  }

  const updatedServers = {
    ...currentServers,
    [serverName]: {
      url: gatewayUrl,
    },
  };

  const updatedConfig = {
    ...parsed,
    [serversKey]: updatedServers,
  };

  return `${JSON.stringify(updatedConfig, null, 2)}\n`;
}

/**
 * Plans an atomic configuration modification to register the Tool Evolver Gateway in Codex config.
 */
export async function planCodexMcpConfig(
  options: PlanCodexMcpConfigOptions,
): Promise<ConfigMutationPlan> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const serverName = options.serverName ?? DEFAULT_GATEWAY_SERVER_NAME;

  let currentContent: string | null = null;
  if (options.currentContent !== undefined) {
    currentContent = options.currentContent;
  } else {
    currentContent = await fsBridge.readFile(options.targetPath);
  }

  const isJson = options.targetPath.endsWith(".json");
  const plannedContent = isJson
    ? updateJsonMcpConfig(currentContent ?? "", serverName, options.gatewayUrl)
    : updateTomlMcpConfig(currentContent ?? "", serverName, options.gatewayUrl);

  const diffDescription = `Register Tool Evolver Gateway MCP server (${serverName} -> ${options.gatewayUrl}) in ${options.targetPath}`;

  return planConfigMutation({
    harnessId: CODEX_HARNESS_ID,
    targetPath: options.targetPath,
    currentContent,
    plannedContent,
    description: diffDescription,
  });
}

/**
 * Applies a planned MCP configuration mutation, creating a restorable backup.
 */
export async function applyCodexMcpConfig(
  plan: ConfigMutationPlan,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<ConfigBackup> {
  return applyConfigMutation(plan, fsBridge);
}

/**
 * Rolls back a previous configuration mutation using its backup.
 */
export async function rollbackCodexMcpConfig(
  backup: ConfigBackup,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<void> {
  return rollbackConfigMutation(backup, fsBridge);
}

/**
 * Verifies that the Tool Evolver Gateway is properly registered in the Codex configuration.
 */
export async function verifyCodexMcpConfig(
  targetPath: string,
  gatewayUrl?: string,
  serverName: string = DEFAULT_GATEWAY_SERVER_NAME,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<boolean> {
  const content = await fsBridge.readFile(targetPath);
  if (!content) return false;

  if (targetPath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const servers = (parsed.mcpServers ?? parsed.mcp_servers) as
        | Record<string, unknown>
        | undefined;
      if (!servers || typeof servers !== "object") return false;

      const server = servers[serverName] as Record<string, unknown> | undefined;
      if (!server || typeof server !== "object") return false;

      if (gatewayUrl) {
        return server.url === gatewayUrl;
      }
      return typeof server.url === "string" && server.url.length > 0;
    } catch {
      return false;
    }
  }

  // Check TOML
  const escapedName = escapeRegExp(serverName);
  const headerRegex = new RegExp(
    `^\\[\\s*(?:mcp_servers|mcpServers|mcp\\.servers)\\.${escapedName}\\s*\\]`,
    "m",
  );
  if (!headerRegex.test(content)) return false;

  if (gatewayUrl) {
    const escapedUrl = escapeRegExp(gatewayUrl);
    const urlRegex = new RegExp(`^\\s*url\\s*=\\s*"${escapedUrl}"`, "m");
    return urlRegex.test(content);
  }

  return /^\s*url\s*=\s*"[^"]+"/m.test(content);
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
