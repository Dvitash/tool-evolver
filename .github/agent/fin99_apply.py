from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing replacement target: {label}")
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# Signed manifest owns the exact supported Deno runtime/version/digests.
# ---------------------------------------------------------------------------
p = "scripts/package-release.mjs"
s = read(p)
platform_end = "]\n\nexport const WORKSPACE_PACKAGES"
if platform_end not in s:
    raise SystemExit("platform list marker missing")
deno = '''\n\nexport const PINNED_DENO_RUNTIME = Object.freeze({
  version: "2.9.5",
  required: true,
  assets: {
    "linux-x64": {
      filename: "deno-x86_64-unknown-linux-gnu.zip",
      url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
      sha256: "11d8df76601162f7d60a95deebb2b668e7da26863fbb8dad1f69f85dd7c24fe5",
      archive: "zip",
      executable: "deno",
    },
    "linux-arm64": {
      filename: "deno-aarch64-unknown-linux-gnu.zip",
      url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-unknown-linux-gnu.zip",
      sha256: "190fffcdb34e19f608df71c0cf7543ad273c7c6ad88c376af1103906044b1b0f",
      archive: "zip",
      executable: "deno",
    },
    "darwin-x64": {
      filename: "deno-x86_64-apple-darwin.zip",
      url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-apple-darwin.zip",
      sha256: "7569bf6b6a504dfba1c48ac8b918528d8e956197551e494da1d8fff6d9bdaa11",
      archive: "zip",
      executable: "deno",
    },
    "darwin-arm64": {
      filename: "deno-aarch64-apple-darwin.zip",
      url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip",
      sha256: "6aa8edbf5e7f2005d588500a416f6acadbc332f68e624156f573b5eea9e2e5a3",
      archive: "zip",
      executable: "deno",
    },
  },
});\n\nexport const WORKSPACE_PACKAGES'''
s = s.replace(platform_end, "]" + deno, 1)
s = replace_once(
    s,
    '''    packages: packageDigests,
    assets: assetDigests,
    evidence: evidence || { status: "TEST_ONLY" },''',
    '''    packages: packageDigests,
    assets: assetDigests,
    runtimes: { deno: PINNED_DENO_RUNTIME },
    evidence: evidence || { status: "TEST_ONLY" },''',
    "signed manifest runtimes",
)
write(p, s)

# ---------------------------------------------------------------------------
# Both local and production verifiers sign/verify the runtime descriptor.
# ---------------------------------------------------------------------------
p = "scripts/verify-release.mjs"
s = read(p)
s = replace_once(
    s,
    '''    packages: manifest.packages,
    assets: manifest.assets,
    evidence: manifest.evidence,''',
    '''    packages: manifest.packages,
    assets: manifest.assets,
    ...(manifest.runtimes ? { runtimes: manifest.runtimes } : {}),
    evidence: manifest.evidence,''',
    "release verifier runtime payload",
)
write(p, s)

p = "apps/cli/src/installer/channel-verifier.ts"
s = read(p)
s = replace_once(
    s,
    '''  readonly packages?: Record<string, ManifestPackage>;
  readonly assets: Record<string, ManifestAsset>;''',
    '''  readonly packages?: Record<string, ManifestPackage>;
  readonly assets: Record<string, ManifestAsset>;
  readonly runtimes?: Record<string, unknown>;''',
    "manifest runtime type",
)
s = replace_once(
    s,
    '''        packages: manifest.packages,
        assets: manifest.assets,
        ...(manifest.evidence ? { evidence: manifest.evidence } : {}),''',
    '''        packages: manifest.packages,
        assets: manifest.assets,
        ...(manifest.runtimes ? { runtimes: manifest.runtimes } : {}),
        ...(manifest.evidence ? { evidence: manifest.evidence } : {}),''',
    "cli verifier runtime payload",
)
write(p, s)

# ---------------------------------------------------------------------------
# Runtime installation happens inside the immutable version staging directory.
# Exact provenance travels with each installed version and rollback target.
# ---------------------------------------------------------------------------
p = "apps/cli/src/installer/asset-downloader.ts"
s = read(p)
s = replace_once(
    s,
    'import zlib from "node:zlib";',
    'import zlib from "node:zlib";\nimport type { ReleaseProvenance } from "./release-client.js";',
    "release provenance import",
)
s = replace_once(
    s,
    '''export interface VersionInstallOptions {
  readonly version: string;
  readonly tarballPathOrBuffer: string | Buffer;
  readonly toolEvolverHome: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly logger?: (message: string) => void;
  readonly force?: boolean;
}''',
    '''export interface VersionInstallOptions {
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
}''',
    "version install options",
)
s = replace_once(
    s,
    '''export interface VersionStateRecord {
  activeVersion: string;
  previousVersion: string | null;
  updatedAt: string;
  installedVersions: string[];
}''',
    '''export interface VersionStateRecord {
  activeVersion: string;
  previousVersion: string | null;
  updatedAt: string;
  installedVersions: string[];
  provenanceByVersion?: Record<string, ReleaseProvenance>;
}''',
    "version state provenance",
)
marker = '''/**
 * Atomically installs a verified release tarball into an immutable version directory.
 */'''
zip_helper = r'''/**
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

'''
if marker not in s:
    raise SystemExit("install marker missing")
s = s.replace(marker, zip_helper + marker, 1)
needle = '''  const expectedDeno = path.join(stagingDir, "deno", "deno");

  // Create bin shims if archive contains apps structure'''
replacement = '''  const expectedDeno = path.join(stagingDir, "deno", "deno");

  if (options.denoRuntime) {
    const runtimeBuffer = Buffer.isBuffer(options.denoRuntime.archivePathOrBuffer)
      ? options.denoRuntime.archivePathOrBuffer
      : await fsPromises.readFile(options.denoRuntime.archivePathOrBuffer);
    const runtimeDigest = sha256Hex(runtimeBuffer);
    const expectedRuntimeDigest = options.denoRuntime.sha256.replace(/^sha256:/i, "").toLowerCase();
    if (runtimeDigest !== expectedRuntimeDigest) {
      throw new Error(
        `Pinned Deno runtime digest mismatch: expected ${expectedRuntimeDigest}, got ${runtimeDigest}.`,
      );
    }
    const denoBytes = extractSingleFileZip(runtimeBuffer, options.denoRuntime.executable);
    await fsBridge.mkdirp(path.dirname(expectedDeno));
    await fsPromises.writeFile(expectedDeno, denoBytes, { mode: 0o755 });
  }

  // Create bin shims if archive contains apps structure'''
s = replace_once(s, needle, replacement, "staged Deno extraction")
s = replace_once(
    s,
    '''  const versionInfo = {
    version: cleanVersion,
    installedAt: new Date().toISOString(),
    sha256: sha256Hex(tarGzBuffer),
  };''',
    '''  const versionInfo = {
    version: cleanVersion,
    installedAt: new Date().toISOString(),
    sha256: sha256Hex(tarGzBuffer),
    provenance: options.provenance,
    denoRuntime: options.denoRuntime
      ? { version: options.denoRuntime.version, sha256: options.denoRuntime.sha256 }
      : undefined,
  };''',
    "version metadata provenance",
)
needle = '''  const newState: VersionStateRecord = {
    activeVersion: cleanTarget,
    previousVersion,
    updatedAt: new Date().toISOString(),
    installedVersions: installedList,
  };'''
replacement = '''  let existingProvenance: Record<string, ReleaseProvenance> = {};
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
  };'''
s = replace_once(s, needle, replacement, "version state provenance recording")
write(p, s)

# ---------------------------------------------------------------------------
# Host asset probing no longer invents Deno versions or treats missing required
# assets as verified merely because optional omissions are allowed.
# ---------------------------------------------------------------------------
p = "apps/cli/src/installer/assets.ts"
s = read(p)
s = replace_once(
    s,
    '''      const exists = await fsBridge.exists(candidate);
      if (exists) {
        return { path: candidate, version: "2.0.0" };
      }''',
    '''      const exists = await fsBridge.exists(candidate);
      if (exists) {
        try {
          const { stdout } = await execFileAsync(candidate, ["--version"]);
          const match = stdout.match(/deno\\s+([\\d.]+)/i);
          if (match?.[1]) return { path: candidate, version: match[1] };
        } catch {
          // Existing path is not a working Deno executable.
        }
      }''',
    "real Deno version probe",
)
s = s.replace(
    'verified: daemonVerified || (options.allowMissingOptional ?? false),',
    'verified: daemonVerified || (!(manifest?.assets.daemon?.required ?? true) && (options.allowMissingOptional ?? false)),',
    1,
)
s = s.replace(
    'verified: (runtimeExists && runtimeDigestOk) || (options.allowMissingOptional ?? false),',
    'verified: (runtimeExists && runtimeDigestOk) || (!(manifest?.assets.runtime?.required ?? true) && (options.allowMissingOptional ?? false)),',
    1,
)
s = s.replace(
    'verified: (shimExists && shimDigestOk) || (options.allowMissingOptional ?? false),',
    'verified: (shimExists && shimDigestOk) || (!(manifest?.assets["mcp-shim"]?.required ?? true) && (options.allowMissingOptional ?? false)),',
    1,
)
s = s.replace(
    'version: denoInfo?.version ?? manifest?.assets.deno?.version ?? "2.0.0",',
    'version: denoInfo?.version ?? manifest?.assets.deno?.version ?? "unknown",',
    1,
)
s = s.replace(
    ': "Deno not detected; worker will use fallback sandboxing",',
    ': "Required Deno runtime was not detected or failed verification.",',
    1,
)
write(p, s)

# ---------------------------------------------------------------------------
# Installer's public production path rejects caller-authored release state and
# obtains every mutable input from the signed channel/manifest.
# ---------------------------------------------------------------------------
p = "apps/cli/src/installer/installer.ts"
s = read(p)
s = s.replace('import os from "node:os";', 'import fs from "node:fs/promises";\nimport os from "node:os";', 1)
s = replace_once(
    s,
    '''import {
  type VersionSwitchResult,
  downloadAndVerifyAsset,
  installReleaseVersion,
  rollbackActiveVersion,
  switchActiveVersion,
} from "./asset-downloader.js";''',
    '''import {
  type VersionSwitchResult,
  downloadAndVerifyAsset,
  getActiveVersion,
  installReleaseVersion,
  rollbackActiveVersion,
  switchActiveVersion,
} from "./asset-downloader.js";''',
    "installer downloader imports",
)
s = replace_once(
    s,
    '''  selectPlatformAsset,
  verifyChannelMetadata,
} from "./channel-verifier.js";''',
    '''  selectPlatformAsset,
  verifyChannelMetadata,
} from "./channel-verifier.js";
import {
  type ReleaseProvenance,
  type ResolvedProductionRelease,
  resolveProductionRelease,
} from "./release-client.js";''',
    "release client import",
)
s = replace_once(
    s,
    '''  targetVersion?: string;
  setupService?: boolean;''',
    '''  targetVersion?: string;
  releaseMode?: "production" | "local-test";
  releaseChannelUrl?: string;
  trustedReleasePublicKeys?: string[];
  fetchImpl?: typeof fetch;
  allowInsecureReleaseTransportForTests?: boolean;
  setupService?: boolean;''',
    "installer release options",
)
old_block = '''      let channelResult: ChannelVerificationResult | undefined;
      let selectedAsset: ManifestAsset | undefined;

      if (options.channelMetadata) {
        channelResult = verifyChannelMetadata(options.channelMetadata, {
          channel: options.channel || "stable",
        });
        if (!channelResult.valid) {
          throw new Error(`Channel verification failed: ${channelResult.errors.join("; ")}`);
        }
      }

      if (options.signedManifest) {
        selectedAsset = selectPlatformAsset(options.signedManifest, platformInfo);
      }

      const toolEvolverHome = path.join(customHome, ".tool-evolver");
      const downloadsDir = path.join(toolEvolverHome, "downloads");

      if (selectedAsset && options.assetTarball) {
        await downloadAndVerifyAsset({
          asset: selectedAsset,
          downloadDir: downloadsDir,
          sourceBuffer: Buffer.isBuffer(options.assetTarball) ? options.assetTarball : undefined,
          sourceUrlOrPath:
            typeof options.assetTarball === "string" ? options.assetTarball : undefined,
          fsBridge: this.fsBridge,
          logger: this.log.bind(this),
        });
      }

      const assetResult = await discoverAndVerifyAssets({
        fsBridge: this.fsBridge,
        manifest: options.assetManifest,
        denoExecutable: options.denoExecutable,
        allowMissingOptional: true,
      });'''
new_block = '''      let channelResult: ChannelVerificationResult | undefined;
      let selectedAsset: ManifestAsset | undefined;
      let productionRelease: ResolvedProductionRelease | undefined;
      let releaseTarball: string | Buffer | undefined = options.assetTarball;
      let denoRuntimeArchive: string | Buffer | undefined;
      const releaseMode = options.releaseMode ?? "local-test";
      const toolEvolverHome = path.join(customHome, ".tool-evolver");
      const downloadsDir = path.join(toolEvolverHome, "downloads");

      let assetResult: AssetVerificationResult;
      if (releaseMode === "production") {
        if (options.channelMetadata || options.signedManifest || options.assetTarball) {
          throw new Error(
            "Production installation rejects caller-authored channel, manifest, or tarball state; use the signed release channel.",
          );
        }
        productionRelease = await resolveProductionRelease({
          platform: platformInfo,
          channel: options.channel || "stable",
          channelUrl: options.releaseChannelUrl,
          trustedPublicKeys: options.trustedReleasePublicKeys,
          fetchImpl: options.fetchImpl,
          env: process.env,
          allowInsecureHttpForTests: options.allowInsecureReleaseTransportForTests,
        });
        const downloadedRelease = await downloadAndVerifyAsset({
          asset: productionRelease.releaseAsset,
          downloadDir: downloadsDir,
          sourceUrlOrPath: productionRelease.releaseAssetUrl,
          fsBridge: this.fsBridge,
          logger: this.log.bind(this),
        });
        releaseTarball = downloadedRelease.path;
        const denoAsset = productionRelease.denoAsset;
        const downloadedDeno = await downloadAndVerifyAsset({
          asset: {
            filename: denoAsset.filename,
            platform: platformInfo.os,
            arch: platformInfo.arch,
            isWsl: platformInfo.isWsl,
            sizeBytes: 0,
            sha256: denoAsset.sha256,
            path: denoAsset.filename,
          },
          downloadDir: downloadsDir,
          sourceUrlOrPath: denoAsset.url,
          fsBridge: this.fsBridge,
          logger: this.log.bind(this),
        });
        denoRuntimeArchive = downloadedDeno.path;
        this.journal.metadata.releaseProvenance = productionRelease.provenance;
        assetResult = {
          allVerified: true,
          missingRequired: [],
          digestMismatches: [],
          assets: [
            { name: "daemon", version: productionRelease.version, path: downloadedRelease.path, expectedSha256: productionRelease.releaseAsset.sha256, actualSha256: downloadedRelease.actualSha256, required: true, verified: true },
            { name: "runtime", version: productionRelease.version, path: downloadedRelease.path, expectedSha256: productionRelease.releaseAsset.sha256, actualSha256: downloadedRelease.actualSha256, required: true, verified: true },
            { name: "mcp-shim", version: productionRelease.version, path: downloadedRelease.path, expectedSha256: productionRelease.releaseAsset.sha256, actualSha256: downloadedRelease.actualSha256, required: true, verified: true },
            { name: "deno", version: productionRelease.provenance.deno.version, path: downloadedDeno.path, expectedSha256: productionRelease.provenance.deno.sha256, actualSha256: downloadedDeno.actualSha256, required: true, verified: true },
          ],
        };
      } else {
        if (options.channelMetadata) {
          channelResult = verifyChannelMetadata(options.channelMetadata, {
            channel: options.channel || "stable",
            skipSignatureVerification: true,
          });
          if (!channelResult.valid) {
            throw new Error(`Channel verification failed: ${channelResult.errors.join("; ")}`);
          }
        }
        if (options.signedManifest) selectedAsset = selectPlatformAsset(options.signedManifest, platformInfo);
        if (selectedAsset && options.assetTarball) {
          await downloadAndVerifyAsset({
            asset: selectedAsset,
            downloadDir: downloadsDir,
            sourceBuffer: Buffer.isBuffer(options.assetTarball) ? options.assetTarball : undefined,
            sourceUrlOrPath: typeof options.assetTarball === "string" ? options.assetTarball : undefined,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
          });
        }
        assetResult = await discoverAndVerifyAssets({
          fsBridge: this.fsBridge,
          manifest: options.assetManifest,
          denoExecutable: options.denoExecutable,
          allowMissingOptional: true,
        });
      }'''
s = replace_once(s, old_block, new_block, "installer asset resolution block")
old = '''        if (options.assetTarball) {
          const installVersion = channelResult?.targetVersion || options.targetVersion || "1.0.0";
          await installReleaseVersion({
            version: installVersion,
            tarballPathOrBuffer: options.assetTarball,
            toolEvolverHome,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
          });

          versionSwitchResult = await switchActiveVersion({
            toolEvolverHome,
            targetVersion: installVersion,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
          });
        }'''
new = '''        if (releaseTarball) {
          const installVersion =
            productionRelease?.version || channelResult?.targetVersion || options.targetVersion || "1.0.0";
          const previousVersion = getActiveVersion(toolEvolverHome);
          const installed = await installReleaseVersion({
            version: installVersion,
            tarballPathOrBuffer: releaseTarball,
            toolEvolverHome,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
            provenance: productionRelease?.provenance,
            denoRuntime:
              productionRelease && denoRuntimeArchive
                ? {
                    archivePathOrBuffer: denoRuntimeArchive,
                    version: productionRelease.provenance.deno.version,
                    sha256: productionRelease.provenance.deno.sha256,
                    executable: productionRelease.denoAsset.executable,
                  }
                : undefined,
          });

          this.journal.addRollbackAction(
            "directories",
            `Restore exact prior release after failed activation of v${installVersion}`,
            async () => {
              if (previousVersion) {
                await switchActiveVersion({
                  toolEvolverHome,
                  targetVersion: previousVersion,
                  fsBridge: this.fsBridge,
                  logger: this.log.bind(this),
                });
              } else {
                await fs.rm(path.join(toolEvolverHome, "current"), { force: true }).catch(() => {});
                await fs.rm(path.join(toolEvolverHome, "current-version"), { force: true }).catch(() => {});
              }
              if (installVersion !== previousVersion) {
                await fs.rm(installed.versionDir, { recursive: true, force: true });
              }
            },
          );

          versionSwitchResult = await switchActiveVersion({
            toolEvolverHome,
            targetVersion: installVersion,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
          });
        }'''
s = replace_once(s, old, new, "installer immutable install block")
write(p, s)

# Normal public `init` is strict; dry-run remains local/no-download for usability.
p = "apps/cli/src/commands/init.ts"
s = read(p)
s = replace_once(
    s,
    '''    customHome: flags.home,
    fsBridge: customFsBridge,''',
    '''    customHome: flags.home,
    releaseMode: flags.dryRun ? "local-test" : "production",
    releaseChannelUrl: process.env.TOOL_EVOLVER_RELEASE_CHANNEL_URL,
    fsBridge: customFsBridge,''',
    "init production release mode",
)
write(p, s)

# Production release embeds the public trust root into the npm/bootstrap dist.
p = ".github/workflows/release.yml"
s = read(p)
s = replace_once(
    s,
    '''      - run: pnpm build
      - run: pnpm test''',
    '''      - run: pnpm build
      - name: Embed independent public release trust root in bootstrap package
        run: node scripts/embed-cli-release-trust.mjs
      - run: pnpm test''',
    "release workflow trust embedding",
)
write(p, s)

print("FIN-003 signed installer/runtime hardening applied")
