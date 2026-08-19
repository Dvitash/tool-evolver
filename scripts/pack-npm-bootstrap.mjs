#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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

function normalizeInternalPackageEntrypoints(dependency, dependencyPath, dependencyManifest) {
  if (!dependency.startsWith("@tool-evolver/")) return dependencyManifest;

  const distIndex = path.join(dependencyPath, "dist", "index.js");
  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `Bundled internal dependency '${dependency}' is missing its built dist/index.js entrypoint.`,
    );
  }

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

function preparePortableManifest(stagingDir) {
  const packagePath = path.join(stagingDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error(`Deployed npm bootstrap is missing package.json: ${packagePath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (manifest.name !== "tool-evolver" || manifest.version !== "1.0.0") {
    throw new Error(
      `Unexpected deployed bootstrap identity: ${manifest.name ?? "<missing>"}@${manifest.version ?? "<missing>"}`,
    );
  }

  const dependencies = Object.keys(manifest.dependencies ?? {});
  for (const dependency of dependencies) {
    const dependencyPath = path.join(stagingDir, "node_modules", ...dependency.split("/"));
    if (!fs.existsSync(dependencyPath)) {
      throw new Error(`Deployed npm bootstrap is missing bundled dependency '${dependency}'.`);
    }
    const resolved = fs.realpathSync(dependencyPath);
    const relative = path.relative(stagingDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Bundled dependency '${dependency}' resolves outside deployment: ${resolved}`,
      );
    }

    const dependencyManifestPath = path.join(dependencyPath, "package.json");
    if (!fs.existsSync(dependencyManifestPath)) {
      throw new Error(`Bundled dependency '${dependency}' is missing package.json.`);
    }
    const dependencyManifest = normalizeInternalPackageEntrypoints(
      dependency,
      dependencyPath,
      JSON.parse(fs.readFileSync(dependencyManifestPath, "utf8")),
    );
    fs.writeFileSync(
      dependencyManifestPath,
      `${JSON.stringify(dependencyManifest, null, 2)}\n`,
      "utf8",
    );

    const specifier = manifest.dependencies[dependency];
    if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
      if (
        typeof dependencyManifest.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(dependencyManifest.version)
      ) {
        throw new Error(
          `Bundled workspace dependency '${dependency}' has invalid version '${dependencyManifest.version ?? "<missing>"}'.`,
        );
      }
      manifest.dependencies[dependency] = dependencyManifest.version;
    }
  }

  for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
      throw new Error(
        `Portable npm bootstrap retained workspace protocol for ${name}: ${specifier}`,
      );
    }
  }

  manifest.bundledDependencies = dependencies;
  fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function packNpmBootstrap(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const outputDir = path.resolve(rootDir, options.outputDir ?? "dist/npm");
  const ownsStagingDir = !options.stagingDir;
  const stagingDir = path.resolve(
    options.stagingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-npm-deploy-")),
  );
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    run(pnpm, ["--filter=./apps/cli", "--prod", "deploy", "--legacy", stagingDir], {
      cwd: rootDir,
    });
    const manifest = preparePortableManifest(stagingDir);
    const packOutput = run(npm, ["pack", stagingDir, "--pack-destination", outputDir, "--json"], {
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
    };
  } finally {
    if (ownsStagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
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
