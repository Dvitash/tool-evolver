#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SUITES = Object.freeze([
  "fixtures/e2e/tests/real-process-topology.test.ts",
  "apps/cloud/tests/evolution/lifecycle/orchestrator-e2e.test.ts",
  "apps/cloud/tests/evolution/lifecycle/crash-recovery-and-idempotency.test.ts",
  "apps/cloud/tests/evolution/lifecycle/dlq-and-fault-recovery.test.ts",
  "apps/cloud/tests/evolution/lifecycle/signed-publication.test.ts",
  "apps/cloud/tests/staging/backup-restore-rehearsal.test.ts",
  "apps/cloud/tests/staging/fault-injection-matrix.test.ts",
  "apps/cloud/tests/staging/soak-profile.test.ts",
  "apps/cli/tests/installer/production-release-transaction.test.ts",
]);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--release-dir") options.releaseDir = argv[++i];
    else if (arg.startsWith("--release-dir=")) options.releaseDir = arg.slice(14);
    else if (arg === "--output") options.output = argv[++i];
    else if (arg.startsWith("--output=")) options.output = arg.slice(9);
  }
  return options;
}

function collectReleaseBinding(releaseDir) {
  const manifestPath = path.join(releaseDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const assets = {};
  for (const [id, asset] of Object.entries(manifest.assets ?? {})) {
    const assetPath = path.join(releaseDir, asset.filename);
    if (!fs.existsSync(assetPath)) throw new Error(`Missing release asset ${id}: ${asset.filename}`);
    const actual = sha256File(assetPath);
    if (actual !== asset.sha256) {
      throw new Error(`Release asset digest mismatch for ${id}: expected ${asset.sha256}, got ${actual}`);
    }
    assets[id] = {
      filename: asset.filename,
      sha256: actual,
      sizeBytes: fs.statSync(assetPath).size,
    };
  }
  return {
    version: manifest.version,
    commitSha: manifest.releaseIdentity?.commitSha,
    manifestSha256: sha256File(manifestPath),
    assets,
  };
}

export function runSystemQualification(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const releaseDir = path.resolve(rootDir, options.releaseDir ?? "dist/release/v1.0.0");
  const outputPath = path.resolve(rootDir, options.output ?? "dist/qualification/system-e2e.json");
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const release = collectReleaseBinding(releaseDir);

  if (!/^[0-9a-f]{40}$/i.test(release.commitSha ?? "")) {
    throw new Error(`Qualification release commit is invalid: ${release.commitSha}`);
  }

  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, ["exec", "vitest", "run", "--testTimeout=60000", "--hookTimeout=60000", ...SUITES], {
    cwd: rootDir,
    env: { ...process.env, TOOL_EVOLVER_RELEASE_TEST_ONLY: "1" },
    encoding: "utf8",
    timeout: 12 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
  });

  const passed = result.status === 0;
  const evidence = {
    schemaVersion: "1.0.0",
    qualification: "FIN-005-clean-checkout-full-system",
    status: passed ? "PASSED" : "FAILED",
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    environment: {
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      nodeVersion: process.version,
      runnerOs: process.env.RUNNER_OS ?? null,
      runnerArch: process.env.RUNNER_ARCH ?? null,
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
    release,
    suites: SUITES.map((suite) => ({ path: suite, status: passed ? "PASSED" : "FAILED" })),
    coverage: {
      realProcessHappyPath: true,
      generatedToolInvocation: true,
      daemonAndCloudRestartRecovery: true,
      canaryRollbackAndQuarantine: true,
      deterministicRetryAndDlq: true,
      backupRestore: true,
      dependencyFaultInjection: true,
      signedPublication: true,
      tamperedInstallTrustPath: true,
    },
    testProcess: {
      exitCode: result.status,
      signal: result.signal,
      error: result.error ? String(result.error.message ?? result.error) : null,
    },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);

  if (!passed) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`Full-system qualification failed; evidence written to ${outputPath}`);
  }

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.stdout.write(`\nFull-system qualification evidence: ${outputPath}\n`);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    runSystemQualification(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
}
