import crypto from "node:crypto";
import {
  type ToolManifest,
  ToolManifestSchema,
  canonicalJson,
  normalizeSha256,
} from "@tool-evolver/contracts";
import type {
  ArtifactFileEntry,
  ArtifactInspectionResult,
  SigningKeyEntry,
  SigningKeyStore,
} from "./types.js";

/**
 * Error thrown when an artifact digest does not match the expected SHA-256.
 */
export class DigestMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Artifact digest mismatch: expected ${expected}, got ${actual}`);
    this.name = "DigestMismatchError";
  }
}

/**
 * Error thrown when an artifact exceeds maximum size limits.
 */
export class DecompressionBombError extends Error {
  constructor(
    public readonly actualSizeBytes: number,
    public readonly limitSizeBytes: number,
  ) {
    super(
      `Artifact size ${actualSizeBytes} bytes exceeds maximum allowed limit ${limitSizeBytes} bytes`,
    );
    this.name = "DecompressionBombError";
  }
}

/**
 * Error thrown when an artifact signature key is revoked.
 */
export class RevokedSigningKeyError extends Error {
  constructor(public readonly keyId: string) {
    super(`Signing key '${keyId}' has been revoked`);
    this.name = "RevokedSigningKeyError";
  }
}

/**
 * Error thrown when an artifact signature key is unknown.
 */
export class UnknownSigningKeyError extends Error {
  constructor(public readonly keyId: string) {
    super(`Signing key '${keyId}' is not found in trusted key store`);
    this.name = "UnknownSigningKeyError";
  }
}

/**
 * Error thrown when an artifact signature key is untrusted.
 */
export class UntrustedSigningKeyError extends Error {
  constructor(
    public readonly keyId: string,
    public readonly trustLevel: string,
  ) {
    super(`Signing key '${keyId}' is untrusted (trust level: ${trustLevel})`);
    this.name = "UntrustedSigningKeyError";
  }
}

/**
 * Error thrown when an artifact signature is invalid.
 */
export class InvalidSignatureError extends Error {
  constructor(
    public readonly keyId: string,
    public readonly reason: string,
  ) {
    super(`Invalid bundle signature for key '${keyId}': ${reason}`);
    this.name = "InvalidSignatureError";
  }
}

/**
 * Error thrown when bundle structure or inspection fails.
 */
export class ArtifactInspectionError extends Error {
  constructor(
    message: string,
    public readonly code: string = "INSPECTION_FAILED",
  ) {
    super(`Artifact inspection failed: ${message}`);
    this.name = "ArtifactInspectionError";
  }
}

/**
 * Downloaded and verified artifact result.
 */
export interface ArtifactDownloadResult {
  bytes: Buffer;
  digest: string;
  manifest: ToolManifest;
  inspection: ArtifactInspectionResult;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

/**
 * In-memory signing key store implementation.
 */
export class InMemoryKeyStore implements SigningKeyStore {
  private readonly keys = new Map<string, SigningKeyEntry>();

  constructor(initialKeys: SigningKeyEntry[] = []) {
    for (const key of initialKeys) {
      this.keys.set(key.keyId, key);
    }
  }

  async getKey(keyId: string): Promise<SigningKeyEntry | null> {
    return this.keys.get(keyId) ?? null;
  }

  async hasKey(keyId: string): Promise<boolean> {
    return this.keys.has(keyId);
  }

  async isTrusted(keyId: string, allowDevKeys = false): Promise<boolean> {
    const key = this.keys.get(keyId);
    if (!key) return false;
    if (key.trustLevel === "revoked") return false;
    if (key.trustLevel === "production") return true;
    if (key.trustLevel === "development" && allowDevKeys) return true;
    return false;
  }

  async addKey(entry: SigningKeyEntry): Promise<void> {
    this.keys.set(entry.keyId, entry);
  }

  async revokeKey(keyId: string): Promise<void> {
    const key = this.keys.get(keyId);
    if (key) {
      this.keys.set(keyId, { ...key, trustLevel: "revoked" });
    } else {
      this.keys.set(keyId, {
        keyId,
        algorithm: "ed25519",
        publicKeyPem: "",
        trustLevel: "revoked",
        createdAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * Options for ArtifactTransferClient.
 */
export interface ArtifactTransferClientOptions {
  maxArtifactSizeBytes?: number;
  keyStore?: SigningKeyStore;
  allowDevKeys?: boolean;
  verifySignature?: boolean;
  requireSignature?: boolean;
  downloadHandler?: (
    digest: string,
    metadata?: Record<string, unknown>,
  ) => Promise<Uint8Array | Buffer> | Uint8Array | Buffer;
}

/**
 * Internal parsed tar entry.
 */
interface ParsedTarEntry {
  name: string;
  size: number;
  type: string;
  data: Buffer;
}

/**
 * Parse standard POSIX / USTAR tar buffer into file entries.
 */
export function parseTarBuffer(buffer: Buffer): ParsedTarEntry[] {
  const entries: ParsedTarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);

    // Check for two consecutive empty blocks (end of archive)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Name: bytes 0..99
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();

    // Size: bytes 124..135 (octal ascii)
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;

    // Typeflag: byte 156
    const typeflag = header.subarray(156, 157).toString("utf8") || "0";

    // Prefix: bytes 345..499 (USTAR format)
    const ustar = header.subarray(257, 262).toString("utf8");
    if (ustar === "ustar") {
      const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
      if (prefix.length > 0) {
        name = `${prefix}/${name}`;
      }
    }

    offset += 512;

    const data = buffer.subarray(offset, offset + size);
    // Pad to 512 bytes
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    if (name.length > 0) {
      entries.push({
        name,
        size,
        type: typeflag,
        data: Buffer.from(data),
      });
    }
  }

  return entries;
}

/**
 * Artifact transfer client for downloading exact immutable artifacts by digest,
 * verifying SHA-256 digests, signatures, trust chains, and non-executing structure.
 */
export class ArtifactTransferClient {
  private readonly maxArtifactSizeBytes: number;
  private readonly keyStore: SigningKeyStore;
  private readonly allowDevKeys: boolean;
  private readonly verifySignature: boolean;
  private readonly requireSignature: boolean;
  private readonly downloadHandler?: (
    digest: string,
    metadata?: Record<string, unknown>,
  ) => Promise<Uint8Array | Buffer> | Uint8Array | Buffer;

  // Content-addressed cache: digest -> ArtifactDownloadResult
  private readonly cache = new Map<string, ArtifactDownloadResult>();

  constructor(options: ArtifactTransferClientOptions = {}) {
    this.maxArtifactSizeBytes = options.maxArtifactSizeBytes ?? 50 * 1024 * 1024; // 50MB
    this.keyStore = options.keyStore ?? new InMemoryKeyStore();
    this.allowDevKeys = options.allowDevKeys ?? true;
    this.verifySignature = options.verifySignature ?? false;
    this.requireSignature = options.requireSignature ?? false;
    this.downloadHandler = options.downloadHandler;
  }

  /**
   * Access the key store.
   */
  getKeyStore(): SigningKeyStore {
    return this.keyStore;
  }

  /**
   * Pre-cache an artifact buffer directly under its digest.
   */
  async cacheArtifact(
    digest: string,
    rawBytes: Buffer | Uint8Array,
    metadata: Record<string, unknown> = {},
  ): Promise<ArtifactDownloadResult> {
    const normExpected = normalizeSha256(digest);
    const buffer = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);

    const computedDigest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (computedDigest !== normExpected) {
      throw new DigestMismatchError(normExpected, computedDigest);
    }

    const inspection = await this.inspectArtifactBytes(buffer, {
      expectedDigest: normExpected,
      allowDevKeys: this.allowDevKeys,
      verifySignature: this.verifySignature,
      requireSignature: this.requireSignature,
    });

    const result: ArtifactDownloadResult = {
      bytes: buffer,
      digest: normExpected,
      manifest: inspection.manifest,
      inspection,
      sizeBytes: buffer.length,
      metadata,
    };

    this.cache.set(normExpected, result);
    return result;
  }

  /**
   * Downloads an exact immutable artifact by digest, validating SHA-256 and signatures.
   */
  async downloadArtifact(
    digest: string,
    options: {
      metadata?: Record<string, unknown>;
      allowDevKeys?: boolean;
      verifySignature?: boolean;
      requireSignature?: boolean;
      expectedSizeLimitBytes?: number;
    } = {},
  ): Promise<ArtifactDownloadResult> {
    const normExpected = normalizeSha256(digest);

    // 1. Check cache first
    const cached = this.cache.get(normExpected);
    if (cached) {
      return cached;
    }

    // 2. Fetch raw artifact bytes
    if (!this.downloadHandler) {
      throw new ArtifactInspectionError(
        `No download handler configured to fetch artifact with digest ${digest}`,
        "DOWNLOAD_HANDLER_MISSING",
      );
    }

    const rawResult = await this.downloadHandler(digest, options.metadata);
    const buffer = Buffer.isBuffer(rawResult) ? rawResult : Buffer.from(rawResult);

    // 3. Check decompression bomb / size limits
    const sizeLimit = options.expectedSizeLimitBytes ?? this.maxArtifactSizeBytes;
    if (buffer.length > sizeLimit) {
      throw new DecompressionBombError(buffer.length, sizeLimit);
    }

    // 4. Verify exact SHA-256 digest
    const computedDigest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (computedDigest !== normExpected) {
      throw new DigestMismatchError(normExpected, computedDigest);
    }

    // 5. Inspect bundle archive and verify signature
    const inspection = await this.inspectArtifactBytes(buffer, {
      expectedDigest: normExpected,
      allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
      verifySignature: options.verifySignature ?? this.verifySignature,
      requireSignature: options.requireSignature ?? this.requireSignature,
    });

    const result: ArtifactDownloadResult = {
      bytes: buffer,
      digest: normExpected,
      manifest: inspection.manifest,
      inspection,
      sizeBytes: buffer.length,
      metadata: options.metadata ?? {},
    };

    this.cache.set(normExpected, result);
    return result;
  }

  /**
   * Non-executing loader inspection of raw artifact buffer.
   */
  async inspectArtifactBytes(
    buffer: Buffer,
    options: {
      expectedDigest?: string;
      allowDevKeys?: boolean;
      verifySignature?: boolean;
      requireSignature?: boolean;
    } = {},
  ): Promise<ArtifactInspectionResult> {
    const bundleDigest =
      options.expectedDigest ?? crypto.createHash("sha256").update(buffer).digest("hex");
    const rawEntries = parseTarBuffer(buffer);

    if (rawEntries.length === 0) {
      throw new ArtifactInspectionError("Archive contains no valid tar entries", "EMPTY_ARCHIVE");
    }

    const fileMap = new Map<string, Buffer>();
    const files: ArtifactFileEntry[] = [];

    for (const entry of rawEntries) {
      const normalizedPath = entry.name.replace(/^\.\//, "").replace(/\/+/g, "/");

      // Check path traversal
      if (
        normalizedPath.startsWith("/") ||
        normalizedPath.startsWith("../") ||
        normalizedPath.includes("/../") ||
        normalizedPath === ".."
      ) {
        throw new ArtifactInspectionError(
          `Archive contains unsafe path traversal entry: ${entry.name}`,
          "PATH_TRAVERSAL_DETECTED",
        );
      }

      // Check for forbidden special files (directories or symlinks pointing outside)
      if (entry.type !== "0" && entry.type !== "" && entry.type !== "\0" && entry.type !== "5") {
        // Not a regular file or directory
        if (entry.type === "2" || entry.type === "1") {
          // Symlink / hardlink
          throw new ArtifactInspectionError(
            `Archive contains forbidden link entry: ${entry.name}`,
            "FORBIDDEN_LINK_DETECTED",
          );
        }
      }

      if (entry.type === "0" || entry.type === "" || entry.type === "\0") {
        fileMap.set(normalizedPath, entry.data);
        files.push({
          path: normalizedPath,
          sizeBytes: entry.size,
          digest: crypto.createHash("sha256").update(entry.data).digest("hex"),
        });
      }
    }

    // Locate manifest.json
    const manifestBuffer = fileMap.get("manifest.json") ?? fileMap.get("manifest.json5");
    if (!manifestBuffer) {
      throw new ArtifactInspectionError(
        "Archive does not contain manifest.json",
        "MISSING_MANIFEST",
      );
    }

    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(manifestBuffer.toString("utf8"));
    } catch (err) {
      throw new ArtifactInspectionError(
        `Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
        "INVALID_MANIFEST_JSON",
      );
    }

    let manifest: ToolManifest;
    try {
      manifest = ToolManifestSchema.parse(manifestRaw);
    } catch (err) {
      throw new ArtifactInspectionError(
        `Manifest schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
        "INVALID_MANIFEST_SCHEMA",
      );
    }

    // Locate signature.json
    const signatureBuffer = fileMap.get("signature.json");
    let rawSignature: Record<string, unknown> | undefined;
    let signatureResult: ArtifactInspectionResult["signature"];

    if (signatureBuffer) {
      try {
        rawSignature = JSON.parse(signatureBuffer.toString("utf8"));
      } catch {
        // Invalid signature JSON
      }
    }

    if (options.requireSignature && !rawSignature) {
      throw new ArtifactInspectionError(
        "Artifact does not contain required signature.json",
        "SIGNATURE_REQUIRED",
      );
    }

    if (rawSignature && (options.verifySignature || options.requireSignature)) {
      const keyId = typeof rawSignature.keyId === "string" ? rawSignature.keyId : "";
      const algorithm =
        typeof rawSignature.algorithm === "string" ? rawSignature.algorithm : "ed25519";
      const signatureHex =
        typeof rawSignature.signature === "string"
          ? rawSignature.signature
          : typeof rawSignature.signatureHex === "string"
            ? rawSignature.signatureHex
            : "";

      if (!keyId) {
        throw new InvalidSignatureError("unknown", "Missing keyId in signature.json");
      }

      const keyEntry = await this.keyStore.getKey(keyId);
      if (!keyEntry) {
        throw new UnknownSigningKeyError(keyId);
      }

      if (keyEntry.trustLevel === "revoked") {
        throw new RevokedSigningKeyError(keyId);
      }

      const isTrusted = await this.keyStore.isTrusted(keyId, options.allowDevKeys);
      if (!isTrusted) {
        throw new UntrustedSigningKeyError(keyId, keyEntry.trustLevel);
      }

      // Verify cryptographic signature over canonical sign payload
      const signedAt =
        typeof rawSignature.signedAt === "string"
          ? rawSignature.signedAt
          : typeof rawSignature.timestamp === "string"
            ? rawSignature.timestamp
            : "";

      const rawFileDigests =
        rawSignature.fileDigests && typeof rawSignature.fileDigests === "object"
          ? (rawSignature.fileDigests as Record<string, string>)
          : {};

      const fileDigestsRecord: Record<string, string> = { ...rawFileDigests };
      if (Object.keys(fileDigestsRecord).length === 0) {
        for (const f of files) {
          if (f.path !== "signature.json") {
            fileDigestsRecord[f.path] = f.digest;
          }
        }
      }

      const rawBundleDigest =
        typeof rawSignature.bundleDigest === "string" ? rawSignature.bundleDigest : bundleDigest;

      const canonicalString = canonicalJson({
        algorithm,
        bundleDigest: rawBundleDigest,
        fileDigests: fileDigestsRecord,
        keyId,
        signedAt,
      });

      const payloadBuf = Buffer.from(canonicalString, "utf8");
      const sigBuf = Buffer.from(signatureHex, "hex");

      let isValid = false;
      try {
        if (keyEntry.publicKeyPem) {
          isValid = crypto.verify(null, payloadBuf, keyEntry.publicKeyPem, sigBuf);
        }
      } catch {
        isValid = false;
      }

      if (!isValid) {
        throw new InvalidSignatureError(keyId, "Cryptographic signature verification failed");
      }

      signatureResult = {
        keyId,
        algorithm,
        valid: true,
        trustLevel: keyEntry.trustLevel,
      };
    }

    return {
      manifest,
      bundleDigest,
      files,
      rawSignature,
      signature: signatureResult,
    };
  }
}
