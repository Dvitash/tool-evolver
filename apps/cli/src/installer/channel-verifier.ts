import crypto from "node:crypto";
import type { PlatformInfo } from "./platform.js";

/**
 * Standard public key used for Tool Evolver release verification.
 */
export const DEFAULT_RELEASE_PUBLIC_KEY = {
  keyId: "tool-evolver-release-v1",
  publicKeyHex: "a4b9318ac386c0e21c30aba1e211c54883ceb53a39689980f2e27387c6c5ea95",
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEApLkxisOGwOIcMKuh4hHFSIPOtTo5aJmA8uJzh8bF6pU=\n-----END PUBLIC KEY-----\n",
};

// Ed25519 SPKI DER prefix (12 bytes)
const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type ReleaseChannel = "stable" | "prerelease" | "nightly" | "beta" | string;

export interface SignatureEntry {
  readonly keyId: string;
  readonly algorithm: "Ed25519" | string;
  readonly publicKeyHex?: string;
  readonly signatureHex: string;
}

export interface ChannelInfo {
  readonly version: string;
  readonly releaseDate: string;
  readonly manifestUrl?: string;
  readonly manifestDigest?: string;
  readonly releaseNotesUrl?: string;
  readonly minSupportedVersion?: string;
  readonly isLatest?: boolean;
}

export interface RollbackReferences {
  readonly targetVersion: string;
  readonly minSafeVersion: string;
  readonly rollbackTarball?: string;
  readonly rollbackSha256?: string;
  readonly instructionsUrl?: string;
}

export interface ChannelMetadata {
  readonly schemaVersion: string;
  readonly minSupportedVersion?: string;
  readonly currentVersion: string;
  readonly updatedAt: string;
  readonly channels: Record<string, ChannelInfo>;
  readonly rollbackReferences?: RollbackReferences;
  readonly revokedVersions?: string[];
  readonly signatures?: SignatureEntry[];
}

export interface ManifestAsset {
  readonly filename: string;
  readonly platform: string;
  readonly arch: string;
  readonly isWsl?: boolean;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly path: string;
}

export interface ManifestPackage {
  readonly version: string;
  readonly path: string;
  readonly type: string;
  readonly entry?: string;
  readonly entrySha256?: string;
  readonly packageSha256: string;
  readonly filesCount?: number;
}

export interface SignedManifest {
  readonly schemaVersion: string;
  readonly version: string;
  readonly releaseDate: string;
  readonly packages?: Record<string, ManifestPackage>;
  readonly assets: Record<string, ManifestAsset>;
  readonly signatures?: SignatureEntry[];
}

export interface ChannelVerificationOptions {
  readonly channel?: ReleaseChannel;
  readonly minSupportedVersion?: string;
  readonly currentInstalledVersion?: string;
  readonly trustedPublicKeys?: string[];
  readonly skipSignatureVerification?: boolean;
}

export interface ChannelVerificationResult {
  readonly valid: boolean;
  readonly channel: ReleaseChannel;
  readonly targetVersion?: string;
  readonly manifestUrl?: string;
  readonly manifestDigest?: string;
  readonly rollbackReference?: RollbackReferences;
  readonly errors: string[];
  readonly warnings: string[];
}

export interface ManifestVerificationOptions {
  readonly expectedDigest?: string;
  readonly trustedPublicKeys?: string[];
  readonly skipSignatureVerification?: boolean;
}

export interface ManifestVerificationResult {
  readonly valid: boolean;
  readonly version?: string;
  readonly assets: Record<string, ManifestAsset>;
  readonly errors: string[];
  readonly warnings: string[];
}

/**
 * Deterministically serialize any JavaScript object into canonical JSON format.
 */
export function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * Creates a Node.js crypto.KeyObject from an Ed25519 public key (hex or PEM).
 */
export function createPublicKeyFromInput(key: string | crypto.KeyObject): crypto.KeyObject {
  if (typeof key !== "string") {
    return key;
  }
  const trimmed = key.trim();
  if (trimmed.startsWith("-----BEGIN PUBLIC KEY-----")) {
    return crypto.createPublicKey(trimmed);
  }
  // Hex-encoded 32-byte Ed25519 public key
  const rawKeyBuffer = Buffer.from(trimmed, "hex");
  if (rawKeyBuffer.length !== 32) {
    throw new Error(
      `Invalid Ed25519 public key hex length: ${rawKeyBuffer.length} bytes (expected 32 bytes).`,
    );
  }
  const spkiDer = Buffer.concat([ED25519_SPKI_DER_PREFIX, rawKeyBuffer]);
  return crypto.createPublicKey({
    key: spkiDer,
    format: "der",
    type: "spki",
  });
}

/**
 * Verifies an Ed25519 digital signature over a canonical JSON payload.
 */
export function verifyEd25519Signature(
  payload: unknown,
  signatureHex: string,
  publicKey: string | crypto.KeyObject,
): boolean {
  try {
    const keyObject = createPublicKeyFromInput(publicKey);
    const canonicalString = canonicalJson(payload);
    const dataBuffer = Buffer.from(canonicalString, "utf8");
    const signatureBuffer = Buffer.from(signatureHex, "hex");

    return crypto.verify(null, dataBuffer, keyObject, signatureBuffer);
  } catch {
    return false;
  }
}

/**
 * Compares two SemVer versions (e.g. "1.0.0", "1.1.0-alpha.1").
 * Returns:
 *  -1 if v1 < v2
 *   0 if v1 === v2
 *   1 if v1 > v2
 */
export function compareSemver(v1: string, v2: string): number {
  const parseSemver = (v: string) => {
    const clean = v.replace(/^v/, "").trim();
    const [main, prerelease] = clean.split("-");
    const parts = (main || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      prerelease: prerelease ?? null,
    };
  };

  const a = parseSemver(v1);
  const b = parseSemver(v2);

  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  // Prerelease comparison: regular release > prerelease
  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease !== null && b.prerelease !== null) {
    return a.prerelease.localeCompare(b.prerelease);
  }

  return 0;
}

/**
 * Checks if a version satisfies a minimum version requirement.
 */
export function isVersionAtLeast(version: string, minVersion: string): boolean {
  return compareSemver(version, minVersion) >= 0;
}

/**
 * Checks if a version is in the revoked versions list.
 */
export function isVersionRevoked(version: string, revokedVersions?: string[]): boolean {
  if (!revokedVersions || !Array.isArray(revokedVersions)) return false;
  const clean = version.replace(/^v/, "").trim();
  return revokedVersions.some((revoked) => revoked.replace(/^v/, "").trim() === clean);
}

/**
 * Verifies release channel metadata against security and versioning policies.
 */
export function verifyChannelMetadata(
  channelData: unknown,
  options: ChannelVerificationOptions = {},
): ChannelVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requestedChannel = options.channel || "stable";

  if (!channelData || typeof channelData !== "object") {
    return {
      valid: false,
      channel: requestedChannel,
      errors: ["Invalid channel metadata format: expected a JSON object."],
      warnings,
    };
  }

  const meta = channelData as ChannelMetadata;

  // Validate Schema Version
  if (!meta.schemaVersion) {
    errors.push("Channel metadata is missing required 'schemaVersion'.");
  }

  // Validate Channels Map
  if (!meta.channels || typeof meta.channels !== "object") {
    errors.push("Channel metadata is missing required 'channels' mapping.");
  } else {
    const channelInfo = meta.channels[requestedChannel];
    if (!channelInfo) {
      errors.push(
        `Requested release channel '${requestedChannel}' was not found in channel metadata.`,
      );
    } else {
      if (!channelInfo.version) {
        errors.push(`Release channel '${requestedChannel}' is missing required 'version'.`);
      }

      // Check Revocation
      if (channelInfo.version && isVersionRevoked(channelInfo.version, meta.revokedVersions)) {
        errors.push(
          `Target version '${channelInfo.version}' in channel '${requestedChannel}' has been revoked. Installation aborted.`,
        );
      }

      // Check minSupportedVersion constraint
      const minVersion =
        channelInfo.minSupportedVersion || meta.minSupportedVersion || options.minSupportedVersion;
      if (minVersion && channelInfo.version && !isVersionAtLeast(channelInfo.version, minVersion)) {
        errors.push(
          `Target version '${channelInfo.version}' is below the required minimum supported version '${minVersion}'.`,
        );
      }
    }
  }

  // Validate Rollback References
  if (meta.rollbackReferences) {
    if (!meta.rollbackReferences.targetVersion) {
      warnings.push("Rollback references present but missing 'targetVersion'.");
    }
    if (!meta.rollbackReferences.minSafeVersion) {
      warnings.push("Rollback references present but missing 'minSafeVersion'.");
    }
  }

  // Validate Cryptographic Signatures if present
  if (!options.skipSignatureVerification && meta.signatures && meta.signatures.length > 0) {
    const trustedKeys = options.trustedPublicKeys || [DEFAULT_RELEASE_PUBLIC_KEY.publicKeyHex];
    const payloadToVerify = {
      schemaVersion: meta.schemaVersion,
      minSupportedVersion: meta.minSupportedVersion,
      currentVersion: meta.currentVersion,
      updatedAt: meta.updatedAt,
      channels: meta.channels,
      rollbackReferences: meta.rollbackReferences,
      revokedVersions: meta.revokedVersions,
    };

    let signatureMatched = false;
    for (const sig of meta.signatures) {
      if (sig.algorithm !== "Ed25519") {
        warnings.push(`Ignoring unsupported signature algorithm: ${sig.algorithm}`);
        continue;
      }
      const pubKey = sig.publicKeyHex || DEFAULT_RELEASE_PUBLIC_KEY.publicKeyHex;
      if (!trustedKeys.includes(pubKey)) {
        warnings.push(
          `Signature key '${sig.keyId}' (${pubKey}) is not in trusted public keys list.`,
        );
        continue;
      }

      if (verifyEd25519Signature(payloadToVerify, sig.signatureHex, pubKey)) {
        signatureMatched = true;
        break;
      }
    }

    if (!signatureMatched) {
      errors.push(
        "Cryptographic verification failed: no valid Ed25519 signature matched channel metadata payload.",
      );
    }
  }

  const selectedChannelInfo = meta.channels ? meta.channels[requestedChannel] : undefined;

  return {
    valid: errors.length === 0,
    channel: requestedChannel,
    targetVersion: selectedChannelInfo?.version,
    manifestUrl: selectedChannelInfo?.manifestUrl,
    manifestDigest: selectedChannelInfo?.manifestDigest,
    rollbackReference: meta.rollbackReferences,
    errors,
    warnings,
  };
}

/**
 * Verifies a signed release manifest.
 */
export function verifyManifest(
  manifestData: unknown,
  options: ManifestVerificationOptions = {},
): ManifestVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifestData || typeof manifestData !== "object") {
    return {
      valid: false,
      assets: {},
      errors: ["Invalid manifest format: expected a JSON object."],
      warnings,
    };
  }

  const manifest = manifestData as SignedManifest;

  if (!manifest.schemaVersion) {
    errors.push("Manifest missing required 'schemaVersion'.");
  }
  if (!manifest.version) {
    errors.push("Manifest missing required 'version'.");
  }
  if (!manifest.assets || typeof manifest.assets !== "object") {
    errors.push("Manifest missing required 'assets' object.");
  }

  // Digest verification if expectedDigest provided
  if (options.expectedDigest) {
    const rawCanonical = canonicalJson(manifest);
    const actualDigest = crypto.createHash("sha256").update(rawCanonical).digest("hex");
    if (actualDigest !== options.expectedDigest) {
      errors.push(
        `Manifest digest mismatch: expected ${options.expectedDigest}, got ${actualDigest}.`,
      );
    }
  }

  // Ed25519 Signature Verification
  if (!options.skipSignatureVerification && manifest.signatures && manifest.signatures.length > 0) {
    const trustedKeys = options.trustedPublicKeys || [DEFAULT_RELEASE_PUBLIC_KEY.publicKeyHex];
    const payloadToVerify = {
      schemaVersion: manifest.schemaVersion,
      version: manifest.version,
      releaseDate: manifest.releaseDate,
      packages: manifest.packages,
      assets: manifest.assets,
    };

    let signatureMatched = false;
    for (const sig of manifest.signatures) {
      if (sig.algorithm !== "Ed25519") {
        warnings.push(`Ignoring unsupported signature algorithm: ${sig.algorithm}`);
        continue;
      }
      const pubKey = sig.publicKeyHex || DEFAULT_RELEASE_PUBLIC_KEY.publicKeyHex;
      if (!trustedKeys.includes(pubKey)) {
        warnings.push(`Signature key '${sig.keyId}' is not in trusted public keys list.`);
        continue;
      }

      if (verifyEd25519Signature(payloadToVerify, sig.signatureHex, pubKey)) {
        signatureMatched = true;
        break;
      }
    }

    if (!signatureMatched) {
      errors.push(
        "Cryptographic verification failed: no valid Ed25519 signature matched manifest payload.",
      );
    }
  }

  return {
    valid: errors.length === 0,
    version: manifest.version,
    assets: manifest.assets || {},
    errors,
    warnings,
  };
}

/**
 * Selects the exact platform asset from a signed release manifest.
 */
export function selectPlatformAsset(
  manifest: SignedManifest,
  platform: PlatformInfo | { os: string; arch: string; isWsl?: boolean },
): ManifestAsset {
  if (!manifest.assets || typeof manifest.assets !== "object") {
    throw new Error("Release manifest has no assets available.");
  }

  // Determine platform ID (e.g. linux-x64, linux-arm64, darwin-x64, darwin-arm64, wsl-x64, wsl-arm64)
  const isWsl = Boolean(platform.isWsl);
  const osName = platform.os === "wsl" ? "wsl" : platform.os;
  const arch =
    platform.arch === "x86_64" ? "x64" : platform.arch === "aarch64" ? "arm64" : platform.arch;

  let platformId: string;
  if (isWsl || osName === "wsl") {
    platformId = `wsl-${arch}`;
  } else {
    platformId = `${osName}-${arch}`;
  }

  // Try exact match first
  let asset: ManifestAsset | undefined = manifest.assets[platformId];

  // Fallback: If WSL asset not distinct, use linux asset for same arch
  if (!asset && (isWsl || osName === "wsl")) {
    asset = manifest.assets[`linux-${arch}`];
  }

  // Search by properties if not found by key
  if (!asset) {
    asset = Object.values(manifest.assets).find((a) => {
      if (a.arch !== arch) return false;
      if (isWsl) {
        return a.platform === "linux" || a.platform === "wsl" || a.isWsl === true;
      }
      return a.platform === osName;
    });
  }

  if (!asset) {
    const available = Object.keys(manifest.assets).join(", ");
    throw new Error(
      `No compatible release asset found for platform '${platformId}' (os: ${osName}, arch: ${arch}, isWsl: ${isWsl}). Available assets: ${available}`,
    );
  }

  return asset;
}
