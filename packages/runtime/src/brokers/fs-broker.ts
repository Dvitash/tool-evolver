import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FsCapability } from "@tool-evolver/contracts";
import {
  expandWorkspacePlaceholder,
  isPathInsideRoot,
  matchesPathPattern,
  normalizeSlashes,
  validatePathCharacters,
} from "../policy/canonicalizers.js";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";

/**
 * Standard sensitive or hidden paths that require explicit inclusion.
 */
const SENSITIVE_PATH_PATTERNS = [
  "**/.git/**",
  "**/.git",
  "**/.ssh/**",
  "**/.ssh",
  "**/.aws/**",
  "**/.aws",
  "**/.env*",
  "**/id_rsa*",
  "**/id_ed25519*",
  "/etc/shadow",
  "/etc/passwd",
  "/etc/sudoers",
];

export interface FileStatResult {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mtime: string;
  mode?: number;
}

export interface ReadFileParams {
  path: string;
  encoding?: "utf-8" | "base64" | "buffer";
}

export interface ReadFileResult {
  content: string;
  encoding: string;
  size: number;
}

export interface WriteFileParams {
  path: string;
  content: string | Uint8Array;
  encoding?: "utf-8" | "base64";
  atomic?: boolean;
}

export interface AppendFileParams {
  path: string;
  content: string | Uint8Array;
  encoding?: "utf-8" | "base64";
}

export interface RenameParams {
  oldPath: string;
  newPath: string;
}

export interface DeleteParams {
  path: string;
  recursive?: boolean;
}

export interface CreateDirectoryParams {
  path: string;
  recursive?: boolean;
}

export interface ListDirectoryParams {
  path?: string;
  recursive?: boolean;
}

/**
 * Capability broker for all filesystem access.
 * Enforces grant presence, allowed/denied roots, traversal containment,
 * symlink verification, max file size limits, and atomic writes.
 */
export class FilesystemBroker extends BaseCapabilityBroker {
  readonly serviceName = "fs" as const;

  constructor(options: BaseCapabilityBrokerOptions = {}) {
    super(options);
  }

  /**
   * Resolves and verifies that a target path is allowed for read or write operations.
   */
  private resolveAndAuthorizePath(
    rawPath: string,
    mode: "read" | "write" | "delete",
    context: BrokerContext,
    fsCap: FsCapability
  ): string {
    if (!rawPath || typeof rawPath !== "string") {
      throw new BrokerSecurityError("INVALID_PATH", "Path must be a non-empty string");
    }

    validatePathCharacters(rawPath);

    const workspaceRoot = normalizeSlashes(
      path.resolve(context.workspaceRoot ?? process.cwd())
    );
    const scratchDir = context.scratchDir
      ? normalizeSlashes(path.resolve(context.scratchDir))
      : undefined;

    // Expand placeholders
    const expanded = expandWorkspacePlaceholder(rawPath, workspaceRoot);

    // Normalize and resolve path
    const resolvedPath = path.isAbsolute(expanded)
      ? normalizeSlashes(path.resolve(expanded))
      : normalizeSlashes(path.resolve(workspaceRoot, expanded));

    // Unicode normalization
    const canonicalTarget = resolvedPath.normalize("NFC");

    // Check denied paths (strict precedence)
    const denyPatterns = fsCap.denyPaths ?? [];
    for (const denyPattern of denyPatterns) {
      if (matchesPathPattern(canonicalTarget, denyPattern, workspaceRoot)) {
        throw new BrokerSecurityError(
          "PATH_DENIED",
          `Path is explicitly denied by capability policy: ${rawPath}`,
          { path: rawPath, deniedByPattern: denyPattern }
        );
      }
    }

    // Check default sensitive paths unless explicitly allowed in readPaths or writePaths
    const isExplicitlyAllowed = (mode === "read" ? fsCap.readPaths : fsCap.writePaths)?.some((pattern) =>
      matchesPathPattern(canonicalTarget, pattern, workspaceRoot)
    );

    if (!isExplicitlyAllowed) {
      for (const sensitivePattern of SENSITIVE_PATH_PATTERNS) {
        if (matchesPathPattern(canonicalTarget, sensitivePattern, workspaceRoot)) {
          throw new BrokerSecurityError(
            "HIDDEN_FILE_DENIED",
            `Access to sensitive or hidden path is denied: ${rawPath}`,
            { path: rawPath }
          );
        }
      }
    }

    // Check allowed roots
    let isAllowed = false;

    // 1. Workspace root
    if (fsCap.allowWorkspaceRoot && isPathInsideRoot(canonicalTarget, workspaceRoot)) {
      isAllowed = true;
    }

    // 2. Temp / Scratch root
    if (fsCap.allowTemp && scratchDir && isPathInsideRoot(canonicalTarget, scratchDir)) {
      isAllowed = true;
    }

    // 3. Explicit readPaths / writePaths
    const explicitPatterns = mode === "read" ? fsCap.readPaths : fsCap.writePaths;
    if (explicitPatterns && explicitPatterns.length > 0) {
      for (const pattern of explicitPatterns) {
        if (matchesPathPattern(canonicalTarget, pattern, workspaceRoot)) {
          isAllowed = true;
          break;
        }
      }
    }

    if (!isAllowed) {
      throw new BrokerSecurityError(
        "OUTSIDE_ALLOWED_ROOT",
        `Path is outside authorized ${mode} roots: ${rawPath}`,
        { path: rawPath, mode }
      );
    }
    // Symlink / Realpath containment check
    this.verifySymlinkContainment(canonicalTarget, workspaceRoot, scratchDir, fsCap);

    return canonicalTarget;
  }

  /**
   * Verifies that symlinks do not target paths outside authorized roots.
   */
  private verifySymlinkContainment(
    targetPath: string,
    workspaceRoot: string,
    scratchDir: string | undefined,
    fsCap: FsCapability
  ): void {
    let checkPath = targetPath;

    // Find the deepest existing parent or the path itself
    while (!fs.existsSync(checkPath)) {
      const parent = path.dirname(checkPath);
      if (parent === checkPath) break;
      checkPath = parent;
    }

    if (fs.existsSync(checkPath)) {
      try {
        const realTarget = normalizeSlashes(fs.realpathSync(checkPath));
        let realAllowed = false;

        if (fsCap.allowWorkspaceRoot && isPathInsideRoot(realTarget, workspaceRoot)) {
          realAllowed = true;
        }
        if (fsCap.allowTemp && scratchDir && isPathInsideRoot(realTarget, scratchDir)) {
          realAllowed = true;
        }

        const allExplicit = [...(fsCap.readPaths ?? []), ...(fsCap.writePaths ?? [])];
        for (const pattern of allExplicit) {
          if (matchesPathPattern(realTarget, pattern, workspaceRoot)) {
            realAllowed = true;
            break;
          }
        }

        if (!realAllowed) {
          throw new BrokerSecurityError(
            "SYMLINK_ESCAPE",
            `Symlink target escapes authorized capability roots: ${checkPath} -> ${realTarget}`,
            { path: checkPath, realTarget }
          );
        }
      } catch (err) {
        if (err instanceof BrokerSecurityError) throw err;
        // If realpath fails, fail closed
        throw new BrokerSecurityError("INVALID_PATH", `Failed to resolve real path for ${checkPath}`);
      }
    }
  }

  /**
   * Stat a file or directory.
   */
  async stat(params: { path: string }, context: BrokerContext): Promise<FileStatResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "read", context, fsCap);
      if (!fs.existsSync(targetPath)) {
        throw new BrokerSecurityError("FILE_NOT_FOUND", `File or directory not found: ${params.path}`);
      }

      const stat = fs.statSync(targetPath);
      const lstat = fs.lstatSync(targetPath);

      const result: FileStatResult = {
        size: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: lstat.isSymbolicLink(),
        mtime: stat.mtime.toISOString(),
        mode: stat.mode,
      };

      this.recordAudit("stat", context, "allowed", { path: params.path, size: stat.size }, {
        durationMs: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      const err = error instanceof BrokerSecurityError
        ? error
        : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);
      this.recordAudit("stat", context, "denied", { path: params.path }, {
        error: { code: err.code, message: err.message },
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  /**
   * Check if a path exists.
   */
  async exists(params: { path: string }, context: BrokerContext): Promise<{ exists: boolean }> {
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "read", context, fsCap);
      const exists = fs.existsSync(targetPath);
      return { exists };
    } catch (error) {
      if (error instanceof BrokerSecurityError && (error.code === "PATH_DENIED" || error.code === "OUTSIDE_ALLOWED_ROOT")) {
        throw error;
      }
      return { exists: false };
    }
  }

  /**
   * Read file contents with max size enforcement.
   */
  async readFile(params: ReadFileParams, context: BrokerContext): Promise<ReadFileResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};
    const maxSizeBytes = fsCap.maxFileSizeBytes ?? 10485760; // 10MB default

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "read", context, fsCap);

      if (!fs.existsSync(targetPath)) {
        throw new BrokerSecurityError("FILE_NOT_FOUND", `File not found: ${params.path}`);
      }

      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", `Cannot readFile on directory: ${params.path}`);
      }

      if (stat.size > maxSizeBytes) {
        throw new BrokerSecurityError(
          "MAX_FILE_SIZE_EXCEEDED",
          `File size ${stat.size} bytes exceeds maximum allowed limit ${maxSizeBytes} bytes`,
          { size: stat.size, maxSizeBytes }
        );
      }

      // Track output budget
      this.trackOutputBytes(context.invocationId, stat.size, grant.capabilities.limits);

      const encoding = params.encoding ?? "utf-8";
      const buffer = fs.readFileSync(targetPath);
      const content = encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf-8");

      this.recordAudit("readFile", context, "allowed", {
        path: params.path,
        size: stat.size,
        encoding,
      }, { durationMs: Date.now() - startTime });

      return {
        content,
        encoding,
        size: stat.size,
      };
    } catch (error) {
      const err = error instanceof BrokerSecurityError
        ? error
        : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);
      this.recordAudit("readFile", context, "denied", { path: params.path }, {
        error: { code: err.code, message: err.message },
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  /**
   * Write file contents atomically with max size enforcement.
   */
  async writeFile(params: WriteFileParams, context: BrokerContext): Promise<{ bytesWritten: number }> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};
    const maxSizeBytes = fsCap.maxFileSizeBytes ?? 10485760;

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "write", context, fsCap);

      const buffer = typeof params.content === "string"
        ? (params.encoding === "base64" ? Buffer.from(params.content, "base64") : Buffer.from(params.content, "utf-8"))
        : Buffer.from(params.content);

      if (buffer.length > maxSizeBytes) {
        throw new BrokerSecurityError(
          "MAX_FILE_SIZE_EXCEEDED",
          `Content size ${buffer.length} bytes exceeds maximum allowed limit ${maxSizeBytes} bytes`,
          { size: buffer.length, maxSizeBytes }
        );
      }

      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const isAtomic = params.atomic !== false;
      if (isAtomic) {
        const tempPath = path.join(parentDir, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
        try {
          fs.writeFileSync(tempPath, buffer);
          fs.renameSync(tempPath, targetPath);
        } catch (writeErr) {
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch {}
          throw writeErr;
        }
      } else {
        fs.writeFileSync(targetPath, buffer);
      }

      this.recordAudit("writeFile", context, "allowed", {
        path: params.path,
        bytesWritten: buffer.length,
        atomic: isAtomic,
      }, { durationMs: Date.now() - startTime });

      return { bytesWritten: buffer.length };
    } catch (error) {
      const err = error instanceof BrokerSecurityError
        ? error
        : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);
      this.recordAudit("writeFile", context, "denied", { path: params.path }, {
        error: { code: err.code, message: err.message },
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  /**
   * Append content to a file.
   */
  async appendFile(params: AppendFileParams, context: BrokerContext): Promise<{ bytesWritten: number }> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};
    const maxSizeBytes = fsCap.maxFileSizeBytes ?? 10485760;

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "write", context, fsCap);

      const buffer = typeof params.content === "string"
        ? (params.encoding === "base64" ? Buffer.from(params.content, "base64") : Buffer.from(params.content, "utf-8"))
        : Buffer.from(params.content);

      const existingSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
      if (existingSize + buffer.length > maxSizeBytes) {
        throw new BrokerSecurityError(
          "MAX_FILE_SIZE_EXCEEDED",
          `Total file size ${existingSize + buffer.length} bytes would exceed maximum allowed limit ${maxSizeBytes} bytes`,
          { totalSize: existingSize + buffer.length, maxSizeBytes }
        );
      }

      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.appendFileSync(targetPath, buffer);

      this.recordAudit("appendFile", context, "allowed", {
        path: params.path,
        bytesWritten: buffer.length,
      }, { durationMs: Date.now() - startTime });

      return { bytesWritten: buffer.length };
    } catch (error) {
      const err = error instanceof BrokerSecurityError
        ? error
        : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);
      this.recordAudit("appendFile", context, "denied", { path: params.path }, {
        error: { code: err.code, message: err.message },
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  /**
   * Rename a file or directory within authorized roots.
   */
  async rename(params: RenameParams, context: BrokerContext): Promise<void> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const oldTarget = this.resolveAndAuthorizePath(params.oldPath, "delete", context, fsCap);
      const newTarget = this.resolveAndAuthorizePath(params.newPath, "write", context, fsCap);

      if (!fs.existsSync(oldTarget)) {
        throw new BrokerSecurityError("FILE_NOT_FOUND", `Source path not found: ${params.oldPath}`);
      }

      const parentDir = path.dirname(newTarget);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.renameSync(oldTarget, newTarget);

      this.recordAudit("rename", context, "allowed", {
        oldPath: params.oldPath,
        newPath: params.newPath,
      }, { durationMs: Date.now() - startTime });
    } catch (error) {
      const err = error instanceof BrokerSecurityError
        ? error
        : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);
      this.recordAudit("rename", context, "denied", { oldPath: params.oldPath, newPath: params.newPath }, {
        error: { code: err.code, message: err.message },
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  /**
   * Delete a file or directory.
   */
  async delete(params: DeleteParams, context: BrokerContext): Promise<void> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "delete", context, fsCap);

      if (!fs.existsSync(targetPath)) {
        return; // Idempotent delete
      }

      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: params.recursive ?? false, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }

      this.recordAudit("delete", context, "allowed", {
        path: params.path,
        recursive: params.recursive,
      }, { durationMs: Date.now() - startTime });
    } catch (error) {
      const err = error instanceof BrokerSecurityError
        ? error
        : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);
      this.recordAudit("delete", context, "denied", { path: params.path }, {
        error: { code: err.code, message: err.message },
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  /**
   * Alias for delete.
   */
  async removeFile(params: { path: string }, context: BrokerContext): Promise<void> {
    return this.delete(params, context);
  }

  /**
   * Create directory.
   */
  async createDirectory(params: CreateDirectoryParams, context: BrokerContext): Promise<void> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "write", context, fsCap);

      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: params.recursive !== false });
      }

      this.recordAudit("createDirectory", context, "allowed", {
        path: params.path,
        recursive: params.recursive,
      }, { durationMs: Date.now() - startTime });
    } catch (error) {
      const err = error instanceof BrokerSecurityError
        ? error
        : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);
      this.recordAudit("createDirectory", context, "denied", { path: params.path }, {
        error: { code: err.code, message: err.message },
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  /**
   * List directory contents.
   */
  async listDirectory(params: ListDirectoryParams, context: BrokerContext): Promise<string[]> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};
    const dirPath = params.path ?? ".";

    try {
      const targetPath = this.resolveAndAuthorizePath(dirPath, "read", context, fsCap);

      if (!fs.existsSync(targetPath)) {
        throw new BrokerSecurityError("FILE_NOT_FOUND", `Directory not found: ${dirPath}`);
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
        throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", `Path is not a directory: ${dirPath}`);
      }

      const entries: string[] = [];
      const readEntries = (currentDir: string, relativePrefix: string) => {
        const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const dirent of dirents) {
          const entryRel = relativePrefix ? `${relativePrefix}/${dirent.name}` : dirent.name;
          entries.push(entryRel);
          if (params.recursive && dirent.isDirectory()) {
            readEntries(path.join(currentDir, dirent.name), entryRel);
          }
        }
      };

      readEntries(targetPath, "");

      this.recordAudit("listDirectory", context, "allowed", {
        path: dirPath,
        entryCount: entries.length,
        recursive: params.recursive,
      }, { durationMs: Date.now() - startTime });

      return entries;
    } catch (error) {
      const err = error instanceof BrokerSecurityError
        ? error
        : new BrokerSecurityError("OPERATION_NOT_PERMITTED", (error as Error).message);
      this.recordAudit("listDirectory", context, "denied", { path: dirPath }, {
        error: { code: err.code, message: err.message },
        durationMs: Date.now() - startTime,
      });
      throw err;
    }
  }

  /**
   * Alias for listDirectory.
   */
  async listDir(params: ListDirectoryParams, context: BrokerContext): Promise<string[]> {
    return this.listDirectory(params, context);
  }
}
