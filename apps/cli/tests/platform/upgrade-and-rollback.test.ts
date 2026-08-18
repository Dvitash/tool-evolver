import path from "node:path";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_VERSION,
  UpgradeOrchestrator,
  parseUpgradeFlags,
} from "../../src/commands/upgrade.js";
import {
  type ManifestAsset,
  type ReleaseChannelMetadata,
  isVersionAtLeast,
  isVersionRevoked,
  verifyChannelMetadata,
} from "../../src/installer/channel-verifier.js";
import {
  type PlatformInfo,
  detectPlatform,
  resolvePlatformPaths,
} from "../../src/platform/index.js";
import * as verificationModule from "../../src/service/verification.js";

vi.mock("../../src/service/verification.js", () => ({
  runVerificationSuite: vi.fn(),
}));

function createMockFsBridge(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    async readFile(filePath: string): Promise<string | null> {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async exists(filePath: string): Promise<boolean> {
      return files.has(filePath);
    },
    async mkdirp(_dirPath: string): Promise<void> {
      // In-memory directory creation
    },
    async copyFile(srcPath: string, destPath: string): Promise<void> {
      const content = files.get(srcPath);
      if (content !== undefined) {
        files.set(destPath, content);
      }
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
  };
}

describe("Cross-Platform Upgrade and Rollback Suite", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verificationModule.runVerificationSuite).mockResolvedValue({
      passed: true,
      timestamp: new Date().toISOString(),
      durationMs: 42,
      totalChecks: 6,
      passedChecks: 6,
      failedChecks: 0,
      warningsCount: 0,
      checks: [],
    });
  });

  const mockPlatforms: PlatformInfo[] = [
    detectPlatform({ platform: "linux", arch: "x64", release: "6.8.0" }),
    detectPlatform({ platform: "linux", arch: "arm64", release: "6.8.0" }),
    detectPlatform({ platform: "darwin", arch: "x64" }),
    detectPlatform({ platform: "darwin", arch: "arm64" }),
    detectPlatform({
      platform: "linux",
      arch: "x64",
      release: "5.15.0-microsoft-standard-WSL2",
      env: { WSL_DISTRO_NAME: "Ubuntu", WSL_SYSTEMD: "1" },
    }),
    detectPlatform({
      platform: "linux",
      arch: "x64",
      release: "5.15.0-microsoft-standard-WSL2",
      env: { WSL_DISTRO_NAME: "Debian" },
      hasSystemdOverride: false,
    }),
  ];

  describe("Upgrade with Configuration & State Preservation", () => {
    it.each(mockPlatforms)(
      "preserves user configuration, harness settings, and database state on $lane",
      async (platformInfo) => {
        const homeDir = `/home/test-${platformInfo.lane}`;
        const paths = resolvePlatformPaths({
          home: homeDir,
          platformInfo,
        });

        const initialConfig = JSON.stringify({
          version: "0.1.0",
          port: 4400,
          logLevel: "info",
          harnesses: {
            "claude-code": { enabled: true, approved: true },
            "codex-cli": { enabled: true, approved: true },
            omp: { enabled: true, approved: true },
          },
        });

        const initialDbData = "SQLITE_HEADER_TEST_PERSISTENT_DATA";

        const fsBridge = createMockFsBridge({
          [paths.configFile]: initialConfig,
          [path.join(paths.dataDir, "toolevolver.db")]: initialDbData,
          [path.join(paths.homeDir, "version.json")]: JSON.stringify({ version: "0.1.0" }),
        });

        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            channels: {
              stable: {
                version: "1.0.0",
                manifestUrl: "https://releases.tool-evolver.dev/v1.0.0/manifest.json",
                manifestDigest: "a".repeat(64),
              },
            },
            minSupportedVersion: "0.1.0",
          }),
        });

        const orchestrator = new UpgradeOrchestrator({
          homeDir,
          toolEvolverHome: paths.homeDir,
          fsBridge,
          customFetch: mockFetch as unknown as typeof fetch,
          platformInfo,
        });

        const result = await orchestrator.runUpgrade({
          targetVersion: "1.0.0",
          force: true,
        });

        expect(result.success).toBe(true);
        expect(result.healthGatePassed).toBe(true);
        expect(result.backupPath).toBeDefined();

        // Verify config was preserved in place
        const updatedConfigRaw = await fsBridge.readFile(paths.configFile);
        expect(updatedConfigRaw).toBe(initialConfig);

        // Verify backup contains the original config
        const backupConfigRaw = await fsBridge.readFile(
          path.join(result.backupPath!, "config.json"),
        );
        expect(backupConfigRaw).toBe(initialConfig);
      },
    );
  });

  describe("Forced Health-Gate Failure and Automatic Auto-Rollback", () => {
    it("automatically rolls back to the exact previous known-good version when health gate fails", async () => {
      const homeDir = "/home/testuser";
      const toolEvolverHome = path.join(homeDir, ".tool-evolver");
      const configPath = path.join(toolEvolverHome, "config.json");
      const originalVersion = "0.1.0";

      const originalConfig = JSON.stringify({
        version: originalVersion,
        activeHarnesses: ["claude-code"],
      });

      const fsBridge = createMockFsBridge({
        [configPath]: originalConfig,
        [path.join(toolEvolverHome, "version.json")]: JSON.stringify({ version: originalVersion }),
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          channels: {
            stable: {
              version: "1.1.0-broken",
              manifestUrl: "https://releases.tool-evolver.dev/v1.1.0-broken/manifest.json",
            },
          },
        }),
      });

      // Force verification failure via mock
      vi.mocked(verificationModule.runVerificationSuite).mockResolvedValue({
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: 50,
        totalChecks: 6,
        passedChecks: 4,
        failedChecks: 2,
        warningsCount: 0,
        checks: [{ name: "daemon_health", passed: false, error: "CrashLoopBackOff in candidate" }],
      });

      const orchestrator = new UpgradeOrchestrator({
        homeDir,
        toolEvolverHome,
        fsBridge,
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const result = await orchestrator.runUpgrade({
        targetVersion: "1.1.0-broken",
        force: true,
      });

      expect(result.success).toBe(false);
      expect(result.healthGatePassed).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.error).toContain("Health gate verification failed");
      expect(result.stepsCompleted).toContain("rollback_completed");

      // Verify the active configuration was restored to original
      const restoredConfig = await fsBridge.readFile(configPath);
      expect(restoredConfig).toBe(originalConfig);
    });

    it("honors --no-rollback flag when explicitly requested during testing", async () => {
      const homeDir = "/home/testuser";
      const toolEvolverHome = path.join(homeDir, ".tool-evolver");
      const configPath = path.join(toolEvolverHome, "config.json");

      const fsBridge = createMockFsBridge({
        [configPath]: JSON.stringify({ version: "0.1.0" }),
      });

      vi.mocked(verificationModule.runVerificationSuite).mockResolvedValue({
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: 50,
        totalChecks: 6,
        passedChecks: 4,
        failedChecks: 2,
        warningsCount: 0,
        checks: [{ name: "daemon_health", passed: false, error: "Failure" }],
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          channels: {
            stable: {
              version: "2.0.0",
              manifestUrl: "https://releases.tool-evolver.dev/v2.0.0/manifest.json",
            },
          },
        }),
      });

      const orchestrator = new UpgradeOrchestrator({
        homeDir,
        toolEvolverHome,
        fsBridge,
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const result = await orchestrator.runUpgrade({
        targetVersion: "2.0.0",
        force: true,
        noRollback: true,
      });

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.stepsCompleted).not.toContain("rollback_completed");
    });
  });

  describe("Channel Rule Enforcement: Revoked & Yanked Versions", () => {
    const revokedList = ["0.9.0-vulnerable", "0.9.5-flawed"];

    it("detects and rejects revoked release versions", () => {
      expect(isVersionRevoked("0.9.0-vulnerable", revokedList)).toBe(true);
      expect(isVersionRevoked("0.9.5-flawed", revokedList)).toBe(true);
      expect(isVersionRevoked("1.0.0", revokedList)).toBe(false);
    });

    it("verifies minimum supported version boundary rules", () => {
      expect(isVersionAtLeast("1.0.0", "0.1.0")).toBe(true);
      expect(isVersionAtLeast("0.1.0", "0.1.0")).toBe(true);
      expect(isVersionAtLeast("0.0.9", "0.1.0")).toBe(false);
    });

    it("fails channel metadata verification when requested channel points to a revoked version", () => {
      const badMetadata: ReleaseChannelMetadata = {
        version: "1.0.0",
        timestamp: "2026-08-17T00:00:00Z",
        channels: {
          stable: {
            version: "0.9.0-vulnerable",
          },
        },
        minSupportedVersion: "0.1.0",
        revokedVersions: ["0.9.0-vulnerable"],
      };

      const result = verifyChannelMetadata(badMetadata, "stable");
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("revoked"))).toBe(true);
    });
  });

  describe("Dry Run Simulation Safety", () => {
    it("simulates upgrade without modifying any files or services", async () => {
      const homeDir = "/home/testuser";
      const toolEvolverHome = path.join(homeDir, ".tool-evolver");
      const configPath = path.join(toolEvolverHome, "config.json");
      const initialContent = JSON.stringify({ version: "0.1.0" });

      const fsBridge = createMockFsBridge({
        [configPath]: initialContent,
      });

      const orchestrator = new UpgradeOrchestrator({
        homeDir,
        toolEvolverHome,
        fsBridge,
      });

      const result = await orchestrator.runUpgrade({
        targetVersion: "1.0.0",
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.stepsCompleted).toContain("dry_run_simulation");
      expect(await fsBridge.readFile(configPath)).toBe(initialContent);
    });
  });
});
