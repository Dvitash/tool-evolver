import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMS, RELEASE_VERSION, packageRelease } from "./package-release.mjs";

describe("standalone platform release artifact", () => {
  const rootDir = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-standalone-"));
  const releaseDir = path.join(tempRoot, "release");
  const extractDir = path.join(tempRoot, "extract");
  const outsideCwd = path.join(tempRoot, "outside-workspace");

  beforeAll(() => {
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(outsideCwd, { recursive: true });
    packageRelease({ rootDir, distDir: releaseDir, skipBuild: true, testOnly: true });
  }, 30_000);

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("runs the packaged CLI with no monorepo module resolution", () => {
    const hostAsset =
      PLATFORMS.find(
        (candidate) =>
          candidate.os === process.platform && candidate.arch === process.arch && !candidate.isWsl,
      ) ?? PLATFORMS.find((candidate) => candidate.id === "linux-x64");

    expect(hostAsset).toBeDefined();
    const tarball = path.join(releaseDir, hostAsset.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "pipe" });

    const installedRoot = path.join(extractDir, "tool-evolver");
    expect(
      fs.existsSync(path.join(installedRoot, "node_modules", "@tool-evolver", "contracts")),
    ).toBe(true);
    expect(fs.existsSync(path.join(installedRoot, "node_modules", "zod"))).toBe(true);

    const cli = path.join(installedRoot, "bin", "tool-evolver");
    const env = { ...process.env, NODE_ENV: "production" };
    delete env.NODE_PATH;

    const version = execFileSync(process.execPath, [cli, "version"], {
      cwd: outsideCwd,
      env,
      encoding: "utf8",
    });
    expect(version.trim()).toBe(`tool-evolver v${RELEASE_VERSION}`);

    const help = execFileSync(process.execPath, [cli, "help"], {
      cwd: outsideCwd,
      env,
      encoding: "utf8",
    });
    expect(help).toContain("Tool Evolver CLI");
    expect(help).toContain("upgrade");
  });
});
