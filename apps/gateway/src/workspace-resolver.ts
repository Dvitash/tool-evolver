import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InitializeParams, McpClientInfo, McpRoot } from "./protocol/types.js";

export type WorkspaceResolutionSource = "roots" | "init_param" | "harness_session" | "cwd_fallback";

export interface ResolvedWorkspaceRoot {
  uri: string;
  path: string;
  name?: string;
}

export interface WorkspaceContext {
  workspaceId: string;
  canonicalRoot: string;
  name: string;
  source: WorkspaceResolutionSource;
  roots: ResolvedWorkspaceRoot[];
  gitRoot?: string;
  harnessId?: string;
  sessionId?: string;
}

export interface WorkspaceResolutionOptions {
  initParams?: InitializeParams;
  harnessId?: string;
  sessionId?: string;
  clientInfo?: McpClientInfo;
  cwd?: string;
  customRoots?: McpRoot[];
  env?: Record<string, string | undefined>;
}

/**
 * Converts a URI or filesystem path to an absolute, normalized filesystem path.
 */
export function uriOrPathToFsPath(raw: string): string {
  if (raw.startsWith("file://")) {
    try {
      return path.normalize(fileURLToPath(raw));
    } catch {
      // Fallback manual parse if malformed URI
      const cleaned = raw.replace(/^file:\/\//, "");
      return path.normalize(decodeURIComponent(cleaned));
    }
  }
  return path.resolve(raw);
}

/**
 * Canonicalizes a filesystem path by resolving symlinks and normalizing separators.
 */
export function canonicalizePath(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  try {
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
  } catch {
    // If realpath fails (e.g. permission or nonexistent in tests), use resolved
  }
  return path.normalize(resolved);
}

/**
 * Finds the enclosing git root (.git folder or worktree file) if it exists.
 */
export function findGitRoot(startDir: string): string | undefined {
  let current = canonicalizePath(startDir);
  const root = path.parse(current).root;

  while (current && current !== root) {
    const gitPath = path.join(current, ".git");
    try {
      if (fs.existsSync(gitPath)) {
        return current;
      }
    } catch {
      // Skip permission errors
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * Generates a stable, deterministic workspace ID based on the canonical filesystem path.
 */
export function generateWorkspaceId(canonicalRoot: string): string {
  const hash = crypto.createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
  const baseName = path.basename(canonicalRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `ws_${baseName || "root"}_${hash}`;
}

/**
 * Resolves workspace context using the 3-tier priority hierarchy:
 * 1. MCP roots capability / Initialize params (rootUri, rootPath, workspaceFolders, customRoots)
 * 2. Harness session association / Environment variables / Client metadata
 * 3. Current working directory fallback
 */
export function resolveWorkspaceContext(
  options: WorkspaceResolutionOptions = {},
): WorkspaceContext {
  const env = options.env ?? process.env;
  const initParams = options.initParams;
  const customRoots = options.customRoots;

  const collectedRoots: ResolvedWorkspaceRoot[] = [];
  let candidatePath: string | undefined;
  let source: WorkspaceResolutionSource = "cwd_fallback";

  // Tier 1: MCP roots capability / custom roots
  if (customRoots && customRoots.length > 0) {
    for (const root of customRoots) {
      const fsPath = canonicalizePath(uriOrPathToFsPath(root.uri));
      collectedRoots.push({
        uri: root.uri,
        path: fsPath,
        name: root.name,
      });
    }
    candidatePath = collectedRoots[0].path;
    source = "roots";
  } else if (initParams?.workspaceFolders && initParams.workspaceFolders.length > 0) {
    for (const folder of initParams.workspaceFolders) {
      const fsPath = canonicalizePath(uriOrPathToFsPath(folder.uri));
      collectedRoots.push({
        uri: folder.uri,
        path: fsPath,
        name: folder.name,
      });
    }
    candidatePath = collectedRoots[0].path;
    source = "roots";
  } else if (initParams?.rootUri) {
    const fsPath = canonicalizePath(uriOrPathToFsPath(initParams.rootUri));
    collectedRoots.push({
      uri: initParams.rootUri,
      path: fsPath,
      name: path.basename(fsPath),
    });
    candidatePath = fsPath;
    source = "init_param";
  } else if (initParams?.rootPath) {
    const fsPath = canonicalizePath(uriOrPathToFsPath(initParams.rootPath));
    collectedRoots.push({
      uri: `file://${fsPath}`,
      path: fsPath,
      name: path.basename(fsPath),
    });
    candidatePath = fsPath;
    source = "init_param";
  }

  // Tier 2: Harness session association / Environment variables
  if (!candidatePath) {
    const envWorkspace =
      env.TOOL_EVOLVER_WORKSPACE ||
      env.CLAUDE_WORKSPACE ||
      env.CODEX_WORKSPACE ||
      env.OMP_WORKSPACE;

    if (envWorkspace && envWorkspace.trim().length > 0) {
      candidatePath = canonicalizePath(uriOrPathToFsPath(envWorkspace.trim()));
      source = "harness_session";
    }
  }

  // Tier 3: CWD fallback
  if (!candidatePath) {
    const fallbackCwd = options.cwd ?? process.cwd();
    candidatePath = canonicalizePath(fallbackCwd);
    source = "cwd_fallback";
  }

  const canonicalRoot = candidatePath;
  const gitRoot = findGitRoot(canonicalRoot);
  const workspaceId = generateWorkspaceId(canonicalRoot);
  const name = collectedRoots[0]?.name || path.basename(canonicalRoot) || "workspace";

  if (collectedRoots.length === 0) {
    collectedRoots.push({
      uri: `file://${canonicalRoot}`,
      path: canonicalRoot,
      name,
    });
  }

  return {
    workspaceId,
    canonicalRoot,
    name,
    source,
    roots: collectedRoots,
    gitRoot,
    harnessId: options.harnessId,
    sessionId: options.sessionId,
  };
}
