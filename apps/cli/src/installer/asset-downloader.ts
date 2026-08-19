import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import type { ConfigFsBridge } from "@tool-evolver/harness-contracts";
import { defaultFsBridge } from "@tool-evolver/harness-contracts";
import type { ManifestAsset } from "./channel-verifier.js";
import type { ReleaseProvenance } from "./release-client.js";

export interface AssetDownloadOptions {
  readonly asset: ManifestAsset;
  readonly downloadDir: string;
  readonly sourceUrlOrPath?: string;
  readonly sourceBuffer?: Buffer;
  readonly fsBridge?: ConfigFsBridge;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: (msg: string) => void;
}

export interface DownloadedAssetResult {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly verified: boolean;
}

export interface VersionInstallOptions {
  readonly version: string;
  readonly tarballPathOrBuffer: string | Buffer;
  readonly toolEvolverHome: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly logger?: (message: string) => void;
  readonly force?: boolean;
  readonly provenance?: ReleaseProvenance;
  readonly denoRuntime?: {
    readonly archivePathOrBuffer: string | Buffer;
    readonly version: string;
    readonly sha256: string;
    readonly executable: string;
  };
}

export interface VersionInstallResult {
  readonly version: string;
  readonly versionDir: string;
  readonly installedFiles: string[];
  readonly entryPoints: {
    daemon: string;
    mcpShim: string;
    cli: string;
    deno?: string;
  };
}

export interface VersionSwitchOptions {
  readonly toolEvolverHome: string;
  readonly targetVersion: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly logger?: (msg: string) => void;
}

export interface VersionSwitchResult {
  readonly previousVersion: string | null;
  readonly activeVersion: string;
  readonly activePath: string;
  readonly rollbackRetained: boolean;
}

export interface RollbackOptions {
  readonly toolEvolverHome: string;
  readonly targetVersion?: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly logger?: (msg: string) => void;
}

export interface VersionRollbackResult {
  readonly restoredVersion: string;
  readonly previousVersion: string;
  readonly activePath: string;
}

export interface VersionStateRecord {
  activeVersion: string;
  previousVersion: string | null;
  updatedAt: string;
  installedVersions: string[];
  provenanceByVersion?: Record<string, ReleaseProvenance>;
}

/**
 * Calculates SHA-256 of a Buffer.
 */
export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Safe in-memory and on-disk USTAR tar parser and extractor.
 * Avoids any external CLI `tar` dependencies and prevents directory traversal attacks.
 */
export function extractTarArchive(
  tarData: Buffer,
  destinationDir: string,
  fsSync = fs,
): { extractedFiles: string[]; extractedDirs: string[] } {
  const extractedFiles: string[] = [];
  const extractedDirs: string[] = [];

  let offset = 0;
  const blockSize = 512;

  fsSync.mkdirSync(destinationDir, { recursive: true });

  while (offset + blockSize <= tarData.length) {
    const headerBlock = tarData.subarray(offset, offset + blockSize);

    // Two consecutive all-zero blocks indicate the end of the archive
    let isAllZero = true;
    for (let i = 0; i < blockSize; i++) {
      if (headerBlock[i] !== 0) {
        isAllZero = false;
        break;
      }
    }

    if (isAllZero) {
      break;
    }

    // Parse header fields (USTAR format)
    const rawName = headerBlock.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();
    const rawPrefix = headerBlock.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;

    if (!fullName) {
      offset += blockSize;
      continue;
    }

    // Security check: prevent path traversal
    const normalizedName = path.normalize(fullName).replace(/^(\.\.(\/|\\|$))+/, "");
    if (normalizedName.startsWith("..") || path.isAbsolute(normalizedName)) {
      throw new Error(
        `Security violation: tar member contains illegal path traversal: '${fullName}'`,
      );
    }

    const rawMode = headerBlock.subarray(100, 108).toString("utf8").replace(/\0.*$/, "").trim();
    const mode = rawMode ? Number.parseInt(rawMode, 8) : 0o644;

    const rawSize = headerBlock.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const fileSize = rawSize ? Number.parseInt(rawSize, 8) : 0;

    const typeFlag = String.fromCharCode(headerBlock[156] || 48); // '0' or \0 = normal file, '5' = directory

    offset += blockSize;

    const targetPath = path.join(destinationDir, normalizedName);

    if (typeFlag === "5" || normalizedName.endsWith("/")) {
      // Directory
      fsSync.mkdirSync(targetPath, { recursive: true });
      extractedDirs.push(targetPath);
    } else {
      // Regular file
      const parentDir = path.dirname(targetPath);
      fsSync.mkdirSync(parentDir, { recursive: true });

      const fileData = tarData.subarray(offset, offset + fileSize);
      fsSync.writeFileSync(targetPath, fileData, { mode: mode || 0o644 });
      extractedFiles.push(targetPath);

      // Advance offset to the next 512-byte boundary
      const padding = (blockSize - (fileSize % blockSize)) % blockSize;
      offset += fileSize + padding;
    }
  }

  return { extractedFiles, extractedDirs };
}

/**
 * Extracts a .tar.gz (gzipped tarball) buffer into a destination directory.
 */
export function extractTarGzBuffer(
  tarGzBuffer: Buffer,
  destinationDir: string,
  fsSync = fs,
): { extractedFiles: string[]; extractedDirs: string[] } {
  const decompressedTar = zlib.gunzipSync(tarGzBuffer);
  return extractTarArchive(decompressedTar, destinationDir, fsSync);
}

/**
 * Downloads and verifies a signed release asset.
 */
export async function downloadAndVerifyAsset(
  options: AssetDownloadOptions,
): Promise<DownloadedAssetResult> {
  const { asset, downloadDir } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {});

  await fsBridge.mkdirp(downloadDir);

  const destinationPath = path.join(downloadDir, asset.filename);
  const tempPath = path.join(downloadDir, `${asset.filename}.download.tmp`);

  let fileBuffer: Buffer;

  if (options.sourceBuffer) {
    fileBuffer = options.sourceBuffer;
  } else if (options.sourceUrlOrPath && !options.sourceUrlOrPath.startsWith("http")) {
    // Local file path
    fileBuffer = await fsPromises.readFile(options.sourceUrlOrPath);
  } else if (options.sourceUrlOrPath && options.sourceUrlOrPath.startsWith("http")) {
    log(`Downloading asset from ${options.sourceUrlOrPath}...`);
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(options.sourceUrlOrPath, {
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download asset from ${options.sourceUrlOrPath}: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
  } else {
    // Attempt local discovery or throw
    if (await fsBridge.exists(destinationPath)) {
      const existing = await fsPromises.readFile(destinationPath);
      const existingDigest = sha256Hex(existing);
      if (existingDigest === asset.sha256) {
        return {
          path: destinationPath,
          sha256: existingDigest,
          sizeBytes: existing.length,
          verified: true,
        };
      }
    }
    throw new Error(
      `No download source URL, buffer, or local path provided for asset '${asset.filename}'.`,
    );
  }

  // Verify SHA-256 integrity
  const actualDigest = sha256Hex(fileBuffer);
  if (asset.sha256 && actualDigest !== asset.sha256) {
    // Clean up temporary download on integrity failure
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    throw new Error(
      `Asset integrity verification failed for '${asset.filename}': expected SHA-256 ${asset.sha256}, got ${actualDigest}.`,
    );
  }

  // Atomically write file to final location
  await fsPromises.writeFile(tempPath, fileBuffer);
  await fsPromises.rename(tempPath, destinationPath);

  log(
    `Asset '${asset.filename}' downloaded and verified (SHA-256: ${actualDigest.slice(0, 16)}...).`,
  );

  return {
    path: destinationPath,
    sha256: actualDigest,
    sizeBytes: fileBuffer.length,
    verified: true,
  };
}

/**
 * Extracts one named file from a ZIP archive using the central directory. Deno
 * release archives contain one executable and use either store or deflate.
 */
export function extractSingleFileZip(zipBuffer: Buffer, expectedBasename: string): Buffer {
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while (offset < zipBuffer.length - 46) {
    const central = zipBuffer.indexOf(centralSignature, offset);
    if (central < 0) break;
    if (central + 46 > zipBuffer.length) break;
    const method = zipBuffer.readUInt16LE(central + 10);
    const compressedSize = zipBuffer.readUInt32LE(central + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(central + 24);
    const fileNameLength = zipBuffer.readUInt16LE(central + 28);
    const extraLength = zipBuffer.readUInt16LE(central + 30);
    const commentLength = zipBuffer.readUInt16LE(central + 32);
    const localOffset = zipBuffer.readUInt32LE(central + 42);
    const fileName = zipBuffer
      .subarray(central + 46, central + 46 + fileNameLength)
      .toString("utf8")
      .replace(/\\/g, "/");
    const basename = path.posix.basename(fileName);
    if (basename === expectedBasename) {
      if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error("Deno runtime ZIP contains an invalid local file header.");
      }
      const localNameLength = zipBuffer.readUInt16LE(localOffset + 26);
      const localExtraLength = zipBuffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);
      let output: Buffer;
      if (method === 0) output = Buffer.from(compressed);
      else if (method === 8) output = zlib.inflateRawSync(compressed);
      else throw new Error(`Unsupported ZIP compression method ${method}.`);
      if (output.length !== uncompressedSize) {
        throw new Error("Deno runtime ZIP entry size mismatch.");
      }
      return output;
    }
    offset = central + 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`Deno runtime ZIP does not contain '${expectedBasename}'.`);
}

/**
 * Installs a release package into an immutable version directory.
 */
export async function installReleaseVersion(
  options: VersionInstallOptions,
): Promise<VersionInstallResult> {
  const { version, tarballPathOrBuffer, toolEvolverHome } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {});

  const cleanVersion = version.replace(/^v/, "").trim();
  const versionsDir = path.join(toolEvolverHome, "versions");
  const targetVersionDir = path.join(versionsDir, `v${cleanVersion}`);
  const stagingDir = path.join(versionsDir, `.staging-v${cleanVersion}-${Date.now()}`);

  await fsBridge.mkdirp(versionsDir);

  // If already installed and not forced, verify existing installation
  if (!options.force && (await fsBridge.exists(targetVersionDir))) {
    const daemonBin = path.join(targetVersionDir, "bin", "tool-evolver-daemon");
    const mcpBin = path.join(targetVersionDir, "bin", "tool-evolver-mcp");
    const cliBin = path.join(targetVersionDir, "bin", "tool-evolver");
    const denoBin = path.join(targetVersionDir, "deno", "deno");

    const hasDaemon =
      (await fsBridge.exists(daemonBin)) || (await fsBridge.exists(`${daemonBin}.js`));
    const hasMcp = (await fsBridge.exists(mcpBin)) || (await fsBridge.exists(`${mcpBin}.js`));

    let reusable = hasDaemon && hasMcp;
    if (options.denoRuntime) {
      reusable = reusable && (await fsBridge.exists(denoBin));
    }
    if (reusable && options.provenance) {
      try {
        const versionMetadata = JSON.parse(
          await fsPromises.readFile(path.join(targetVersionDir, "version.json"), "utf8"),
        ) as { provenance?: ReleaseProvenance; deno?: { version?: string; sha256?: string } };
        reusable =
          versionMetadata.provenance?.manifestSha256 === options.provenance.manifestSha256 &&
          versionMetadata.provenance?.releaseAssetSha256 ===
            options.provenance.releaseAssetSha256 &&
          versionMetadata.provenance?.version === options.provenance.version;
        if (options.denoRuntime) {
          reusable =
            reusable &&
            versionMetadata.deno?.version === options.denoRuntime.version &&
            versionMetadata.deno?.sha256 === options.denoRuntime.sha256;
        }
      } catch {
        reusable = false;
      }
    }
    if (reusable) {
      log(
        `Version v${cleanVersion} is already installed at ${targetVersionDir}. Reusing verified installation.`,
      );
      return {
        version: cleanVersion,
        versionDir: targetVersionDir,
        installedFiles: [],
        entryPoints: {
          daemon: daemonBin,
          mcpShim: mcpBin,
          cli: cliBin,
          deno: (await fsBridge.exists(denoBin)) ? denoBin : undefined,
        },
      };
    }
  }

  try {
    log(`Extracting release archive for version v${cleanVersion} into staging directory...`);

    let tarGzBuffer: Buffer;
    if (Buffer.isBuffer(tarballPathOrBuffer)) {
      tarGzBuffer = tarballPathOrBuffer;
    } else {
      tarGzBuffer = await fsPromises.readFile(tarballPathOrBuffer);
    }

    // Extract into staging directory
    const { extractedFiles } = extractTarGzBuffer(tarGzBuffer, stagingDir);

    // Entry Point Resolution & Verification
    const expectedDaemon = path.join(stagingDir, "bin", "tool-evolver-daemon");
    const expectedMcp = path.join(stagingDir, "bin", "tool-evolver-mcp");
    const expectedCli = path.join(stagingDir, "bin", "tool-evolver");
    const expectedDeno = path.join(stagingDir, "deno", "deno");

    if (options.denoRuntime) {
      const runtimeBuffer = Buffer.isBuffer(options.denoRuntime.archivePathOrBuffer)
        ? options.denoRuntime.archivePathOrBuffer
        : await fsPromises.readFile(options.denoRuntime.archivePathOrBuffer);
      const runtimeDigest = sha256Hex(runtimeBuffer);
      const expectedRuntimeDigest = options.denoRuntime.sha256
        .replace(/^sha256:/i, "")
        .toLowerCase();
      if (runtimeDigest !== expectedRuntimeDigest) {
        throw new Error(
          `Pinned Deno runtime digest mismatch: expected ${expectedRuntimeDigest}, got ${runtimeDigest}.`,
        );
      }
      const denoBytes = extractSingleFileZip(runtimeBuffer, options.denoRuntime.executable);
      await fsBridge.mkdirp(path.dirname(expectedDeno));
      await fsPromises.writeFile(expectedDeno, denoBytes, { mode: 0o755 });
    }

    // Create bin shims if archive contains apps structure
    const observerDistBin = path.join(stagingDir, "apps", "observer", "dist", "bin", "daemon.js");
    const gatewayDistBin = path.join(stagingDir, "apps", "gateway", "dist", "bin", "mcp-shim.js");
    const cliDistBin = path.join(stagingDir, "apps", "cli", "dist", "bin", "cli.js");

    const binDir = path.join(stagingDir, "bin");
    await fsBridge.mkdirp(binDir);

    if (!fs.existsSync(expectedDaemon) && fs.existsSync(observerDistBin)) {
      fs.writeFileSync(
        expectedDaemon,
        `#!/usr/bin/env node\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nawait import(path.resolve(__dirname, "../apps/observer/dist/bin/daemon.js"));\n`,
        { mode: 0o755 },
      );
    }
    if (!fs.existsSync(expectedMcp) && fs.existsSync(gatewayDistBin)) {
      fs.writeFileSync(
        expectedMcp,
        `#!/usr/bin/env node\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nawait import(path.resolve(__dirname, "../apps/gateway/dist/bin/mcp-shim.js"));\n`,
        { mode: 0o755 },
      );
    }
    if (!fs.existsSync(expectedCli) && fs.existsSync(cliDistBin)) {
      fs.writeFileSync(
        expectedCli,
        `#!/usr/bin/env node\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nawait import(path.resolve(__dirname, "../apps/cli/dist/bin/cli.js"));\n`,
        { mode: 0o755 },
      );
    }

    // Ensure all entry points have executable permissions
    for (const binPath of [expectedDaemon, expectedMcp, expectedCli, expectedDeno]) {
      if (fs.existsSync(binPath)) {
        try {
          fs.chmodSync(binPath, 0o755);
        } catch {}
      }
    }

    // Atomically move staging directory to final version directory
    if (fs.existsSync(targetVersionDir)) {
      await fsPromises.rm(targetVersionDir, { recursive: true, force: true });
    }
    await fsPromises.rename(stagingDir, targetVersionDir);

    // Write version metadata record
    const versionMetadataPath = path.join(targetVersionDir, "version.json");
    const versionInfo = {
      version: cleanVersion,
      installedAt: new Date().toISOString(),
      sha256: sha256Hex(tarGzBuffer),
      provenance: options.provenance,
      denoRuntime: options.denoRuntime
        ? { version: options.denoRuntime.version, sha256: options.denoRuntime.sha256 }
        : undefined,
    };
    await fsPromises.writeFile(versionMetadataPath, JSON.stringify(versionInfo, null, 2), "utf8");

    log(`Version v${cleanVersion} installed into immutable directory: ${targetVersionDir}`);

    return {
      version: cleanVersion,
      versionDir: targetVersionDir,
      installedFiles: extractedFiles.map((f) => f.replace(stagingDir, targetVersionDir)),
      entryPoints: {
        daemon: path.join(targetVersionDir, "bin", "tool-evolver-daemon"),
        mcpShim: path.join(targetVersionDir, "bin", "tool-evolver-mcp"),
        cli: path.join(targetVersionDir, "bin", "tool-evolver"),
        deno: fs.existsSync(path.join(targetVersionDir, "deno", "deno"))
          ? path.join(targetVersionDir, "deno", "deno")
          : undefined,
      },
    };
  } catch (error) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Atomically switches the active version pointer to a new version, retaining the previous known good version for rollback.
 */
export async function switchActiveVersion(
  options: VersionSwitchOptions,
): Promise<VersionSwitchResult> {
  const { toolEvolverHome, targetVersion } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {});

  const cleanTarget = targetVersion.replace(/^v/, "").trim();
  const versionsDir = path.join(toolEvolverHome, "versions");
  const targetVersionDir = path.join(versionsDir, `v${cleanTarget}`);

  if (!(await fsBridge.exists(targetVersionDir))) {
    throw new Error(
      `Cannot switch to version v${cleanTarget}: directory does not exist at ${targetVersionDir}`,
    );
  }

  const currentPointer = path.join(toolEvolverHome, "current");
  const previousPointer = path.join(toolEvolverHome, "previous");
  const versionStatePath = path.join(toolEvolverHome, "version-state.json");

  let previousVersion: string | null = null;

  // Read current version before switching
  if (fs.existsSync(currentPointer)) {
    try {
      const stats = fs.lstatSync(currentPointer);
      if (stats.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(currentPointer);
        const match = linkTarget.match(/v([0-9a-zA-Z.-]+)$/);
        if (match && match[1]) {
          previousVersion = match[1];
        }
      }
    } catch {}
  }

  // If previous version wasn't derived from symlink, check version-state.json
  if (!previousVersion && fs.existsSync(versionStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(versionStatePath, "utf8")) as VersionStateRecord;
      previousVersion = state.activeVersion || null;
    } catch {}
  }

  // Update previous pointer / rollback target if different
  if (previousVersion && previousVersion !== cleanTarget) {
    const prevTargetDir = path.join(versionsDir, `v${previousVersion}`);
    if (fs.existsSync(prevTargetDir)) {
      try {
        if (fs.existsSync(previousPointer)) {
          fs.unlinkSync(previousPointer);
        }
        fs.symlinkSync(prevTargetDir, previousPointer, "dir");
      } catch {
        // Fallback: write text pointer
        fs.writeFileSync(path.join(toolEvolverHome, "previous-version"), previousVersion, "utf8");
      }
    }
  }

  // Atomically update current pointer using temporary symlink and rename
  const tmpSymlink = path.join(toolEvolverHome, `.current.tmp-${Date.now()}`);
  try {
    if (fs.existsSync(tmpSymlink)) fs.unlinkSync(tmpSymlink);
    fs.symlinkSync(targetVersionDir, tmpSymlink, "dir");
    fs.renameSync(tmpSymlink, currentPointer);
  } catch {
    // If symlink creation fails (e.g. on Windows without privileges), use atomic pointer file
    fs.writeFileSync(path.join(toolEvolverHome, "current-version"), cleanTarget, "utf8");
  }

  // Update global bin directory shims
  const globalBinDir = path.join(toolEvolverHome, "bin");
  await fsBridge.mkdirp(globalBinDir);

  const binNames = ["tool-evolver-daemon", "tool-evolver-mcp", "tool-evolver"];
  for (const binName of binNames) {
    const binTarget = path.join(targetVersionDir, "bin", binName);
    const globalBinPath = path.join(globalBinDir, binName);

    if (fs.existsSync(binTarget)) {
      try {
        if (fs.existsSync(globalBinPath)) fs.unlinkSync(globalBinPath);
        fs.symlinkSync(binTarget, globalBinPath);
      } catch {
        // Fallback: write wrapper script
        fs.writeFileSync(
          globalBinPath,
          `#!/usr/bin/env node\nimport "${path.resolve(binTarget)}";\n`,
          { mode: 0o755 },
        );
      }
    }
  }

  // Record version state
  const installedList = fs.existsSync(versionsDir)
    ? fs
        .readdirSync(versionsDir)
        .filter((d) => d.startsWith("v") && !d.startsWith("."))
        .map((d) => d.replace(/^v/, ""))
    : [cleanTarget];

  let existingProvenance: Record<string, ReleaseProvenance> = {};
  if (fs.existsSync(versionStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(versionStatePath, "utf8")) as VersionStateRecord;
      existingProvenance = { ...(state.provenanceByVersion ?? {}) };
    } catch {}
  }
  try {
    const versionMetadata = JSON.parse(
      fs.readFileSync(path.join(targetVersionDir, "version.json"), "utf8"),
    ) as { provenance?: ReleaseProvenance };
    if (versionMetadata.provenance) existingProvenance[cleanTarget] = versionMetadata.provenance;
  } catch {}

  const newState: VersionStateRecord = {
    activeVersion: cleanTarget,
    previousVersion,
    updatedAt: new Date().toISOString(),
    installedVersions: installedList,
    provenanceByVersion: existingProvenance,
  };

  await fsPromises.writeFile(versionStatePath, JSON.stringify(newState, null, 2), "utf8");

  log(
    `Successfully switched active version to v${cleanTarget} (previous: ${previousVersion ? `v${previousVersion}` : "none"}).`,
  );

  return {
    previousVersion,
    activeVersion: cleanTarget,
    activePath: targetVersionDir,
    rollbackRetained: Boolean(previousVersion && previousVersion !== cleanTarget),
  };
}

/**
 * Rolls back the active version pointer to the previous known good version.
 */
export async function rollbackActiveVersion(
  options: RollbackOptions,
): Promise<VersionRollbackResult> {
  const { toolEvolverHome } = options;
  const log = options.logger ?? (() => {});

  const versionStatePath = path.join(toolEvolverHome, "version-state.json");
  const previousPointer = path.join(toolEvolverHome, "previous");

  let targetRollbackVersion = options.targetVersion;

  if (!targetRollbackVersion && fs.existsSync(previousPointer)) {
    try {
      const stats = fs.lstatSync(previousPointer);
      if (stats.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(previousPointer);
        const match = linkTarget.match(/v([0-9a-zA-Z.-]+)$/);
        if (match && match[1]) {
          targetRollbackVersion = match[1];
        }
      }
    } catch {}
  }

  if (!targetRollbackVersion && fs.existsSync(versionStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(versionStatePath, "utf8")) as VersionStateRecord;
      targetRollbackVersion = state.previousVersion || undefined;
    } catch {}
  }

  if (!targetRollbackVersion) {
    throw new Error("No previous version found to roll back to.");
  }

  const cleanTarget = targetRollbackVersion.replace(/^v/, "").trim();
  const versionsDir = path.join(toolEvolverHome, "versions");
  const rollbackDir = path.join(versionsDir, `v${cleanTarget}`);

  if (!fs.existsSync(rollbackDir)) {
    throw new Error(`Rollback target version directory does not exist: ${rollbackDir}`);
  }

  const switchResult = await switchActiveVersion({
    toolEvolverHome,
    targetVersion: cleanTarget,
    fsBridge: options.fsBridge,
    logger: options.logger,
  });

  log(`Rollback completed: active version restored to v${cleanTarget}.`);

  return {
    restoredVersion: cleanTarget,
    previousVersion: switchResult.previousVersion || "unknown",
    activePath: switchResult.activePath,
  };
}

/**
 * Reads the currently active version from the tool evolver directory.
 */
export function getActiveVersion(toolEvolverHome: string): string | null {
  const versionStatePath = path.join(toolEvolverHome, "version-state.json");
  if (fs.existsSync(versionStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(versionStatePath, "utf8")) as VersionStateRecord;
      return state.activeVersion || null;
    } catch {}
  }

  const currentPointer = path.join(toolEvolverHome, "current");
  if (fs.existsSync(currentPointer)) {
    try {
      const stats = fs.lstatSync(currentPointer);
      if (stats.isSymbolicLink()) {
        const target = fs.readlinkSync(currentPointer);
        const match = target.match(/v([0-9a-zA-Z.-]+)$/);
        if (match && match[1]) return match[1];
      }
    } catch {}
  }

  return null;
}
