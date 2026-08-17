import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  type ToolManifest,
  ToolManifestSchema,
} from "@tool-evolver/contracts";
import { resolvePaths } from "@tool-evolver/observer";
import { BUNDLE_FILE_MANIFEST } from "../bundle/spec.js";

/**
 * Reference attached to a cached artifact to prevent garbage collection.
 */
export interface ArtifactReference {
  refId: string;
  refType: "active" | "canary" | "pinned" | "rollback" | "session" | "deployment";
  toolId?: string;
  version?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Extraction metadata stored in .extracted within the artifact directory.
 */
export interface ExtractionMetadata {
  digest: string;
  extractedAt: string;
  fileCount: number;
  totalSizeBytes: number;
  entrypoint: string;
  verified: boolean;
}

export interface ArtifactCacheOptions {
  cacheDir?: string;
}

/**
 * Content-addressed artifact cache managing extraction, staging, and reference counts.
 */
export class ArtifactCache {
  readonly cacheDir: string;
  readonly stagingDir: string;
  readonly quarantineDir: string;
  readonly refsFilePath: string;
  constructor(options: ArtifactCacheOptions = {}) {
    if (options.cacheDir) {
      this.cacheDir = path.resolve(options.cacheDir);
    } else {
      try {
        const daemonPaths = resolvePaths();
        this.cacheDir = path.join(daemonPaths.dataDir, "artifacts");
      } catch {
        this.cacheDir = path.join(os.homedir(), ".tool-evolver", "artifacts");
      }
    }
    this.stagingDir = path.join(this.cacheDir, ".staging");
    this.quarantineDir = path.join(this.cacheDir, "quarantine");
    this.refsFilePath = path.join(this.cacheDir, "refs.json");
  }

  /**
   * Ensures necessary base cache directories exist.
   */
  async ensureDirectories(): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    await fs.promises.mkdir(this.stagingDir, { recursive: true });
    await fs.promises.mkdir(this.quarantineDir, { recursive: true });
  }

  ensureDirectoriesSync(): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.quarantineDir, { recursive: true });
  }

  /**
   * Computes the directory path for a given content digest.
   */
  getArtifactPath(digest: string): string {
    const normalizedDigest = digest.replace(/^sha256:/i, "").toLowerCase();
    return path.join(this.cacheDir, normalizedDigest);
  }

  /**
   * Checks whether an artifact with the given digest is already extracted and valid.
   */
  hasArtifact(digest: string): boolean {
    const artifactPath = this.getArtifactPath(digest);
    if (!fs.existsSync(artifactPath)) return false;
    const manifestPath = path.join(artifactPath, BUNDLE_FILE_MANIFEST);
    return fs.existsSync(manifestPath);
  }

  /**
   * Reads and parses the ToolManifest for an extracted artifact.
   */
  getArtifactManifest(digest: string): ToolManifest | null {
    const artifactPath = this.getArtifactPath(digest);
    const manifestPath = path.join(artifactPath, BUNDLE_FILE_MANIFEST);
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const content = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(content);
      return ToolManifestSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  /**
   * Creates a dedicated temporary staging directory for atomic bundle extraction.
   */
  async createStagingDirectory(digest: string): Promise<string> {
    await this.ensureDirectories();
    const stagingId = `${digest.slice(0, 16)}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const stagingPath = path.join(this.stagingDir, stagingId);
    await fs.promises.mkdir(stagingPath, { recursive: true });
    return stagingPath;
  }

  /**
   * Atomically commits a staging directory to the content-addressed artifact directory.
   */
  async commitStagingDirectory(stagingPath: string, digest: string, metadata: ExtractionMetadata): Promise<string> {
    const targetPath = this.getArtifactPath(digest);

    // Write .extracted metadata in staging
    const metadataPath = path.join(stagingPath, ".extracted");
    await fs.promises.writeFile(metadataPath, canonicalJson(metadata), "utf8");

    // If target directory already exists (e.g. concurrent extraction), verify and remove staging
    if (fs.existsSync(targetPath)) {
      await fs.promises.rm(stagingPath, { recursive: true, force: true });
      return targetPath;
    }

    try {
      await fs.promises.rename(stagingPath, targetPath);
    } catch (err) {
      // Fallback for cross-device rename or race condition
      if (fs.existsSync(targetPath)) {
        await fs.promises.rm(stagingPath, { recursive: true, force: true });
        return targetPath;
      }
      throw err;
    }

    return targetPath;
  }

  /**
   * Verifies the integrity of an extracted artifact by re-validating manifest and file presence.
   */
  async verifyArtifactIntegrity(digest: string): Promise<boolean> {
    const artifactPath = this.getArtifactPath(digest);
    if (!fs.existsSync(artifactPath)) return false;

    const manifestPath = path.join(artifactPath, BUNDLE_FILE_MANIFEST);
    if (!fs.existsSync(manifestPath)) return false;

    try {
      const manifestRaw = await fs.promises.readFile(manifestPath, "utf8");
      ToolManifestSchema.parse(JSON.parse(manifestRaw));
      return true;
    } catch {
      return false;
    }
  }

  // --- Reference Count Management ---

  private readRefsSync(): Record<string, ArtifactReference[]> {
    if (!fs.existsSync(this.refsFilePath)) return {};
    try {
      const content = fs.readFileSync(this.refsFilePath, "utf8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async readRefs(): Promise<Record<string, ArtifactReference[]>> {
    if (!fs.existsSync(this.refsFilePath)) return {};
    try {
      const content = await fs.promises.readFile(this.refsFilePath, "utf8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async writeRefs(refs: Record<string, ArtifactReference[]>): Promise<void> {
    await this.ensureDirectories();
    const tempFile = `${this.refsFilePath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(tempFile, canonicalJson(refs), "utf8");
    await fs.promises.rename(tempFile, this.refsFilePath);
  }

  /**
   * Acquires a reference to an artifact digest.
   */
  async acquireReference(digest: string, ref: ArtifactReference): Promise<void> {
    const normalized = digest.replace(/^sha256:/i, "").toLowerCase();
    const refs = await this.readRefs();
    const existing = refs[normalized] ?? [];
    // Deduplicate by refId
    const filtered = existing.filter((r) => r.refId !== ref.refId);
    filtered.push(ref);
    refs[normalized] = filtered;
    await this.writeRefs(refs);
  }

  /**
   * Releases a specific reference by refId.
   */
  async releaseReference(digest: string, refId: string): Promise<boolean> {
    const normalized = digest.replace(/^sha256:/i, "").toLowerCase();
    const refs = await this.readRefs();
    if (!refs[normalized]) return false;

    const beforeLen = refs[normalized].length;
    refs[normalized] = refs[normalized].filter((r) => r.refId !== refId);

    if (refs[normalized].length === 0) {
      delete refs[normalized];
    }

    if (beforeLen !== (refs[normalized]?.length ?? 0)) {
      await this.writeRefs(refs);
      return true;
    }
    return false;
  }

  /**
   * Retrieves all active references for a specific digest.
   */
  async getReferences(digest: string): Promise<ArtifactReference[]> {
    const normalized = digest.replace(/^sha256:/i, "").toLowerCase();
    const refs = await this.readRefs();
    return refs[normalized] ?? [];
  }

  /**
   * Retrieves all artifact references map.
   */
  async getAllReferences(): Promise<Record<string, ArtifactReference[]>> {
    return this.readRefs();
  }

  /**
   * Checks if an artifact has any active references.
   */
  async hasReferences(digest: string): Promise<boolean> {
    const refs = await this.getReferences(digest);
    return refs.length > 0;
  }
}
