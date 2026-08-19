#!/usr/bin/env node

/**
 * Tool Evolver V1.0.0 Release Packaging Tool
 *
 * Responsibilities:
 * 1. Builds all 15 monorepo workspace packages.
 * 2. Generates reproducible, deterministic standalone platform release tarballs.
 * 3. Generates a signed release manifest with Ed25519 signatures and SHA-256 digests.
 * 4. Generates a CycloneDX 1.5 JSON SBOM.
 * 5. Generates signed release channel metadata.
 * 6. Outputs all release artifacts to dist/release/v1.0.0/.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { getGitCommitSha, writeReleaseEvidence } from "./generate-release-evidence.mjs";
import {
  REVOKED_RELEASE_KEY_IDS,
  createTestReleaseSigningKey,
  loadReleaseSigningKeyFromEnv,
  publicTrustRecord,
  signReleasePayload,
  trustedKeysFromSigningKey,
} from "./release-trust.mjs";

export const RELEASE_VERSION = "1.0.0";
export const RELEASE_DATE = "2026-08-17T00:00:00.000Z";
export const DETERMINISTIC_MTIME = 1786924800;

export const PLATFORMS = [
  {
    id: "linux-x64",
    os: "linux",
    arch: "x64",
    isWsl: false,
    filename: `tool-evolver-v${RELEASE_VERSION}-linux-x64.tar.gz`,
  },
  {
    id: "linux-arm64",
    os: "linux",
    arch: "arm64",
    isWsl: false,
    filename: `tool-evolver-v${RELEASE_VERSION}-linux-arm64.tar.gz`,
  },
  {
    id: "darwin-x64",
    os: "darwin",
    arch: "x64",
    isWsl: false,
    filename: `tool-evolver-v${RELEASE_VERSION}-darwin-x64.tar.gz`,
  },
  {
    id: "darwin-arm64",
    os: "darwin",
    arch: "arm64",
    isWsl: false,
    filename: `tool-evolver-v${RELEASE_VERSION}-darwin-arm64.tar.gz`,
  },
  {
    id: "wsl",
    os: "linux",
    arch: "x64",
    isWsl: true,
    filename: `tool-evolver-v${RELEASE_VERSION}-wsl.tar.gz`,
  },
];

export const PINNED_DENO_RUNTIME = Object.freeze({
  version: "2.9.5",
  required: true,
  assets: {
    "linux-x64": {
      filename: "deno-x86_64-unknown-linux-gnu.zip",
      url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
      sha256: "8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530",
      archive: "zip",
      executable: "deno",
    },
    "linux-arm64": {
      filename: "deno-aarch64-unknown-linux-gnu.zip",
      url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-unknown-linux-gnu.zip",
      sha256: "6b7cae3a8fc4385a59dea3146fcb8bad7fea4230e0ad36a8c692afacbc254be0",
      archive: "zip",
      executable: "deno",
    },
    "darwin-x64": {
      filename: "deno-x86_64-apple-darwin.zip",
      url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-apple-darwin.zip",
      sha256: "c1b8b89a81e91b2a8b3f96def3195d08cfe3a105651da7908d53061f7140510d",
      archive: "zip",
      executable: "deno",
    },
    "darwin-arm64": {
      filename: "deno-aarch64-apple-darwin.zip",
      url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip",
      sha256: "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615",
      archive: "zip",
      executable: "deno",
    },
  },
});

export const WORKSPACE_PACKAGES = [
  {
    name: "@tool-evolver/contracts",
    path: "packages/contracts",
    entry: "dist/index.js",
    type: "package",
  },
  {
    name: "@tool-evolver/crypto",
    path: "packages/crypto",
    entry: "dist/index.js",
    type: "package",
  },
  { name: "@tool-evolver/db", path: "packages/db", entry: "dist/index.js", type: "package" },
  {
    name: "@tool-evolver/harness-contracts",
    path: "packages/harness-contracts",
    entry: "dist/index.js",
    type: "package",
  },
  {
    name: "@tool-evolver/protocol",
    path: "packages/protocol",
    entry: "dist/index.js",
    type: "package",
  },
  {
    name: "@tool-evolver/runtime",
    path: "packages/runtime",
    entry: "dist/index.js",
    type: "package",
  },
  {
    name: "tool-evolver",
    path: "apps/cli",
    entry: "dist/index.js",
    bin: "dist/bin/cli.js",
    type: "app",
  },
  {
    name: "@tool-evolver/gateway",
    path: "apps/gateway",
    entry: "dist/index.js",
    bin: "dist/bin/gateway.js",
    type: "app",
  },
  {
    name: "@tool-evolver/observer",
    path: "apps/observer",
    entry: "dist/index.js",
    bin: "dist/bin/daemon.js",
    type: "app",
  },
  { name: "@tool-evolver/cloud", path: "apps/cloud", entry: "dist/index.js", type: "app" },
  {
    name: "@tool-evolver/adapter-claude-code",
    path: "adapters/claude-code",
    entry: "dist/index.js",
    type: "adapter",
  },
  {
    name: "@tool-evolver/adapter-codex",
    path: "adapters/codex-cli",
    entry: "dist/index.js",
    type: "adapter",
  },
  {
    name: "@tool-evolver/adapter-omp",
    path: "adapters/omp",
    entry: "dist/index.js",
    type: "adapter",
  },
  {
    name: "@tool-evolver/test-fixtures",
    path: "fixtures/test-fixtures",
    entry: "dist/index.js",
    type: "fixture",
  },
  { name: "@tool-evolver/e2e", path: "fixtures/e2e", entry: "dist/index.js", type: "fixture" },
];

export function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function fileSha256(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}

export function canonicalJson(val) {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(val[key])}`).join(",")}}`;
}

export function createUstarHeader({
  name,
  size,
  mode = 0o644,
  mtime = DETERMINISTIC_MTIME,
  typeflag = "0",
  uname = "root",
  gname = "root",
}) {
  const buf = Buffer.alloc(512, 0);
  let nameField = name;
  let prefixField = "";
  if (Buffer.byteLength(name) > 100) {
    const idx = name.lastIndexOf("/");
    if (idx > 0 && idx < 155) {
      prefixField = name.slice(0, idx);
      nameField = name.slice(idx + 1);
    }
  }
  if (Buffer.byteLength(nameField) > 100 || Buffer.byteLength(prefixField) > 155) {
    throw new Error(`USTAR path exceeds supported limits: ${name}`);
  }

  buf.write(nameField, 0, 100, "utf8");
  buf.write(`${mode.toString(8).padStart(6, "0")} \0`, 100, 8, "ascii");
  buf.write(`${(0).toString(8).padStart(6, "0")} \0`, 108, 8, "ascii");
  buf.write(`${(0).toString(8).padStart(6, "0")} \0`, 116, 8, "ascii");
  buf.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
  buf.write(`${mtime.toString(8).padStart(11, "0")} `, 136, 12, "ascii");
  buf.write(typeflag, 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  buf.write(uname, 265, 32, "ascii");
  buf.write(gname, 297, 32, "ascii");
  if (prefixField) buf.write(prefixField, 345, 155, "utf8");

  buf.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += buf[i];
  buf.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return buf;
}

export function createDeterministicTar(entries) {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const chunks = [];
  for (const entry of sorted) {
    const isDir = entry.type === "dir" || entry.path.endsWith("/");
    const contentBuf = isDir
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(entry.content ?? "", "utf8");
    const header = createUstarHeader({
      name: entry.path,
      size: contentBuf.length,
      mode: entry.mode ?? (isDir ? 0o755 : 0o644),
      mtime: entry.mtime ?? DETERMINISTIC_MTIME,
      typeflag: isDir ? "5" : "0",
    });
    chunks.push(header);
    if (contentBuf.length > 0) {
      chunks.push(contentBuf);
      const remainder = contentBuf.length % 512;
      if (remainder > 0) chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function gzipDeterministic(tarBuffer) {
  return zlib.gzipSync(tarBuffer, { mtime: 0, level: 9 });
}

export function buildWorkspacePackages(rootDir = process.cwd()) {
  console.log("🔨 Building all 15 workspace packages...");
  execSync("pnpm turbo run build", { cwd: rootDir, stdio: "inherit" });
  console.log("✅ All workspace packages built successfully.");
}

function collectFilesRecursively(dir, baseDir = dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(full, baseDir));
    } else if (entry.isFile()) {
      results.push({
        relPath: path.relative(baseDir, full).replace(/\\/g, "/"),
        fullPath: full,
      });
    }
  }
  return results;
}

function workspacePackageByDir(rootDir, packageDir) {
  const resolved = path.resolve(packageDir);
  return WORKSPACE_PACKAGES.find((pkg) => path.resolve(rootDir, pkg.path) === resolved);
}

function packagePayloadFiles(rootDir, packageDir) {
  const workspacePackage = workspacePackageByDir(rootDir, packageDir);
  if (!workspacePackage) {
    return collectFilesRecursively(packageDir, packageDir).filter(
      (file) => !file.relPath.startsWith("node_modules/") && !file.relPath.startsWith(".git/"),
    );
  }

  const files = [];
  const candidates = ["package.json", "README.md", "README", "LICENSE", "LICENSE.md"];
  for (const candidate of candidates) {
    const full = path.join(packageDir, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      files.push({ relPath: candidate, fullPath: full });
    }
  }
  for (const dirName of ["dist", "bin"]) {
    const full = path.join(packageDir, dirName);
    files.push(...collectFilesRecursively(full, packageDir));
  }
  return files;
}

function resolveDependencyDirectory(rootDir, importerDir, dependencyName) {
  const segments = dependencyName.split("/");
  const candidates = [
    path.join(importerDir, "node_modules", ...segments),
    path.join(rootDir, "node_modules", ...segments),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    } catch {
      // continue
    }
  }
  throw new Error(
    `Runtime dependency '${dependencyName}' required by '${importerDir}' is not installed.`,
  );
}

/**
 * Builds a real Node resolution tree inside the release archive. The previous
 * archive contained workspace dist files but no node_modules tree, so the
 * packaged entrypoints could not resolve @tool-evolver/* or external imports
 * outside the monorepo.
 */
export function collectStandaloneRuntimeEntries(rootDir = process.cwd()) {
  const cliDir = path.resolve(rootDir, "apps/cli");
  const cliPackage = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8"));
  const queue = Object.keys(cliPackage.dependencies ?? {}).map((name) => ({
    name,
    importerDir: cliDir,
  }));
  const visited = new Map();
  const entries = [];

  while (queue.length > 0) {
    const next = queue.shift();
    const packageDir = resolveDependencyDirectory(rootDir, next.importerDir, next.name);
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`Runtime dependency '${next.name}' has no package.json at '${packageDir}'.`);
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const previous = visited.get(next.name);
    if (previous) {
      if (previous.version !== packageJson.version) {
        throw new Error(
          `Standalone release requires conflicting versions of '${next.name}': '${previous.version}' and '${packageJson.version}'.`,
        );
      }
      continue;
    }
    visited.set(next.name, { version: packageJson.version, packageDir });

    const archiveBase = `tool-evolver/node_modules/${next.name}`;
    for (const file of packagePayloadFiles(rootDir, packageDir)) {
      const mode = fs.statSync(file.fullPath).mode & 0o111 ? 0o755 : 0o644;
      entries.push({
        path: `${archiveBase}/${file.relPath}`.replace(/\\/g, "/"),
        content: fs.readFileSync(file.fullPath),
        mode,
      });
    }

    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      queue.push({ name: dependencyName, importerDir: packageDir });
    }
  }

  return entries;
}

export function generatePackageDigests(rootDir = process.cwd()) {
  const result = {};
  for (const pkg of WORKSPACE_PACKAGES) {
    const pkgDir = path.resolve(rootDir, pkg.path);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    const pkgJson = fs.existsSync(pkgJsonPath)
      ? JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"))
      : { version: RELEASE_VERSION };
    const entryPath = path.join(pkgDir, pkg.entry);
    const entrySha256 = fs.existsSync(entryPath) ? fileSha256(entryPath) : sha256Hex(pkg.name);
    const distFiles = collectFilesRecursively(path.join(pkgDir, "dist"), pkgDir);
    const distFileHashes = distFiles
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((f) => `${f.relPath}:${fileSha256(f.fullPath)}`)
      .join("\n");
    result[pkg.name] = {
      version: pkgJson.version ?? RELEASE_VERSION,
      path: pkg.path,
      type: pkg.type,
      entry: pkg.entry,
      entrySha256,
      packageSha256: sha256Hex(distFileHashes || entrySha256),
      filesCount: distFiles.length,
    };
  }
  return result;
}

export function createPlatformReleaseTarballs(rootDir, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const rootPkgJson = JSON.parse(fs.readFileSync(path.resolve(rootDir, "package.json"), "utf8"));
  const assetResults = {};

  const baseEntries = [
    {
      path: "tool-evolver/package.json",
      content: JSON.stringify(
        {
          name: "tool-evolver",
          version: RELEASE_VERSION,
          description: "Autonomous, privacy-safe developer tool evolution platform",
          type: "module",
          bin: {
            "tool-evolver": "./bin/tool-evolver",
            "tool-evolver-daemon": "./bin/tool-evolver-daemon",
            "tool-evolver-mcp": "./bin/tool-evolver-mcp",
          },
          engines: rootPkgJson.engines ?? { node: ">=22.0.0" },
          license: "Apache-2.0",
        },
        null,
        2,
      ),
      mode: 0o644,
    },
    {
      path: "tool-evolver/bin/tool-evolver",
      content: "#!/usr/bin/env node\nimport { cliMain } from '../apps/cli/dist/index.js';\ncliMain(process.argv.slice(2));\n",
      mode: 0o755,
    },
    {
      path: "tool-evolver/bin/tool-evolver-daemon",
      content: "#!/usr/bin/env node\nimport { daemonMain } from '../apps/observer/dist/index.js';\ndaemonMain();\n",
      mode: 0o755,
    },
    {
      path: "tool-evolver/bin/tool-evolver-mcp",
      content: "#!/usr/bin/env node\nimport { gatewayMain } from '../apps/gateway/dist/index.js';\ngatewayMain();\n",
      mode: 0o755,
    },
    {
      path: "tool-evolver/README.md",
      content: `# Tool Evolver (v${RELEASE_VERSION})\n\nOfficial release distribution.\nRun \`npx tool-evolver init\` to get started.\n`,
      mode: 0o644,
    },
    {
      path: "tool-evolver/LICENSE",
      content: "Apache License Version 2.0, January 2004\nhttp://www.apache.org/licenses/\n",
      mode: 0o644,
    },
  ];

  for (const pkg of WORKSPACE_PACKAGES) {
    const pkgDir = path.resolve(rootDir, pkg.path);
    for (const file of collectFilesRecursively(path.join(pkgDir, "dist"), pkgDir)) {
      baseEntries.push({
        path: `tool-evolver/${pkg.path}/${file.relPath}`,
        content: fs.readFileSync(file.fullPath),
        mode: 0o644,
      });
    }
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      baseEntries.push({
        path: `tool-evolver/${pkg.path}/package.json`,
        content: fs.readFileSync(pkgJsonPath),
        mode: 0o644,
      });
    }
  }

  baseEntries.push(...collectStandaloneRuntimeEntries(rootDir));

  for (const platform of PLATFORMS) {
    const platformEntries = [
      ...baseEntries,
      {
        path: "tool-evolver/platform.json",
        content: JSON.stringify(
          {
            releaseVersion: RELEASE_VERSION,
            platform: platform.os,
            arch: platform.arch,
            isWsl: platform.isWsl,
            releaseDate: RELEASE_DATE,
          },
          null,
          2,
        ),
        mode: 0o644,
      },
    ];
    const gzBuffer = gzipDeterministic(createDeterministicTar(platformEntries));
    const tarballPath = path.join(outputDir, platform.filename);
    fs.writeFileSync(tarballPath, gzBuffer);
    assetResults[platform.id] = {
      filename: platform.filename,
      platform: platform.os,
      arch: platform.arch,
      isWsl: platform.isWsl,
      sizeBytes: gzBuffer.length,
      sha256: sha256Hex(gzBuffer),
      path: `dist/release/v${RELEASE_VERSION}/${platform.filename}`,
    };
  }

  return assetResults;
}

function resolveReleaseIdentity(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const testOnly = options.testOnly === true;
  const commitSha = options.commitSha || process.env.GITHUB_SHA || getGitCommitSha(rootDir);
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error(
      `Release commit SHA must be an exact 40-character Git SHA, received '${commitSha}'.`,
    );
  }
  const repository =
    options.repository || process.env.GITHUB_REPOSITORY || (testOnly ? "test-only/local" : "");
  const ref = options.ref || process.env.GITHUB_REF || (testOnly ? "refs/test-only/local" : "");
  const workflowRunId = String(
    options.workflowRunId || process.env.GITHUB_RUN_ID || (testOnly ? "test-only" : ""),
  );
  const workflowRunAttempt = String(
    options.workflowRunAttempt || process.env.GITHUB_RUN_ATTEMPT || (testOnly ? "1" : ""),
  );
  if (!testOnly && (!repository || !ref || !workflowRunId || !workflowRunAttempt)) {
    throw new Error(
      "Production release packaging requires GitHub repository/ref/run identity and cannot fabricate provenance.",
    );
  }
  return Object.freeze({
    repository,
    commitSha,
    ref,
    workflow: {
      name:
        options.workflowName || process.env.GITHUB_WORKFLOW || (testOnly ? "test-only-release" : ""),
      runId: workflowRunId,
      runAttempt: workflowRunAttempt,
    },
  });
}

function resolveSigningKey(options = {}) {
  if (options.keyPair) return options.keyPair;
  if (options.testOnly === true) return createTestReleaseSigningKey();
  return loadReleaseSigningKeyFromEnv();
}

export function generateSignedManifest(packageDigests, assetDigests, options = {}) {
  const keyPair = resolveSigningKey(options);
  const releaseIdentity = options.releaseIdentity || resolveReleaseIdentity(options);
  const evidence = options.evidence;
  if (!evidence && options.testOnly !== true) {
    throw new Error("Production release manifests require release evidence metadata before signing.");
  }
  const manifestPayload = {
    schemaVersion: "2.0.0",
    version: RELEASE_VERSION,
    releaseDate: RELEASE_DATE,
    releaseIdentity,
    packages: packageDigests,
    assets: assetDigests,
    runtimes: { deno: PINNED_DENO_RUNTIME },
    evidence: evidence || { status: "TEST_ONLY" },
  };
  return {
    ...manifestPayload,
    signatures: [{ ...signReleasePayload(manifestPayload, keyPair), signedAt: RELEASE_DATE }],
  };
}

export function generateCycloneDxSbom(rootDir, packageDigests) {
  const components = [];
  for (const [pkgName, meta] of Object.entries(packageDigests)) {
    components.push({
      type: meta.type === "app" ? "application" : "library",
      name: pkgName,
      version: RELEASE_VERSION,
      purl: `pkg:npm/${pkgName}@${RELEASE_VERSION}`,
      licenses: [{ license: { id: "Apache-2.0" } }],
      hashes: [{ alg: "SHA-256", content: meta.packageSha256 }],
      scope: "required",
    });
  }
  const thirdPartyDeps = [
    { name: "zod", version: "3.25.76", license: "MIT" },
    { name: "better-sqlite3", version: "11.8.1", license: "MIT" },
    { name: "fastify", version: "5.2.1", license: "MIT" },
    { name: "typescript", version: "5.7.3", license: "Apache-2.0" },
    { name: "vitest", version: "3.0.5", license: "MIT" },
    { name: "turbo", version: "2.4.4", license: "MIT" },
    { name: "@biomejs/biome", version: "1.9.4", license: "MIT" },
  ];
  for (const dep of thirdPartyDeps) {
    components.push({
      type: "library",
      name: dep.name,
      version: dep.version,
      purl: `pkg:npm/${dep.name}@${dep.version}`,
      licenses: [{ license: { id: dep.license } }],
      hashes: [{ alg: "SHA-256", content: sha256Hex(`${dep.name}@${dep.version}`) }],
      scope: "required",
    });
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: RELEASE_DATE,
      tools: [{ vendor: "tool-evolver", name: "package-release", version: RELEASE_VERSION }],
      component: {
        type: "application",
        name: "tool-evolver",
        version: RELEASE_VERSION,
        licenses: [{ license: { id: "Apache-2.0" } }],
      },
    },
    components,
  };
}

export function generateChannelMetadata(manifestSha256, options = {}) {
  const keyPair = resolveSigningKey(options);
  const releaseIdentity = options.releaseIdentity || resolveReleaseIdentity(options);
  const payload = {
    schemaVersion: "2.0.0",
    minSupportedVersion: "0.1.0",
    currentVersion: RELEASE_VERSION,
    updatedAt: RELEASE_DATE,
    releaseIdentity,
    channels: {
      stable: {
        version: RELEASE_VERSION,
        releaseDate: RELEASE_DATE,
        manifestUrl: `https://releases.tool-evolver.dev/v${RELEASE_VERSION}/manifest.json`,
        manifestDigest: manifestSha256,
        releaseNotesUrl: `https://docs.tool-evolver.dev/release/v${RELEASE_VERSION}-release-notes`,
        isLatest: true,
      },
    },
    rollbackReferences: {
      targetVersion: "0.1.0",
      minSafeVersion: "0.1.0",
      instructionsUrl: "https://docs.tool-evolver.dev/release/rollback-procedure",
    },
    revokedKeyIds: [...REVOKED_RELEASE_KEY_IDS],
  };
  return {
    ...payload,
    signatures: [{ ...signReleasePayload(payload, keyPair), signedAt: RELEASE_DATE }],
  };
}

export function packageRelease(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const skipBuild = options.skipBuild ?? false;
  const testOnly = options.testOnly ?? process.env.TOOL_EVOLVER_RELEASE_TEST_ONLY === "1";
  const distDir =
    options.distDir || options.outputDir || path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);

  const releaseIdentity = resolveReleaseIdentity({ ...options, rootDir, testOnly });
  const keyPair = resolveSigningKey({ ...options, testOnly });
  let verificationEvidence = options.verificationEvidence;
  if (!verificationEvidence && !testOnly && process.env.TOOL_EVOLVER_RELEASE_EVIDENCE_PATH) {
    const evidencePath = path.resolve(rootDir, process.env.TOOL_EVOLVER_RELEASE_EVIDENCE_PATH);
    verificationEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  }

  console.log(`📦 Packaging Tool Evolver V${RELEASE_VERSION} Release...`);
  console.log(`📂 Output Directory: ${distDir}`);
  console.log(`🔐 Trust Domain: ${keyPair.trustDomain}`);

  if (!skipBuild) buildWorkspacePackages(rootDir);

  const packageDigests = generatePackageDigests(rootDir);
  const assetDigests = createPlatformReleaseTarballs(rootDir, distDir);
  const evidenceResult = writeReleaseEvidence({
    rootDir,
    distDir,
    releaseIdentity,
    commitSha: releaseIdentity.commitSha,
    keyId: keyPair.keyId,
    testOnly,
    verificationEvidence,
    syncDocs: options.syncDocs ?? false,
  });
  const evidenceMetadata = {
    json: "release-evidence.json",
    markdown: "RELEASE-EVIDENCE.md",
    jsonSha256: evidenceResult.jsonSha256,
    markdownSha256: evidenceResult.markdownSha256,
    status: evidenceResult.evidence.status,
    mode: evidenceResult.evidence.mode,
  };
  const manifest = generateSignedManifest(packageDigests, assetDigests, {
    keyPair,
    releaseIdentity,
    evidence: evidenceMetadata,
    testOnly,
  });
  const manifestPath = path.join(distDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const manifestSha256 = fileSha256(manifestPath);

  fs.writeFileSync(
    path.join(distDir, "sbom.json"),
    JSON.stringify(generateCycloneDxSbom(rootDir, packageDigests), null, 2),
  );
  fs.writeFileSync(
    path.join(distDir, "channels.json"),
    JSON.stringify(generateChannelMetadata(manifestSha256, { keyPair, releaseIdentity, testOnly }), null, 2),
  );
  fs.writeFileSync(
    path.join(distDir, "release-trust.json"),
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        releaseVersion: RELEASE_VERSION,
        trustDomain: keyPair.trustDomain,
        signingKey: publicTrustRecord(keyPair),
        revokedKeyIds: [...REVOKED_RELEASE_KEY_IDS],
      },
      null,
      2,
    ),
  );

  return {
    success: true,
    version: RELEASE_VERSION,
    distDir,
    packagesCount: Object.keys(packageDigests).length,
    assetsCount: Object.keys(assetDigests).length,
    manifestSha256,
    evidenceSha256: evidenceResult.jsonSha256,
    releaseIdentity,
    publicTrust: publicTrustRecord(keyPair),
    trustedKeys: trustedKeysFromSigningKey(keyPair),
    testOnly,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  try {
    packageRelease();
  } catch (err) {
    console.error("❌ Release packaging failed:", err);
    process.exit(1);
  }
}
