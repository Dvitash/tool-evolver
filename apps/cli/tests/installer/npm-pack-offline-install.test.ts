import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("public npm bootstrap offline installation", () => {
  it("packs all runtime dependencies and executes from a clean npm install with network disabled", () => {
    const rootDir = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-npm-offline-"));
    tempDirs.push(tempDir);
    const packDir = path.join(tempDir, "pack");
    const installDir = path.join(tempDir, "install");
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(installDir, { recursive: true });

    const packed = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(rootDir, "scripts", "pack-npm-bootstrap.mjs"), `--output-dir=${packDir}`],
        { cwd: rootDir, encoding: "utf8" },
      ),
    ) as { tarballPath: string; filename: string };

    expect(packed.filename).toBe("tool-evolver-1.0.0.tgz");
    expect(fs.existsSync(packed.tarballPath)).toBe(true);

    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        installDir,
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        packed.tarballPath,
      ],
      {
        cwd: installDir,
        env: { ...process.env, npm_config_update_notifier: "false" },
        stdio: "pipe",
      },
    );

    const packageRoot = path.join(installDir, "node_modules", "tool-evolver");
    expect(fs.existsSync(path.join(packageRoot, "node_modules", "@tool-evolver", "contracts"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(packageRoot, "node_modules", "zod"))).toBe(true);

    const cli = path.join(packageRoot, "bin", "tool-evolver.mjs");
    const env = { ...process.env, NODE_ENV: "production" };
    delete env.NODE_PATH;

    const help = execFileSync(process.execPath, [cli, "help"], {
      cwd: installDir,
      env,
      encoding: "utf8",
    });
    expect(help).toContain("Tool Evolver CLI");

    const version = execFileSync(process.execPath, [cli, "version"], {
      cwd: installDir,
      env,
      encoding: "utf8",
    });
    expect(version.trim()).toBe("tool-evolver v1.0.0");
  }, 60_000);
});
