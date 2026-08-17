import fs from "node:fs";
import path from "node:path";
import { type ToolManifest, ToolManifestSchema } from "@tool-evolver/contracts";
import { type ExtractedTarEntry, computeSha256, parseTarArchive } from "../bundle/builder.js";
import {
  type BundleSignatureData,
  type KeyStore,
  type SignatureVerificationResult,
  createDevelopmentKeyStore,
  verifyBundleSignature,
} from "../bundle/signature.js";
import {
  BUNDLE_FILE_ENTRYPOINT_JS,
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_PACKAGE,
  BUNDLE_FILE_SIGNATURE,
  type BundleLimits,
  DEFAULT_BUNDLE_LIMITS,
} from "../bundle/spec.js";
import { ArtifactCache, type ArtifactReference } from "./cache.js";
import {
  type BundleInspectionResult,
  inspectBundleArchive,
  inspectBundleDirectory,
} from "./inspector.js";
import { QuarantineManager, type QuarantineReason } from "./quarantine.js";
import {
  BundleResourceTracker,
  BundleSecurityError,
  resolveSafeTargetPath,
  validateNoSymlinkEscapes,
} from "./security-checks.js";

export class BundleValidationError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BundleValidationError";
    this.details = details;
  }
}

export class BundleSignatureError extends Error {
  readonly keyId?: string;
  readonly reason?: string;

  constructor(message: string, keyId?: string, reason?: string) {
    super(message);
    this.name = "BundleSignatureError";
    this.keyId = keyId;
    this.reason = reason;
  }
}

export interface ToolBundleLoaderOptions {
  cache?: ArtifactCache;
  quarantine?: QuarantineManager;
  keyStore?: KeyStore;
  limits?: Partial<BundleLimits>;
  allowDevKeys?: boolean;
}

export interface LoadBundleOptions {
  expectedDigest?: string;
  requireSignature?: boolean;
  allowDevKeys?: boolean;
  reference?: ArtifactReference;
  forceReExtract?: boolean;
}

/**
 * Represent an extracted, validated, and cached tool bundle ready for execution.
 */
export interface LoadedToolBundle {
  digest: string;
  artifactDir: string;
  entrypointPath: string;
  manifest: ToolManifest;
  inspection: BundleInspectionResult;
  isCached: boolean;
}

/**
 * Main orchestrator for verifying, safely extracting, validating, and caching tool bundles.
 */
export class ToolBundleLoader {
  readonly cache: ArtifactCache;
  readonly quarantine: QuarantineManager;
  readonly keyStore: KeyStore;
  readonly limits: BundleLimits;
  readonly allowDevKeys: boolean;

  constructor(options: ToolBundleLoaderOptions = {}) {
    this.cache = options.cache ?? new ArtifactCache();
    this.quarantine =
      options.quarantine ?? new QuarantineManager({ quarantineDir: this.cache.quarantineDir });
    this.keyStore = options.keyStore ?? createDevelopmentKeyStore();
    this.limits = { ...DEFAULT_BUNDLE_LIMITS, ...options.limits };
    this.allowDevKeys = options.allowDevKeys ?? true;
  }

  /**
   * Loads a tool bundle from an archive buffer, archive file path, or directory.
   */
  async loadBundle(
    bundleInput: Buffer | string,
    options: LoadBundleOptions = {},
  ): Promise<LoadedToolBundle> {
    if (typeof bundleInput === "string" && fs.existsSync(bundleInput)) {
      const stats = await fs.promises.stat(bundleInput);
      if (stats.isDirectory()) {
        return this.loadFromDirectory(bundleInput, options);
      }
      const archiveBuffer = await fs.promises.readFile(bundleInput);
      return this.loadFromArchiveBuffer(archiveBuffer, options, bundleInput);
    }

    if (Buffer.isBuffer(bundleInput)) {
      return this.loadFromArchiveBuffer(bundleInput, options);
    }

    throw new Error("Invalid bundle input: must be a Buffer or valid file/directory path");
  }

  /**
   * Loads and extracts a bundle from a tar archive buffer.
   */
  private async loadFromArchiveBuffer(
    archiveBuffer: Buffer,
    options: LoadBundleOptions,
    sourceIdentifier?: string,
  ): Promise<LoadedToolBundle> {
    const rawDigest = computeSha256(archiveBuffer);
    const digest = options.expectedDigest
      ? options.expectedDigest.replace(/^sha256:/i, "").toLowerCase()
      : rawDigest;

    // Check if already extracted and valid in cache
    if (!options.forceReExtract && this.cache.hasArtifact(digest)) {
      const isHealthy = await this.cache.verifyArtifactIntegrity(digest);
      if (isHealthy) {
        const artifactDir = this.cache.getArtifactPath(digest);
        const manifest = this.cache.getArtifactManifest(digest);
        if (manifest) {
          if (options.reference) {
            await this.cache.acquireReference(digest, options.reference);
          }
          const inspection = await inspectBundleDirectory(artifactDir, {
            keyStore: this.keyStore,
            allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
          });
          const entrypointPath = path.join(artifactDir, inspection.entrypoint);
          return {
            digest,
            artifactDir,
            entrypointPath,
            manifest,
            inspection,
            isCached: true,
          };
        }
      }
    }

    let stagingPath: string | null = null;

    try {
      // Check expected digest match if provided
      if (options.expectedDigest && rawDigest !== digest) {
        throw new BundleSecurityError(
          "DIGEST_MISMATCH",
          `Bundle digest mismatch: expected ${digest}, computed ${rawDigest}`,
          sourceIdentifier,
        );
      }

      // 1. Parse tar entries
      let entries: ExtractedTarEntry[];
      try {
        entries = parseTarArchive(archiveBuffer);
      } catch (parseErr) {
        throw new BundleValidationError(`Corrupted archive: ${String(parseErr)}`);
      }

      // 2. Locate and verify signature if required or present
      const sigEntry = entries.find((e) => e.path === BUNDLE_FILE_SIGNATURE);
      let signatureData: BundleSignatureData | undefined;

      if (sigEntry) {
        try {
          signatureData = JSON.parse(sigEntry.content.toString("utf8"));
          const verifyResult = await verifyBundleSignature(signatureData!, this.keyStore, {
            allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
          });

          if (!verifyResult.valid) {
            throw new BundleSignatureError(
              `Bundle signature verification failed: ${verifyResult.error ?? verifyResult.reason}`,
              verifyResult.keyId,
              verifyResult.reason,
            );
          }
        } catch (err) {
          if (err instanceof BundleSignatureError) throw err;
          throw new BundleSignatureError(`Invalid signature.json payload: ${String(err)}`);
        }
      } else if (options.requireSignature) {
        throw new BundleSignatureError("Bundle is unsigned but signature is required by policy");
      }
      // 3. Stage extraction with security & resource checks
      stagingPath = await this.cache.createStagingDirectory(digest);
      const tracker = new BundleResourceTracker(archiveBuffer.length, this.limits);

      for (const entry of entries) {
        // Enforce path traversal check
        const targetPath = resolveSafeTargetPath(stagingPath, entry.path);

        // Enforce resource limits & decompression bomb protection
        tracker.trackEntry(entry.path, entry.size);

        // Ensure parent directory exists
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

        // Write file safely
        await fs.promises.writeFile(targetPath, entry.content, {
          mode: (entry.mode & 0o111) !== 0 ? 0o755 : 0o644,
        });

        // Ensure no symlink escapes
        validateNoSymlinkEscapes(stagingPath, targetPath);
      }

      // 4. Validate manifest & layout
      const manifestPath = path.join(stagingPath, BUNDLE_FILE_MANIFEST);
      if (!fs.existsSync(manifestPath)) {
        throw new BundleValidationError(`Bundle is missing required ${BUNDLE_FILE_MANIFEST}`);
      }

      const manifestContent = await fs.promises.readFile(manifestPath, "utf8");
      let manifest: ToolManifest;
      try {
        manifest = ToolManifestSchema.parse(JSON.parse(manifestContent));
      } catch (manifestErr) {
        throw new BundleValidationError(`Invalid tool manifest schema: ${String(manifestErr)}`);
      }

      if (manifest.capabilities?.secrets?.denyDirectRead === false) {
        throw new BundleValidationError(
          `Bundle '${manifest.id}' requires direct secret reads (denyDirectRead: false), which is incompatible with protocol v1.0.0. Migrate tool to use opaque secret references (broker.secret.createReference / bearerToken) and trusted broker mediation.`,
        );
      }

      const hasEntrypointTs = fs.existsSync(path.join(stagingPath, BUNDLE_FILE_ENTRYPOINT_TS));
      const hasEntrypointJs = fs.existsSync(path.join(stagingPath, BUNDLE_FILE_ENTRYPOINT_JS));

      if (!hasEntrypointTs && !hasEntrypointJs) {
        throw new BundleValidationError(
          `Bundle is missing entrypoint (${BUNDLE_FILE_ENTRYPOINT_TS} or ${BUNDLE_FILE_ENTRYPOINT_JS})`,
        );
      }

      const entrypointRelative = hasEntrypointTs
        ? BUNDLE_FILE_ENTRYPOINT_TS
        : BUNDLE_FILE_ENTRYPOINT_JS;

      // 5. Commit staging to cache
      const finalArtifactDir = await this.cache.commitStagingDirectory(stagingPath, digest, {
        digest,
        extractedAt: new Date().toISOString(),
        fileCount: entries.length,
        totalSizeBytes: tracker.getStats().totalDecompressedBytes,
        entrypoint: entrypointRelative,
        verified: true,
      });
      stagingPath = null; // Successfully committed

      // Acquire reference if requested
      if (options.reference) {
        await this.cache.acquireReference(digest, options.reference);
      }

      // 6. Statically inspect cached artifact
      const inspection = await inspectBundleDirectory(finalArtifactDir, {
        keyStore: this.keyStore,
        allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
      });

      const entrypointPath = path.join(finalArtifactDir, entrypointRelative);

      return {
        digest,
        artifactDir: finalArtifactDir,
        entrypointPath,
        manifest,
        inspection,
        isCached: false,
      };
    } catch (err) {
      // Clean up staging on error
      if (stagingPath && fs.existsSync(stagingPath)) {
        await fs.promises.rm(stagingPath, { recursive: true, force: true });
      }
      // Map error to quarantine reason if needed
      let quarantineReason: QuarantineReason = "corrupted_archive";
      if (err instanceof BundleSecurityError) {
        if (err.code === "DIGEST_MISMATCH") {
          quarantineReason = "digest_mismatch";
        } else if (err.code === "PATH_TRAVERSAL" || err.code === "ABSOLUTE_PATH") {
          quarantineReason = "path_traversal";
        } else if (err.code === "DECOMPRESSION_BOMB_DETECTED") {
          quarantineReason = "decompression_bomb";
        } else if (err.code === "SYMLINK_ESCAPE") {
          quarantineReason = "symlink_escape";
        } else if (
          err.code === "FILE_COUNT_EXCEEDED" ||
          err.code === "FILE_SIZE_EXCEEDED" ||
          err.code === "DECOMPRESSED_SIZE_EXCEEDED"
        ) {
          quarantineReason = "resource_limit_exceeded";
        }
      } else if (err instanceof BundleValidationError) {
        quarantineReason = "manifest_invalid";
      } else if (err instanceof BundleSignatureError) {
        quarantineReason = "signature_mismatch";
      }
      await this.quarantine.quarantinePayload(
        archiveBuffer,
        quarantineReason,
        { error: err instanceof Error ? err.message : String(err) },
        digest,
        sourceIdentifier,
      );

      throw err;
    }
  }

  /**
   * Loads a bundle directly from a local directory (e.g. workspace or test fixture).
   */
  private async loadFromDirectory(
    dirPath: string,
    options: LoadBundleOptions,
  ): Promise<LoadedToolBundle> {
    const resolvedDir = path.resolve(dirPath);
    const manifestPath = path.join(resolvedDir, BUNDLE_FILE_MANIFEST);

    if (!fs.existsSync(manifestPath)) {
      throw new BundleValidationError(`Directory missing ${BUNDLE_FILE_MANIFEST}: ${dirPath}`);
    }

    const manifestContent = await fs.promises.readFile(manifestPath, "utf8");
    const manifest = ToolManifestSchema.parse(JSON.parse(manifestContent));

    if (manifest.capabilities?.secrets?.denyDirectRead === false) {
      throw new BundleValidationError(
        `Bundle '${manifest.id}' requires direct secret reads (denyDirectRead: false), which is incompatible with protocol v1.0.0. Migrate tool to use opaque secret references (broker.secret.createReference / bearerToken) and trusted broker mediation.`,
      );
    }

    const inspection = await inspectBundleDirectory(resolvedDir, {
      keyStore: this.keyStore,
      allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
    });

    const entrypointPath = path.join(resolvedDir, inspection.entrypoint);
    const digest = manifest.digest;

    return {
      digest,
      artifactDir: resolvedDir,
      entrypointPath,
      manifest,
      inspection,
      isCached: false,
    };
  }
}
