import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ConfigPreconditionFailedError, HarnessPermissionError } from "./errors.js";
import type { ConfigBackup, ConfigMutationPlan } from "./types.js";

/**
 * Computes deterministic SHA-256 hash of a string content.
 */
export function computeConfigHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Verifies whether the current configuration content matches the expected precondition hash.
 */
export function verifyPreconditionHash(
  currentContent: string | null,
  expectedHash: string,
): boolean {
  if (currentContent === null) {
    return expectedHash === "" || expectedHash === "sha256:empty";
  }
  const actualHash = computeConfigHash(currentContent);
  const normalizedExpected = expectedHash.startsWith("sha256:")
    ? expectedHash.slice(7)
    : expectedHash;
  return actualHash.toLowerCase() === normalizedExpected.toLowerCase();
}

/**
 * Filesystem abstraction bridge for configuration planning and mutation.
 */
export interface ConfigFsBridge {
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  mkdirp(dirPath: string): Promise<void>;
  copyFile(srcPath: string, destPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

/**
 * Default Node.js filesystem implementation of ConfigFsBridge.
 */
export class NodeConfigFsBridge implements ConfigFsBridge {
  async readFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      if ((err as NodeJS.ErrnoException).code === "EACCES") {
        throw new HarnessPermissionError(`Permission denied reading ${filePath}`, {
          targetPath: filePath,
          cause: err,
        });
      }
      throw err;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EACCES") {
        throw new HarnessPermissionError(`Permission denied writing ${filePath}`, {
          targetPath: filePath,
          cause: err,
        });
      }
      throw err;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const dir = path.dirname(destPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(srcPath, destPath);
  }

  async unlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

/**
 * In-memory filesystem bridge for fast, deterministic unit testing and mocking.
 */
export class InMemoryConfigFsBridge implements ConfigFsBridge {
  private files = new Map<string, string>();

  async readFile(filePath: string): Promise<string | null> {
    const normalized = path.normalize(filePath);
    return this.files.get(normalized) ?? null;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const normalized = path.normalize(filePath);
    this.files.set(normalized, content);
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = path.normalize(filePath);
    return this.files.has(normalized);
  }

  async mkdirp(_dirPath: string): Promise<void> {
    // No-op for in-memory flat map
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const src = path.normalize(srcPath);
    const dest = path.normalize(destPath);
    const content = this.files.get(src);
    if (content === undefined) {
      throw new Error(`Source file ${srcPath} does not exist`);
    }
    this.files.set(dest, content);
  }

  async unlink(filePath: string): Promise<void> {
    const normalized = path.normalize(filePath);
    this.files.delete(normalized);
  }

  clear(): void {
    this.files.clear();
  }

  dump(): Record<string, string> {
    return Object.fromEntries(this.files.entries());
  }
}

export const defaultFsBridge = new NodeConfigFsBridge();

/**
 * Plans a configuration modification, capturing the current precondition hash.
 */
export function planConfigMutation(options: {
  harnessId: string;
  targetPath: string;
  currentContent: string | null;
  plannedContent: string;
  description?: string;
  backupPath?: string;
  metadata?: Record<string, unknown>;
}): ConfigMutationPlan {
  const planId = randomUUID();
  const preconditionHash =
    options.currentContent === null ? "" : computeConfigHash(options.currentContent);
  const now = new Date().toISOString();
  const defaultBackupPath = `${options.targetPath}.backup.${Date.now()}`;

  return {
    planId,
    harnessId: options.harnessId,
    targetPath: options.targetPath,
    preconditionHash,
    plannedContent: options.plannedContent,
    backupPath: options.backupPath ?? defaultBackupPath,
    description: options.description ?? `Update configuration for ${options.harnessId}`,
    createdAt: now,
    metadata: options.metadata ?? {},
  };
}

/**
 * Applies a planned configuration mutation with precondition checking and atomic backup creation.
 */
export async function applyConfigMutation(
  plan: ConfigMutationPlan,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<ConfigBackup> {
  const currentContent = await fsBridge.readFile(plan.targetPath);

  if (!verifyPreconditionHash(currentContent, plan.preconditionHash)) {
    const actualHash = currentContent === null ? "empty" : computeConfigHash(currentContent);
    throw new ConfigPreconditionFailedError(
      `Precondition failed for ${plan.targetPath}: expected hash ${plan.preconditionHash || "empty"}, got ${actualHash}`,
      {
        harnessId: plan.harnessId,
        targetPath: plan.targetPath,
        expectedHash: plan.preconditionHash,
        actualHash,
      },
    );
  }

  const backupId = randomUUID();
  const now = new Date().toISOString();
  const backupPath = plan.backupPath ?? `${plan.targetPath}.backup.${Date.now()}`;
  const originalContent = currentContent ?? "";
  const contentHash = computeConfigHash(originalContent);

  // If previous content existed, write backup
  if (currentContent !== null) {
    await fsBridge.writeFile(backupPath, originalContent);
  }

  // Apply new content
  await fsBridge.writeFile(plan.targetPath, plan.plannedContent);

  return {
    backupId,
    targetPath: plan.targetPath,
    backupPath,
    contentHash,
    originalContent,
    createdAt: now,
    restored: false,
  };
}

/**
 * Rolls back a previously applied configuration mutation from a backup record.
 */
export async function rollbackConfigMutation(
  backup: ConfigBackup,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<void> {
  if (backup.restored) {
    return;
  }

  if (backup.originalContent === "") {
    // If the original file did not exist, delete target
    await fsBridge.unlink(backup.targetPath);
  } else {
    // Restore original content
    await fsBridge.writeFile(backup.targetPath, backup.originalContent);
  }

  backup.restored = true;
  backup.restoredAt = new Date().toISOString();
}

/**
 * Verifies that the configuration at targetPath matches expected content or expected hash.
 */
export async function verifyConfigIntegrity(
  targetPath: string,
  expectedContentOrHash: string,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<boolean> {
  const content = await fsBridge.readFile(targetPath);
  if (content === null) {
    return false;
  }
  if (content === expectedContentOrHash) {
    return true;
  }
  const hash = computeConfigHash(content);
  const normalizedExpected = expectedContentOrHash.startsWith("sha256:")
    ? expectedContentOrHash.slice(7)
    : expectedContentOrHash;
  return hash.toLowerCase() === normalizedExpected.toLowerCase();
}
