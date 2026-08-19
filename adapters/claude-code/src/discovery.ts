import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { nowIso } from "@tool-evolver/contracts";
import type { ProbeInstallationOptions } from "@tool-evolver/harness-contracts";
import { type ConfigFsBridge, defaultFsBridge } from "@tool-evolver/harness-contracts";
import type {
  HarnessInstallation,
  HarnessWorkspace,
  InstallationStatus,
} from "@tool-evolver/harness-contracts";

const execFileAsync = promisify(execFile);

export type ExecFunction = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Default supported versions for Claude Code CLI.
 */
export const SUPPORTED_CLAUDE_VERSIONS = [">=0.1.0", ">=0.2.0", ">=1.0.0"];

/**
 * Minimal semver comparator for Claude Code versions (e.g. "0.2.14", "1.0.0").
 */
export function isSupportedClaudeVersion(versionStr: string, minMajor = 0, minMinor = 1): boolean {
  const match = versionStr.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (major > minMajor) return true;
  if (major === minMajor) return minor >= minMinor;
  return false;
}

/**
 * Detect host platform details including WSL.
 */
export function detectPlatform(
  platform = process.platform,
): "darwin" | "linux" | "wsl" | "win32" | "other" {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  if (platform === "linux") {
    if (
      process.env.WSL_DISTRO_NAME ||
      process.env.WSLENV ||
      (process.env.IS_WSL && process.env.IS_WSL !== "0")
    ) {
      return "wsl";
    }
    return "linux";
  }
  return "other";
}

/**
 * Resolve candidate Claude configuration directories based on platform.
 */
export function resolveClaudeHomeCandidates(
  platform = detectPlatform(),
  homeDir = os.homedir(),
): string[] {
  const candidates: string[] = [];

  switch (platform) {
    case "darwin":
      candidates.push(path.join(homeDir, "Library", "Application Support", "Claude"));
      candidates.push(path.join(homeDir, ".claude"));
      candidates.push(path.join(homeDir, ".config", "claude"));
      break;
    case "wsl":
      candidates.push(path.join(homeDir, ".claude"));
      candidates.push(path.join(homeDir, ".config", "claude"));
      // Also probe standard WSL Windows user profile path if available
      if (process.env.USERPROFILE) {
        candidates.push(path.join(process.env.USERPROFILE, ".claude"));
      }
      break;
    default:
      candidates.push(path.join(homeDir, ".claude"));
      if (process.env.XDG_CONFIG_HOME) {
        candidates.push(path.join(process.env.XDG_CONFIG_HOME, "claude"));
      }
      candidates.push(path.join(homeDir, ".config", "claude"));
      break;
  }

  return candidates;
}

/**
 * Resolve candidate Claude global config file paths.
 */
export function resolveClaudeConfigFileCandidates(
  homeDir = os.homedir(),
  platform = detectPlatform(),
): string[] {
  const homes = resolveClaudeHomeCandidates(platform, homeDir);
  const candidates: string[] = [];

  // Direct ~/.claude.json file
  candidates.push(path.join(homeDir, ".claude.json"));

  for (const home of homes) {
    candidates.push(path.join(home, "claude.json"));
    candidates.push(path.join(home, "mcp_settings.json"));
    candidates.push(path.join(home, "settings.json"));
  }

  return candidates;
}

/**
 * Resolve candidate Claude executable paths.
 */
export function resolveClaudeExecutableCandidates(
  homeDir = os.homedir(),
  platform = detectPlatform(),
): string[] {
  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push("/usr/local/bin/claude");
    candidates.push("/opt/homebrew/bin/claude");
  } else {
    candidates.push("/usr/local/bin/claude");
    candidates.push("/usr/bin/claude");
  }

  candidates.push(path.join(homeDir, ".npm-global", "bin", "claude"));
  candidates.push(path.join(homeDir, ".local", "bin", "claude"));
  candidates.push("claude");

  return candidates;
}

/**
 * Probes the local environment for an active Claude Code installation.
 */
export async function probeClaudeInstallation(
  options?: ProbeInstallationOptions,
  fsBridge: ConfigFsBridge = defaultFsBridge,
  execFn?: ExecFunction,
): Promise<HarnessInstallation> {
  const platform = detectPlatform();
  const homeDir = os.homedir();
  const detectedAt = nowIso();

  // 1. Resolve Executable Path
  let executablePath = options?.customExecutablePath;
  let rawVersionString: string | null = null;
  let status: InstallationStatus = "unknown";
  let isInstalled = false;

  const runner =
    execFn ||
    (async (file: string, args: string[]) => {
      return await execFileAsync(file, args, { timeout: 5000 });
    });

  if (!executablePath) {
    const candidates = resolveClaudeExecutableCandidates(homeDir, platform);
    for (const candidate of candidates) {
      if (candidate === "claude") {
        try {
          const { stdout } = await runner(candidate, ["--version"]);
          executablePath = candidate;
          rawVersionString = stdout.trim();
          break;
        } catch {
          // not found in PATH
        }
      } else {
        const exists = await fsBridge.exists(candidate);
        if (exists) {
          executablePath = candidate;
          break;
        }
      }
    }
  }

  // 2. Resolve Config & Home Paths
  let configPath = options?.customConfigPath;
  let homePath: string | undefined;

  const homeCandidates = resolveClaudeHomeCandidates(platform, homeDir);
  for (const candidate of homeCandidates) {
    if (await fsBridge.exists(candidate)) {
      homePath = candidate;
      break;
    }
  }
  if (!homePath && homeCandidates.length > 0) {
    homePath = homeCandidates[0];
  }

  if (!configPath) {
    const configCandidates = resolveClaudeConfigFileCandidates(homeDir, platform);
    for (const candidate of configCandidates) {
      if (await fsBridge.exists(candidate)) {
        configPath = candidate;
        break;
      }
    }
    if (!configPath) {
      configPath = path.join(homePath ?? homeDir, "claude.json");
    }
  }

  // 3. Attempt Version Detection if Executable is Found
  if (executablePath && !rawVersionString) {
    try {
      const { stdout } = await runner(executablePath, ["--version"]);
      rawVersionString = stdout.trim();
    } catch {
      // Execution failed
    }
  }

  // Parse Version
  let parsedVersion: string | undefined;
  if (rawVersionString) {
    const match = rawVersionString.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    if (match) {
      parsedVersion = match[1];
    }
  }

  // 4. Validate Installation Status
  if (executablePath && parsedVersion) {
    if (isSupportedClaudeVersion(parsedVersion)) {
      status = "ready";
      isInstalled = true;
    } else {
      status = "unsupported_version";
      isInstalled = true;
    }
  } else if (executablePath && !parsedVersion) {
    status = "corrupt";
    isInstalled = false;
  } else {
    status = "missing_executable";
    isInstalled = false;
  }

  // 5. Optional Permissions & Config Check
  if (options?.checkPermissions && configPath && isInstalled) {
    try {
      const configExists = await fsBridge.exists(configPath);
      if (configExists) {
        const content = await fsBridge.readFile(configPath);
        if (content !== null && content.trim().length > 0) {
          try {
            JSON.parse(content);
          } catch {
            status = "config_error";
          }
        }
      }
    } catch {
      status = "config_error";
    }
  }

  return {
    harnessId: "claude-code",
    displayName: "Claude Code",
    version: parsedVersion ?? "0.0.0",
    executablePath,
    configPath,
    homePath: homePath ?? homeDir,
    isInstalled,
    status,
    detectedAt,
    metadata: {
      platform,
      rawVersionString,
      checkedPermissions: Boolean(options?.checkPermissions),
    },
  };
}

/**
 * Detect workspaces / projects managed by Claude Code.
 */
export async function detectClaudeWorkspaces(
  customHome?: string,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<HarnessWorkspace[]> {
  const homeDir = customHome || os.homedir();
  const workspaces: HarnessWorkspace[] = [];

  const homeCandidates = resolveClaudeHomeCandidates(detectPlatform(), homeDir);
  const projectsDirs: string[] = [];

  for (const home of homeCandidates) {
    const projectsDir = path.join(home, "projects");
    if (await fsBridge.exists(projectsDir)) {
      projectsDirs.push(projectsDir);
    }
  }

  // Add current working directory workspace if .claude or claude.json exists
  const cwd = process.cwd();
  const cwdClaudeJson = path.join(cwd, ".claude.json");
  const cwdClaudeDir = path.join(cwd, ".claude");

  if ((await fsBridge.exists(cwdClaudeJson)) || (await fsBridge.exists(cwdClaudeDir))) {
    workspaces.push({
      workspaceId: `claude-ws-${path.basename(cwd)}`,
      name: path.basename(cwd),
      rootPath: cwd,
      harnessId: "claude-code",
      configPath: (await fsBridge.exists(cwdClaudeJson))
        ? cwdClaudeJson
        : path.join(cwdClaudeDir, "mcp_settings.json"),
      mcpConfigPath: (await fsBridge.exists(cwdClaudeJson))
        ? cwdClaudeJson
        : path.join(cwdClaudeDir, "mcp_settings.json"),
      metadata: { discoveredFrom: "cwd" },
    });
  }

  return workspaces;
}
