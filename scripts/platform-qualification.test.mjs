import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageRelease } from "./package-release.mjs";
import {
  REQUIRED_QUALIFICATION_LANES,
  detectHostLane,
  qualifyPlatformLane,
  runPlatformQualification,
} from "./platform-qualification.mjs";

describe("real host platform qualification", () => {
  const rootDir = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-platform-qual-"));
  const releaseDir = path.join(tempRoot, "release");
  const outputDir = path.join(tempRoot, "evidence");

  beforeAll(() => {
    fs.mkdirSync(releaseDir, { recursive: true });
    packageRelease({ rootDir, distDir: releaseDir, skipBuild: true, testOnly: true });
  }, 30_000);

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("maps supported hosts and WSL without synthetic lane overrides", () => {
    expect(
      detectHostLane({ platform: "linux", arch: "x64", release: "6.8.0", procVersion: "Linux" }),
    ).toBe("linux-x64");
    expect(
      detectHostLane({ platform: "linux", arch: "arm64", release: "6.8.0", procVersion: "Linux" }),
    ).toBe("linux-arm64");
    expect(detectHostLane({ platform: "darwin", arch: "x64" })).toBe("darwin-x64");
    expect(detectHostLane({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(
      detectHostLane({
        platform: "linux",
        arch: "x64",
        release: "6.8.0-microsoft-standard-WSL2",
        procVersion: "Linux version Microsoft WSL2",
      }),
    ).toBe("wsl");
    expect(detectHostLane({ platform: "win32", arch: "x64" })).toBeNull();
    expect(REQUIRED_QUALIFICATION_LANES).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "wsl",
    ]);
  });

  it("marks a non-executing lane unavailable instead of fabricating a pass", async () => {
    const hostLane = detectHostLane();
    const otherLane = REQUIRED_QUALIFICATION_LANES.find((lane) => lane !== hostLane);
    expect(otherLane).toBeDefined();
    const result = await qualifyPlatformLane(otherLane, { releaseDir, outputDir });
    expect(result.passed).toBe(false);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.error).toContain("Host mismatch");
  });

  it("qualifies the exact packaged artifact through real local processes on the executing host", async () => {
    const hostLane = detectHostLane();
    expect(hostLane).not.toBeNull();
    const result = await runPlatformQualification({
      lane: hostLane,
      releaseDir,
      outputDir,
    });

    if (!result.passed) {
      console.error(JSON.stringify(result, null, 2));
    }

    expect(result.passed).toBe(true);
    expect(result.status).toBe("QUALIFIED");
    expect(result.totalLanes).toBe(1);
    expect(result.passedLanes).toBe(1);
    const lane = result.lanes[0];
    expect(lane.host.lane).toBe(hostLane);
    expect(lane.release.commitSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(lane.release.assetSha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(lane.release.manifestSha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(lane.checks.artifactDigest).toBe(true);
    expect(lane.checks.packagedCli.initDryRun).toBe(true);
    expect(lane.checks.daemon.authenticatedStatus).toBe(true);
    expect(lane.checks.daemon.diagnostics).toBe(true);
    expect(lane.checks.mcp.catalogRefresh).toBe(true);
    expect(lane.checks.mcp.toolInvocation).toBe(true);
    expect(lane.checks.cloud.live).toBe(true);
    expect(lane.checks.cloud.ready).toBe(true);
    expect(lane.harnesses).toHaveLength(3);
    for (const harness of lane.harnesses) {
      expect(["ready", "unavailable"]).toContain(harness.status);
      expect(harness.status === "ready").toBe(harness.qualified);
    }
    expect(fs.existsSync(path.join(outputDir, `${hostLane}.json`))).toBe(true);
  }, 60_000);
});
