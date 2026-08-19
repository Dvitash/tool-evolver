#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const REQUIRED_PORTABLE_RUNTIME_DEPENDENCIES = ["typescript"];

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg.startsWith("--output-dir=")) options.outputDir = arg.slice(13);
    else if (arg === "--staging-dir") options.stagingDir = argv[++index];
    else if (arg.startsWith("--staging-dir=")) options.stagingDir = arg.slice(14);
  }
  return options;
}

function copyPackageTree(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const stat = fs.lstatSync(sourcePath);

    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(sourcePath);
      const resolvedStat = fs.statSync(resolved);
      if (resolvedStat.isDirectory()) {
        copyPackageTree(resolved, destinationPath);
      } else if (resolvedStat.isFile()) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(resolved, destinationPath);
        fs.chmodSync(destinationPath, resolvedStat.mode & 0o777);
      }
      continue;
    }

    if (stat.isDirectory()) {
      copyPackageTree(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
      fs.chmodSync(destinationPath, stat.mode & 0o777);
    }
  }
}

function readManifest(packageDir, label) {
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${label} is missing package.json: ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function writeManifest(packageDir, manifest) {
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function normalizeInternalPackageEntrypoints(dependency, dependencyPath, dependencyManifest) {
  if (!dependency.startsWith("@tool-evolver/")) return dependencyManifest;

  const distIndex = path.join(dependencyPath, "dist", "index.js");
  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `Bundled internal dependency '${dependency}' is missing its built dist/index.js entrypoint.`,
    );
  }

  dependencyManifest.private = false;
  dependencyManifest.main = "./dist/index.js";
  const distTypes = path.join(dependencyPath, "dist", "index.d.ts");
  if (fs.existsSync(distTypes)) dependencyManifest.types = "./dist/index.d.ts";

  const exportsField =
    dependencyManifest.exports && typeof dependencyManifest.exports === "object"
      ? dependencyManifest.exports
      : {};
  exportsField["."] = {
    ...(fs.existsSync(distTypes) ? { types: "./dist/index.d.ts" } : {}),
    import: "./dist/index.js",
    default: "./dist/index.js",
  };
  dependencyManifest.exports = exportsField;
  return dependencyManifest;
}

function resolveDependencyDirectory(packageDir, resolutionRoot, dependency) {
  let cursor = packageDir;
  const resolvedRoot = path.resolve(resolutionRoot);
  while (true) {
    const candidate = path.join(cursor, "node_modules", ...dependency.split("/"));
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    if (path.resolve(cursor) === resolvedRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const rootCandidate = path.join(resolutionRoot, "node_modules", ...dependency.split("/"));
  if (fs.existsSync(rootCandidate)) return fs.realpathSync(rootCandidate);
  throw new Error(`Unable to resolve runtime dependency '${dependency}' from ${packageDir}.`);
}

function materializePortableTree(deployDir, portableDir, repositoryRoot) {
  copyPackageTree(deployDir, portableDir);
  const rootManifest = readManifest(portableDir, "Deployed npm bootstrap");
  if (rootManifest.name !== "tool-evolver" || rootManifest.version !== "1.0.0") {
    throw new Error(
      `Unexpected deployed bootstrap identity: ${rootManifest.name ?? "<missing>"}@${rootManifest.version ?? "<missing>"}`,
    );
  }

  const queue = [
    ...Object.keys(rootManifest.dependencies ?? {}).map((name) => ({
      name,
      requesterSourceDir: deployDir,
      resolutionRoot: deployDir,
    })),
    ...REQUIRED_PORTABLE_RUNTIME_DEPENDENCIES.map((name) => ({
      name,
      requesterSourceDir: repositoryRoot,
      resolutionRoot: repositoryRoot,
    })),
  ];
  const copiedVersions = new Map();
  const dependencyVersions = new Map();

  while (queue.length > 0) {
    const { name, requesterSourceDir, resolutionRoot } = queue.shift();
    const sourceDir = resolveDependencyDirectory(requesterSourceDir, resolutionRoot, name);
    const sourceManifest = readManifest(sourceDir, `Runtime dependency '${name}'`);
    if (sourceManifest.name !== name) {
      throw new Error(
        `Resolved dependency identity mismatch for '${name}': received '${sourceManifest.name ?? "<missing>"}'.`,
      );
    }
    if (typeof sourceManifest.version !== "string" || sourceManifest.version.length === 0) {
      throw new Error(`Runtime dependency '${name}' has no concrete package version.`);
    }

    const existingVersion = copiedVersions.get(name);
    if (existingVersion) {
      if (existingVersion !== sourceManifest.version) {
        throw new Error(
          `Portable bootstrap cannot flatten conflicting versions of '${name}': ${existingVersion} vs ${sourceManifest.version}.`,
        );
      }
      continue;
    }

    const destinationDir = path.join(portableDir, "node_modules", ...name.split("/"));
    copyPackageTree(sourceDir, destinationDir);
    const destinationManifest = normalizeInternalPackageEntrypoints(
      name,
      destinationDir,
      readManifest(destinationDir, `Materialized dependency '${name}'`),
    );

    for (const [childName, specifier] of Object.entries(destinationManifest.dependencies ?? {})) {
      const childSourceDir = resolveDependencyDirectory(sourceDir, resolutionRoot, childName);
      const childManifest = readManifest(childSourceDir, `Runtime dependency '${childName}'`);
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        destinationManifest.dependencies[childName] = childManifest.version;
      }
      queue.push({
        name: childName,
        requesterSourceDir: sourceDir,
        resolutionRoot,
      });
    }

    writeManifest(destinationDir, destinationManifest);
    copiedVersions.set(name, sourceManifest.version);
    dependencyVersions.set(name, sourceManifest.version);
  }

  for (const [dependency, version] of dependencyVersions) {
    rootManifest.dependencies ??= {};
    rootManifest.dependencies[dependency] = version;
  }
  for (const [name, specifier] of Object.entries(rootManifest.dependencies ?? {})) {
    if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
      const version = dependencyVersions.get(name);
      if (!version) {
        throw new Error(
          `Portable npm bootstrap retained unresolved workspace dependency '${name}'.`,
        );
      }
      rootManifest.dependencies[name] = version;
    }
  }

  rootManifest.bundledDependencies = [...copiedVersions.keys()].sort();
  writeManifest(portableDir, rootManifest);

  for (const dependency of rootManifest.bundledDependencies) {
    const dependencyPath = path.join(portableDir, "node_modules", ...dependency.split("/"));
    if (!fs.existsSync(dependencyPath)) {
      throw new Error(`Portable bootstrap is missing bundled dependency '${dependency}'.`);
    }
    const realPath = fs.realpathSync(dependencyPath);
    const relative = path.relative(portableDir, realPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Bundled dependency '${dependency}' resolves outside portable package.`);
    }
  }

  return rootManifest;
}

export function packNpmBootstrap(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const outputDir = path.resolve(rootDir, options.outputDir ?? "dist/npm");
  const ownsWorkDir = !options.stagingDir;
  const workDir = path.resolve(
    options.stagingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-npm-work-")),
  );
  const deployDir = path.join(workDir, "deploy");
  const portableDir = path.join(workDir, "portable");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(deployDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    run(pnpm, ["--filter=./apps/cli", "--prod", "deploy", "--legacy", deployDir], {
      cwd: rootDir,
    });
    const manifest = materializePortableTree(deployDir, portableDir, rootDir);
    const packOutput = run(npm, ["pack", portableDir, "--pack-destination", outputDir, "--json"], {
      cwd: rootDir,
    });
    const parsed = JSON.parse(packOutput);
    const filename = parsed?.[0]?.filename;
    if (!filename) throw new Error(`npm pack returned no filename: ${packOutput}`);
    const tarballPath = path.join(outputDir, filename);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`npm bootstrap tarball was not created: ${tarballPath}`);
    }
    return {
      tarballPath,
      filename,
      version: manifest.version,
      packageName: manifest.name,
      bundledDependencies: manifest.bundledDependencies,
    };
  } finally {
    if (ownsWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  try {
    const result = packNpmBootstrap(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  }
}
