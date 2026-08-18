import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageRelease } from "./package-release.mjs";
import {
  QUALIFICATION_LANE_CONFIGS,
  REQUIRED_QUALIFICATION_LANES,
  createLaneSandbox,
  qualifyLane,
  runPlatformQualification,
} from "./platform-qualification.mjs";

describe("Platform Matrix Qualification Script Suite", () => {
  const rootDir = process.cwd();
  const testOutputDir = path.join(os.tmpdir(), `test-platform-qual-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(testOutputDir, { recursive: true });
    // Package release tarballs in isolated test directory
    packageRelease({
      rootDir,
      distDir: testOutputDir,
      skipBuild: true,
    });
  });

  afterAll(() => {
    try {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup
    }
  });

  describe("Qualification Configuration & Sandbox", () => {
    it("defines all 6 required qualification lanes", () => {
      expect(REQUIRED_QUALIFICATION_LANES).toHaveLength(6);
      expect(REQUIRED_QUALIFICATION_LANES).toEqual([
        "linux-x64",
        "linux-arm64",
        "darwin-x64",
        "darwin-arm64",
        "wsl-systemd",
        "wsl-fallback",
      ]);
    });

    it("creates and cleans up an isolated sandbox directory", () => {
      const sandbox = createLaneSandbox("linux-x64", testOutputDir);
      expect(fs.existsSync(sandbox.root)).toBe(true);
      expect(fs.existsSync(sandbox.home)).toBe(true);
      expect(fs.existsSync(sandbox.npmCache)).toBe(true);

      sandbox.cleanup();
      expect(fs.existsSync(sandbox.root)).toBe(false);
    });
  });

  describe("Single Lane Qualification", () => {
    it("successfully qualifies Linux x64 lane with all checks", async () => {
      const linuxConfig = QUALIFICATION_LANE_CONFIGS.find((l) => l.id === "linux-x64");
      expect(linuxConfig).toBeDefined();

      const result = await qualifyLane(linuxConfig, {
        rootDir,
        releaseDir: testOutputDir,
        tmpDir: testOutputDir,
      });

      expect(result.id).toBe("linux-x64");
      expect(result.status).toBe("passed");
      expect(result.serviceManager).toBe("systemd");
      expect(result.checks).toHaveLength(9);

      const checkNames = result.checks.map((c) => c.name);
      expect(checkNames).toContain("clean_install");
      expect(checkNames).toContain("service_registration");
      expect(checkNames).toContain("service_lifecycle");
      expect(checkNames).toContain("deno_runtime_assets");
      expect(checkNames).toContain("path_canonicalization_and_security");
      expect(checkNames).toContain("harness_matrix_integration");
      expect(checkNames).toContain("transactional_state");
      expect(checkNames).toContain("upgrade_and_rollback");
      expect(checkNames).toContain("channel_rules_and_revocation");

      for (const check of result.checks) {
        expect(check.passed).toBe(true);
      }
    });

    it("successfully qualifies macOS Apple Silicon (darwin-arm64) lane with launchd", async () => {
      const macConfig = QUALIFICATION_LANE_CONFIGS.find((l) => l.id === "darwin-arm64");
      expect(macConfig).toBeDefined();

      const result = await qualifyLane(macConfig, {
        rootDir,
        releaseDir: testOutputDir,
        tmpDir: testOutputDir,
      });

      expect(result.id).toBe("darwin-arm64");
      expect(result.status).toBe("passed");
      expect(result.serviceManager).toBe("launchd");
      expect(result.artifacts.unitPath).toContain("LaunchAgents");
    });

    it("successfully qualifies WSL fallback supervisor lane without systemd", async () => {
      const wslFallbackConfig = QUALIFICATION_LANE_CONFIGS.find((l) => l.id === "wsl-fallback");
      expect(wslFallbackConfig).toBeDefined();

      const result = await qualifyLane(wslFallbackConfig, {
        rootDir,
        releaseDir: testOutputDir,
        tmpDir: testOutputDir,
      });

      expect(result.id).toBe("wsl-fallback");
      expect(result.status).toBe("passed");
      expect(result.serviceManager).toBe("wsl-fallback");
      expect(result.artifacts.unitPath).toContain("tool-evolver-service.sh");
    });
  });

  describe("Full Platform Matrix Qualification Run", () => {
    it("runs complete matrix qualification across all 6 lanes and outputs platform-matrix.json", async () => {
      const qualResult = await runPlatformQualification({
        rootDir,
        releaseDir: testOutputDir,
        outputDir: testOutputDir,
        tmpDir: testOutputDir,
        skipPackaging: true,
      });

      expect(qualResult.valid).toBe(true);
      expect(fs.existsSync(qualResult.reportPath)).toBe(true);

      const report = qualResult.report;
      expect(report.schemaVersion).toBe("1.0.0");
      expect(report.releaseVersion).toBe("1.0.0");
      expect(report.overallStatus).toBe("passed");
      expect(report.totalLanes).toBe(6);
      expect(report.passedLanes).toBe(6);
      expect(report.failedLanes).toBe(0);

      // Verify all 3 harnesses are covered across the qualification lanes
      expect(report.harnessCoverage["claude-code"]).toBe(true);
      expect(report.harnessCoverage["codex-cli"]).toBe(true);
      expect(report.harnessCoverage.omp).toBe(true);

      // Verify each lane's integrity
      expect(report.lanes).toHaveLength(6);
      for (const lane of report.lanes) {
        expect(lane.status).toBe("passed");
        expect(lane.checks.every((c) => c.passed)).toBe(true);
        expect(lane.artifacts.releaseTarball).toBeDefined();
        expect(lane.artifacts.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it("detects and flags failure when an artifact is missing", async () => {
      const emptyDir = path.join(testOutputDir, "empty-release");
      fs.mkdirSync(emptyDir, { recursive: true });

      const linuxConfig = QUALIFICATION_LANE_CONFIGS[0];
      const result = await qualifyLane(linuxConfig, {
        rootDir,
        releaseDir: emptyDir,
        tmpDir: testOutputDir,
      });

      expect(result.status).toBe("failed");
      const cleanInstallCheck = result.checks.find((c) => c.name === "clean_install");
      expect(cleanInstallCheck?.passed).toBe(false);
      expect(cleanInstallCheck?.error).toContain("Release candidate tarball not found");
    });
  });
});
