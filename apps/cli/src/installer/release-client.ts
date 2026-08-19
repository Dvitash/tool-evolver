import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { PlatformInfo } from "../platform/platform.js";
import {
  type ChannelMetadata,
  type ManifestAsset,
  type SignedManifest,
  selectPlatformAsset,
  verifyChannelMetadata,
  verifyManifest,
} from "./channel-verifier.js";

export const DEFAULT_PRODUCTION_CHANNEL_URL = "https://releases.tool-evolver.dev/channels.json";
export const PINNED_DENO_VERSION = "2.9.5";

export interface RuntimeAssetDescriptor {
  readonly filename: string;
  readonly url: string;
  readonly sha256: string;
  readonly archive: "zip";
  readonly executable: string;
}

export interface RuntimeDescriptor {
  readonly version: string;
  readonly required: boolean;
  readonly assets: Record<string, RuntimeAssetDescriptor>;
}

export interface ReleaseManifestWithRuntimes extends SignedManifest {
  readonly runtimes?: {
    readonly deno?: RuntimeDescriptor;
  };
}

export interface ReleaseProvenance {
  readonly version: string;
  readonly channelUrl: string;
  readonly manifestUrl: string;
  readonly manifestSha256: string;
  readonly releaseAssetUrl: string;
  readonly releaseAssetSha256: string;
  readonly commitSha?: string;
  readonly signingKeyIds: string[];
  readonly deno: {
    readonly version: string;
    readonly url: string;
    readonly sha256: string;
  };
}

export interface ResolvedProductionRelease {
  readonly channel: ChannelMetadata;
  readonly manifest: ReleaseManifestWithRuntimes;
  readonly version: string;
  readonly releaseAsset: ManifestAsset;
  readonly releaseAssetUrl: string;
  readonly denoAsset: RuntimeAssetDescriptor;
  readonly provenance: ReleaseProvenance;
}

export interface ResolveProductionReleaseOptions {
  readonly platform: PlatformInfo | { os: string; arch: string; isWsl?: boolean };
  readonly channel?: string;
  readonly channelUrl?: string;
  readonly trustedPublicKeys?: string[];
  readonly fetchImpl?: typeof fetch;
  readonly env?: Record<string, string | undefined>;
  readonly allowInsecureHttpForTests?: boolean;
}

function normalizeSha256(value: string): string {
  return value
    .replace(/^sha256:/i, "")
    .trim()
    .toLowerCase();
}

function sha256Hex(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertSha256(value: string, label: string): string {
  const normalized = normalizeSha256(value);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must contain an immutable SHA-256 digest.`);
  }
  return normalized;
}

function assertTransport(urlString: string, allowInsecureHttpForTests: boolean): URL {
  const url = new URL(urlString);
  if (url.protocol === "https:") return url;
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (allowInsecureHttpForTests && url.protocol === "http:" && loopback) return url;
  throw new Error(`Release metadata and assets must use HTTPS: ${urlString}`);
}

async function fetchBytes(
  urlString: string,
  fetchImpl: typeof fetch,
  allowInsecureHttpForTests: boolean,
): Promise<Buffer> {
  assertTransport(urlString, allowInsecureHttpForTests);
  const response = await fetchImpl(urlString, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`Release download failed for ${urlString}: HTTP ${response.status}.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseJson<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function loadBundledTrustedPublicKeys(
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const explicit = env.TOOL_EVOLVER_TRUSTED_RELEASE_PUBLIC_KEYS?.trim();
  if (explicit) {
    const values = explicit.startsWith("[")
      ? (JSON.parse(explicit) as unknown[]).map(String)
      : explicit.split(",");
    const keys = values.map((value) => value.trim()).filter(Boolean);
    if (keys.length > 0) return keys;
  }

  try {
    const trustUrl = new URL("../release-trust.json", import.meta.url);
    const trust = JSON.parse(await fs.readFile(trustUrl, "utf8")) as {
      trustDomain?: string;
      signingKey?: { publicKeyHex?: string; keyId?: string };
    };
    if (trust.trustDomain !== "production" || !trust.signingKey?.publicKeyHex) {
      throw new Error("bundled trust root is not production-scoped");
    }
    return [trust.signingKey.publicKeyHex];
  } catch (error) {
    throw new Error(
      `No independently pinned production release public key is available: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function platformKey(platform: { os: string; arch: string; isWsl?: boolean }): string {
  const arch =
    platform.arch === "x86_64" ? "x64" : platform.arch === "aarch64" ? "arm64" : platform.arch;
  if (platform.isWsl || platform.os === "wsl") return `wsl-${arch}`;
  return `${platform.os}-${arch}`;
}

function resolveDenoAsset(
  descriptor: RuntimeDescriptor | undefined,
  platform: { os: string; arch: string; isWsl?: boolean },
): RuntimeAssetDescriptor {
  if (!descriptor || !descriptor.required) {
    throw new Error("Signed release manifest is missing the required Deno runtime descriptor.");
  }
  if (descriptor.version !== PINNED_DENO_VERSION) {
    throw new Error(
      `Unsupported Deno runtime version '${descriptor.version}'; this installer requires ${PINNED_DENO_VERSION}.`,
    );
  }
  const key = platformKey(platform);
  const linuxFallback = key.startsWith("wsl-") ? `linux-${key.slice(4)}` : undefined;
  const asset =
    descriptor.assets[key] ?? (linuxFallback ? descriptor.assets[linuxFallback] : undefined);
  if (!asset) throw new Error(`No pinned Deno runtime asset exists for '${key}'.`);
  assertTransport(asset.url, false);
  assertSha256(asset.sha256, `Deno ${descriptor.version} asset`);
  return asset;
}

export async function resolveProductionRelease(
  options: ResolveProductionReleaseOptions,
): Promise<ResolvedProductionRelease> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowInsecure = options.allowInsecureHttpForTests === true;
  const channelUrl =
    options.channelUrl ??
    options.env?.TOOL_EVOLVER_RELEASE_CHANNEL_URL ??
    DEFAULT_PRODUCTION_CHANNEL_URL;
  const trustedPublicKeys = options.trustedPublicKeys?.length
    ? [...options.trustedPublicKeys]
    : await loadBundledTrustedPublicKeys(options.env);
  if (trustedPublicKeys.length === 0) {
    throw new Error(
      "Production release resolution requires at least one independently pinned public key.",
    );
  }

  const channelBytes = await fetchBytes(channelUrl, fetchImpl, allowInsecure);
  const channel = parseJson<ChannelMetadata>(channelBytes, "Release channel metadata");
  const channelResult = verifyChannelMetadata(channel, {
    channel: options.channel ?? "stable",
    trustedPublicKeys,
  });
  if (!channelResult.valid) {
    throw new Error(`Signed release channel rejected: ${channelResult.errors.join("; ")}`);
  }
  if (!channelResult.targetVersion || !channelResult.manifestUrl || !channelResult.manifestDigest) {
    throw new Error(
      "Signed release channel is incomplete: version, manifest URL, and digest are required.",
    );
  }

  const manifestUrl = assertTransport(channelResult.manifestUrl, allowInsecure).toString();
  const expectedManifestDigest = assertSha256(channelResult.manifestDigest, "Release manifest");
  const manifestBytes = await fetchBytes(manifestUrl, fetchImpl, allowInsecure);
  const actualManifestDigest = sha256Hex(manifestBytes);
  if (actualManifestDigest !== expectedManifestDigest) {
    throw new Error(
      `Release manifest digest mismatch: expected ${expectedManifestDigest}, got ${actualManifestDigest}.`,
    );
  }

  const manifest = parseJson<ReleaseManifestWithRuntimes>(manifestBytes, "Release manifest");
  const manifestResult = verifyManifest(manifest, { trustedPublicKeys });
  if (!manifestResult.valid) {
    throw new Error(`Signed release manifest rejected: ${manifestResult.errors.join("; ")}`);
  }
  if (manifest.version !== channelResult.targetVersion) {
    throw new Error(
      `Release channel/manifest version mismatch: ${channelResult.targetVersion} != ${manifest.version}.`,
    );
  }

  const releaseAsset = selectPlatformAsset(manifest, options.platform);
  const releaseAssetSha256 = assertSha256(releaseAsset.sha256, "Release platform asset");
  const releaseAssetUrl = assertTransport(
    new URL(releaseAsset.filename, manifestUrl).toString(),
    allowInsecure,
  ).toString();
  const denoAsset = resolveDenoAsset(manifest.runtimes?.deno, options.platform);
  const signingKeyIds = [
    ...(channel.signatures ?? []).map((entry) => entry.keyId),
    ...(manifest.signatures ?? []).map((entry) => entry.keyId),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const releaseIdentity = manifest.releaseIdentity as { commitSha?: string } | undefined;

  return {
    channel,
    manifest,
    version: manifest.version,
    releaseAsset: { ...releaseAsset, sha256: releaseAssetSha256 },
    releaseAssetUrl,
    denoAsset,
    provenance: {
      version: manifest.version,
      channelUrl,
      manifestUrl,
      manifestSha256: actualManifestDigest,
      releaseAssetUrl,
      releaseAssetSha256,
      commitSha: releaseIdentity?.commitSha,
      signingKeyIds,
      deno: {
        version: manifest.runtimes?.deno?.version ?? PINNED_DENO_VERSION,
        url: denoAsset.url,
        sha256: normalizeSha256(denoAsset.sha256),
      },
    },
  };
}
