import {
  type NormalizedCommandExecEvent,
  type NormalizedFileEditEvent,
  NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import type { Episode, EpisodeSignature, ToolClass } from "./types.js";

/**
 * Normalizes file paths to generic semantic aliases.
 */
export function normalizePathAlias(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") return "$PATH";
  const cleaned = rawPath.replace(/\\/g, "/").trim();

  // Test files
  if (
    /\.(test|spec)\.[a-zA-Z0-9]+$/.test(cleaned) ||
    /\/tests?\//.test(cleaned) ||
    /\/__tests__\//.test(cleaned) ||
    cleaned.startsWith("test_")
  ) {
    return "$TEST_FILE";
  }

  // Configuration files
  if (
    /(package\.json|tsconfig.*\.json|Cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|\.env.*|.*config\.[a-zA-Z0-9]+)$/.test(
      cleaned,
    )
  ) {
    return "$CONFIG_FILE";
  }

  // Documentation files
  if (/\.(md|mdx|rst|txt)$/i.test(cleaned) || /\/docs?\//.test(cleaned)) {
    return "$DOC_FILE";
  }

  // Build / output directories
  if (/(^|\/)(dist|build|target|out|\.next|\.turbo)(\/|$)/.test(cleaned)) {
    return "$BUILD_DIR";
  }

  // Temporary paths
  if (/(^|\/)(tmp|temp|\.tmp)(\/|$)/.test(cleaned)) {
    return "$TMP_DIR";
  }

  // Source files
  if (
    /(^|\/)(src|lib|app|pkg|internal|components|routes)(\/|$)/.test(cleaned) ||
    /\.(ts|tsx|js|jsx|rs|go|py|java|c|cpp|h|hpp|rb|php|swift|kt)$/i.test(cleaned)
  ) {
    return "$SRC_FILE";
  }

  return "$PATH";
}

/**
 * Normalizes a tool name into a canonical lowercase identifier.
 */
function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/**
 * Normalizes an observed command into a stable, non-shell command profile.
 * Paths are reduced to semantic aliases while executable, subcommand, and flags remain exact.
 */
export function normalizeCommandProfile(rawCommand: string): string {
  const normalized = rawCommand
    .replace(/[\r\n\0]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return "";

  return normalized
    .split(" ")
    .slice(0, 32)
    .map((part, index) => {
      if (index === 0) {
        const portable = part.replace(/\\/g, "/");
        return portable.slice(portable.lastIndexOf("/") + 1).toLowerCase();
      }
      if (part.startsWith("-")) return part;
      if (part.includes("/") || /\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java)$/i.test(part)) {
        return normalizePathAlias(part);
      }
      return part;
    })
    .join(" ");
}

/**
 * Classifies a tool or command into a high-level ToolClass.
 */
export function classifyToolOrCommand(name: string, commandText?: string): ToolClass {
  const lowerName = name.toLowerCase();

  // 1. File Read
  if (
    lowerName.includes("read") ||
    lowerName.includes("view") ||
    lowerName === "cat" ||
    lowerName === "head" ||
    lowerName === "tail" ||
    lowerName === "file_read"
  ) {
    return "file_read";
  }

  // 2. File Edit
  if (
    lowerName.includes("edit") ||
    lowerName.includes("write") ||
    lowerName.includes("patch") ||
    lowerName === "replace" ||
    lowerName === "sed" ||
    lowerName === "file_edit"
  ) {
    return "file_edit";
  }

  // 3. Search / Grep / Glob
  if (
    lowerName.includes("grep") ||
    lowerName.includes("glob") ||
    lowerName.includes("find") ||
    lowerName.includes("search")
  ) {
    return "search";
  }

  // 4. Test Runner
  if (
    lowerName.includes("test") ||
    lowerName.includes("vitest") ||
    lowerName.includes("jest") ||
    lowerName.includes("pytest") ||
    (commandText &&
      /\b(vitest|jest|pytest|cargo test|pnpm test|npm test|go test)\b/i.test(commandText))
  ) {
    return "test_runner";
  }

  // 5. Build Tool
  if (
    lowerName.includes("build") ||
    lowerName.includes("tsc") ||
    lowerName.includes("compile") ||
    (commandText &&
      /\b(pnpm build|npm run build|cargo build|make|webpack|vite build|tsc)\b/i.test(commandText))
  ) {
    return "build_tool";
  }

  // 6. VCS (Git)
  if (
    lowerName.includes("git") ||
    lowerName.includes("vcs") ||
    (commandText && /\bgit\b/i.test(commandText))
  ) {
    return "vcs";
  }

  // 7. Package Manager
  if (
    lowerName.includes("pnpm") ||
    lowerName.includes("npm") ||
    lowerName.includes("yarn") ||
    lowerName.includes("cargo") ||
    lowerName.includes("pip") ||
    (commandText && /\b(pnpm add|pnpm i|npm install|cargo add|pip install)\b/i.test(commandText))
  ) {
    return "package_manager";
  }

  // 8. Subagent / Task Delegation
  if (
    lowerName.includes("agent") ||
    lowerName.includes("subagent") ||
    lowerName.includes("task") ||
    lowerName.includes("delegate")
  ) {
    return "subagent";
  }

  // 9. Browser
  if (
    lowerName.includes("browser") ||
    lowerName.includes("playwright") ||
    lowerName.includes("puppeteer") ||
    lowerName.includes("chromium")
  ) {
    return "browser";
  }

  // 10. Shell Exec
  if (
    lowerName === "bash" ||
    lowerName === "sh" ||
    lowerName === "exec" ||
    lowerName === "command_exec" ||
    lowerName === "shell" ||
    lowerName === "terminal"
  ) {
    return "shell_exec";
  }

  return "general";
}

/**
 * Computes an argument shape descriptor and hash.
 * Discards volatile values (timestamps, file contents) while preserving argument structure and flags.
 */
function extractArgumentShape(args: unknown): string {
  if (args === null || args === undefined) return "nil";
  if (typeof args !== "object") return typeof args;

  if (Array.isArray(args)) {
    const elementTypes = args.slice(0, 5).map((item) => {
      if (typeof item === "string") {
        if (item.startsWith("-")) return item; // Preserve flags like -v, --cached
        return normalizePathAlias(item);
      }
      return typeof item;
    });
    return `[${elementTypes.join(",")}]`;
  }

  const shape: Record<string, string> = {};
  const entries = Object.entries(args as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [key, val] of entries) {
    if (val === null || val === undefined) {
      shape[key] = "null";
    } else if (typeof val === "string") {
      if (key.toLowerCase().includes("path") || key.toLowerCase().includes("file")) {
        shape[key] = normalizePathAlias(val);
      } else if (val.startsWith("-")) {
        shape[key] = val;
      } else {
        shape[key] = "string";
      }
    } else if (typeof val === "object") {
      shape[key] = Array.isArray(val) ? "array" : "object";
    } else {
      shape[key] = typeof val;
    }
  }

  return hashCanonicalContent(shape);
}

/**
 * Deterministic structural feature extractor for Workflow Episodes.
 */
export class SignatureExtractor {
  /**
   * Extracts a deterministic EpisodeSignature from an Episode.
   */
  extractSignature(episode: Episode): EpisodeSignature {
    const operationSequence: string[] = [];
    const toolClasses: ToolClass[] = [];
    const commandPatterns: string[] = [];
    const normalizedPaths: Set<string> = new Set();
    const argumentShapeHashes: string[] = [];
    const errorTypes: Set<string> = new Set();

    for (const evt of episode.events) {
      if (evt.type === "tool_call") {
        const toolEvt = evt as NormalizedToolCallEvent;
        const normName = normalizeToolName(toolEvt.toolName);
        const op = `tool:${normName}`;
        operationSequence.push(op);

        const rawCommand =
          toolEvt.parameters && typeof toolEvt.parameters === "object"
            ? ((toolEvt.parameters as Record<string, unknown>).command ??
              (toolEvt.parameters as Record<string, unknown>).cmd ??
              (toolEvt.parameters as Record<string, unknown>).executable)
            : undefined;
        const commandText = typeof rawCommand === "string" ? rawCommand : undefined;
        const cls = classifyToolOrCommand(toolEvt.toolName, commandText);
        toolClasses.push(cls);
        if (commandText) {
          const commandProfile = normalizeCommandProfile(commandText);
          if (commandProfile) commandPatterns.push(commandProfile);
        }

        const argHash = extractArgumentShape(toolEvt.parameters);
        argumentShapeHashes.push(argHash);

        // Extract path parameters if present
        if (toolEvt.parameters && typeof toolEvt.parameters === "object") {
          for (const [k, v] of Object.entries(toolEvt.parameters)) {
            if (
              typeof v === "string" &&
              (k.toLowerCase().includes("path") || k.toLowerCase().includes("file"))
            ) {
              normalizedPaths.add(normalizePathAlias(v));
            }
          }
        }
      } else if (evt.type === "command_exec") {
        const cmdEvt = evt as NormalizedCommandExecEvent;
        const cmdName = cmdEvt.command.split(" ")[0] || "cmd";
        const normCmd = normalizeToolName(cmdName);
        const op = `command:${normCmd}`;
        operationSequence.push(op);

        const cls = classifyToolOrCommand(cmdName, cmdEvt.command);
        toolClasses.push(cls);

        const commandProfile = normalizeCommandProfile(
          [cmdEvt.command, ...(cmdEvt.args ?? [])].join(" "),
        );
        if (commandProfile) commandPatterns.push(commandProfile);

        const argHash = extractArgumentShape(cmdEvt.args);
        argumentShapeHashes.push(argHash);

        if (cmdEvt.cwd) {
          normalizedPaths.add(normalizePathAlias(cmdEvt.cwd));
        }
      } else if (evt.type === "file_edit") {
        const editEvt = evt as NormalizedFileEditEvent;
        const normPath = normalizePathAlias(editEvt.filePath);
        const op = `edit:${normPath}`;
        operationSequence.push(op);
        toolClasses.push("file_edit");
        argumentShapeHashes.push(extractArgumentShape({ path: normPath, type: editEvt.operation }));
      } else if (evt.type === "error") {
        const errorRecord = evt as unknown as {
          error?: { code?: string; message?: string };
          code?: string;
        };
        const code = errorRecord.code || errorRecord.error?.code || "GENERIC_ERROR";
        errorTypes.add(code);
      }
    }

    // Compute structural hash deterministically over canonical representation
    const structuralDescriptor = {
      ops: operationSequence,
      classes: toolClasses,
      commands: commandPatterns,
      args: argumentShapeHashes,
    };
    const structuralHash = hashCanonicalContent(structuralDescriptor);

    const signatureId = `sig_${structuralHash.slice(0, 16)}`;

    return {
      signatureId,
      structuralHash,
      operationSequence,
      toolClasses,
      commandPatterns,
      normalizedPaths: Array.from(normalizedPaths),
      argumentShapeHashes,
      stepCount: episode.metrics.stepCount,
      totalDurationMs: episode.metrics.totalDurationMs,
      totalTokens: episode.metrics.totalTokens,
      retryCount: episode.metrics.retryCount,
      estimatedCostUsd: episode.metrics.estimatedCostUsd,
      errorTypes: Array.from(errorTypes),
    };
  }
}

/**
 * Convenience function to extract an EpisodeSignature from an Episode.
 */
export function extractEpisodeSignature(episode: Episode): EpisodeSignature {
  const extractor = new SignatureExtractor();
  return extractor.extractSignature(episode);
}
