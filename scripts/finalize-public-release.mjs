#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  REVOKED_RELEASE_KEY_IDS,
  createTestReleaseSigningKey,
  loadReleaseSigningKeyFromEnv,
  signReleasePayload,
} from "./release-trust.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--release-dir") options.releaseDir = argv[++index];
    else if (arg.startsWith("--release-dir=")) options.releaseDir = arg.slice(14);
    else if (arg === "--repository") options.repository = argv[++index];
    else if (arg.startsWith("--repository=")) options.repository = arg.slice(13);
    else if (arg === "--test-only") options.testOnly = true;
  }
  return options;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function resolveRepository(manifest, options) {
  const repository =
    options.repository ||
    process.env.TOOL_EVOLVER_PUBLIC_RELEASE_REPOSITORY ||
    process.env.GITHUB_REPOSITORY ||
    manifest.releaseIdentity?.repository ||
    "Dvitash/tool-evolver";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository === "test-only/local") {
    throw new Error(`Public release repository must be owner/name, received '${repository}'.`);
  }
  return repository;
}

export function finalizePublicRelease(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const releaseDir = path.resolve(rootDir, options.releaseDir ?? "dist/release/v1.0.0");
  const manifestPath = path.join(releaseDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Release manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.version || !manifest.releaseIdentity?.commitSha) {
    throw new Error("Release manifest is missing version or exact release identity.");
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.releaseIdentity.commitSha)) {
    throw new Error(
      `Release manifest commit SHA is invalid: ${manifest.releaseIdentity.commitSha}`,
    );
  }

  const testOnly = options.testOnly === true || process.env.TOOL_EVOLVER_RELEASE_TEST_ONLY === "1";
  const signingKey =
    options.signingKey ??
    (testOnly ? createTestReleaseSigningKey() : loadReleaseSigningKeyFromEnv());
  if (!testOnly && signingKey.trustDomain !== "production") {
    throw new Error("Public release channel must be signed by the production trust domain.");
  }

  const repository = resolveRepository(manifest, options);
  const tag = `v${manifest.version}`;
  const downloadBase = `https://github.com/${repository}/releases/download/${tag}`;
  const repositoryBase = `https://github.com/${repository}`;
  const payload = {
    schemaVersion: "2.0.0",
    minSupportedVersion: "0.1.0",
    currentVersion: manifest.version,
    updatedAt: manifest.releaseDate,
    releaseIdentity: manifest.releaseIdentity,
    channels: {
      stable: {
        version: manifest.version,
        releaseDate: manifest.releaseDate,
        manifestUrl: `${downloadBase}/manifest.json`,
        manifestDigest: sha256File(manifestPath),
        releaseNotesUrl: `${repositoryBase}/releases/tag/${tag}`,
        isLatest: true,
      },
    },
    rollbackReferences: {
      targetVersion: "0.1.0",
      minSafeVersion: "0.1.0",
      instructionsUrl: `${repositoryBase}/blob/${manifest.releaseIdentity.commitSha}/docs/release/rollback-procedure.md`,
    },
    revokedVersions: [],
    revokedKeyIds: [...REVOKED_RELEASE_KEY_IDS],
  };
  const channels = {
    ...payload,
    signatures: [{ ...signReleasePayload(payload, signingKey), signedAt: manifest.releaseDate }],
  };
  const channelsPath = path.join(releaseDir, "channels.json");
  fs.writeFileSync(channelsPath, `${JSON.stringify(channels, null, 2)}\n`, "utf8");

  return {
    channelsPath,
    channelsSha256: sha256File(channelsPath),
    manifestSha256: payload.channels.stable.manifestDigest,
    repository,
    tag,
    downloadBase,
    signingKeyId: signingKey.keyId,
    publicKeyHex: signingKey.publicKeyHex,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  try {
    const result = finalizePublicRelease(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  }
}
