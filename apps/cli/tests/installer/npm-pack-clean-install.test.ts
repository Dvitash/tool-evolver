import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractTarArchive,
  extractTarGzBuffer,
  getActiveVersion,
  installReleaseVersion,
  rollbackActiveVersion,
  sha256Hex,
  switchActiveVersion,
} from "../../src/installer/asset-downloader.js";
import { ToolEvolverInstaller } from "../../src/installer/installer.js";

describe("npm-pack-clean-install: Public bootstrap package & clean environment installation", () => {
  let tempTestDir: string;
  let fakeHome: string;
  let cliPackageDir: string;

  beforeEach(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-evolver-pack-test-"));
    fakeHome = path.join(tempTestDir, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    cliPackageDir = fs.existsSync(path.join(process.cwd(), "apps", "cli", "package.json"))
      ? path.join(process.cwd(), "apps", "cli")
      : path.resolve(process.cwd());
  });

  afterEach(() => {
    try {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    } catch {}
  });

  it("validates public package manifest name, privacy, bin, and files boundaries", () => {
    const pkgJsonPath = path.join(cliPackageDir, "package.json");
    expect(fs.existsSync(pkgJsonPath)).toBe(true);

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

    // Intended public name & command
    expect(pkgJson.name).toBe("tool-evolver");
    expect(pkgJson.private).toBe(false);
    expect(pkgJson.bin).toBeDefined();
    expect(pkgJson.bin["tool-evolver"]).toBe("./bin/tool-evolver.mjs");

    // Files allowlist
    expect(pkgJson.files).toBeDefined();
    expect(pkgJson.files).toContain("dist");
    expect(pkgJson.files).toContain("bin");

    // Exports
    expect(pkgJson.exports).toBeDefined();
    expect(pkgJson.exports["."]).toBeDefined();
    expect(pkgJson.exports["./installer/channel-verifier"]).toBeDefined();
    expect(pkgJson.exports["./installer/asset-downloader"]).toBeDefined();
    expect(pkgJson.exports["./installer/user-service"]).toBeDefined();
  });

  it("verifies compiled entry point shebang and existence on disk", () => {
    const binScriptPath = path.join(cliPackageDir, "bin", "tool-evolver.mjs");
    expect(fs.existsSync(binScriptPath)).toBe(true);

    const binContent = fs.readFileSync(binScriptPath, "utf8");
    expect(binContent.startsWith("#!/usr/bin/env node")).toBe(true);

    const distBinPath = path.join(cliPackageDir, "dist", "bin", "cli.js");
    expect(fs.existsSync(distBinPath)).toBe(true);
  });

  it("simulates npm pack and verifies published tarball contains only necessary artifacts", () => {
    // Run npm pack in a temporary directory
    const packOutDir = path.join(tempTestDir, "pack-output");
    fs.mkdirSync(packOutDir, { recursive: true });

    const packOutput = execSync(`npm pack ${cliPackageDir} --pack-destination ${packOutDir}`, {
      encoding: "utf8",
    }).trim();

    const lines = packOutput.split("\n");
    const tarballFileName = lines[lines.length - 1]?.trim();
    expect(tarballFileName).toMatch(/^tool-evolver-.*\.tgz$/);

    const tarballPath = path.join(packOutDir, tarballFileName);
    expect(fs.existsSync(tarballPath)).toBe(true);

    // Decompress and inspect tar archive members
    const tarGzBuffer = fs.readFileSync(tarballPath);
    const tarBuffer = zlib.gunzipSync(tarGzBuffer);
    const { extractedFiles } = extractTarArchive(tarBuffer, path.join(tempTestDir, "unpacked"));

    const relativeFiles = extractedFiles.map((f) =>
      path.relative(path.join(tempTestDir, "unpacked", "package"), f).replace(/\\/g, "/"),
    );

    // Ensure required files are present
    expect(relativeFiles).toContain("package.json");
    expect(relativeFiles).toContain("bin/tool-evolver.mjs");
    expect(relativeFiles).toContain("dist/index.js");
    expect(relativeFiles).toContain("dist/bin/cli.js");

    // Ensure unwanted source files and tests are NOT included
    const hasTests = relativeFiles.some((f) => f.includes("tests/") || f.endsWith(".test.ts"));
    const hasTsBuildInfo = relativeFiles.some((f) => f.endsWith(".tsbuildinfo"));
    const hasSrc = relativeFiles.some((f) => f.startsWith("src/"));

    expect(hasTests).toBe(false);
    expect(hasTsBuildInfo).toBe(false);
    expect(hasSrc).toBe(false);
  }, 15_000);

  it("installs release versions into immutable directories and performs atomic version switching", async () => {
    const toolEvolverHome = path.join(fakeHome, ".tool-evolver");

    // Create a mock release tarball for v1.0.0
    const mockV1Dir = path.join(tempTestDir, "mock-release-v1");
    fs.mkdirSync(path.join(mockV1Dir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(mockV1Dir, "bin", "tool-evolver-daemon"),
      "#!/usr/bin/env node\nconsole.log('daemon v1.0.0');\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(mockV1Dir, "bin", "tool-evolver-mcp"),
      "#!/usr/bin/env node\nconsole.log('mcp v1.0.0');\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(mockV1Dir, "bin", "tool-evolver"),
      "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
      { mode: 0o755 },
    );

    // Pack into .tar.gz buffer
    const v1Tar = createSimpleTarGz([
      {
        name: "bin/tool-evolver-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v1.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/tool-evolver-mcp",
        content: "#!/usr/bin/env node\nconsole.log('mcp v1.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/tool-evolver",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    // Install v1.0.0
    const install1 = await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      toolEvolverHome,
    });

    expect(install1.version).toBe("1.0.0");
    expect(fs.existsSync(install1.versionDir)).toBe(true);
    expect(fs.existsSync(path.join(install1.versionDir, "version.json"))).toBe(true);

    // Switch active version to v1.0.0
    const switch1 = await switchActiveVersion({
      toolEvolverHome,
      targetVersion: "1.0.0",
    });

    expect(switch1.activeVersion).toBe("1.0.0");
    expect(switch1.previousVersion).toBeNull();
    expect(getActiveVersion(toolEvolverHome)).toBe("1.0.0");

    // Global bin shims check
    const globalDaemonBin = path.join(toolEvolverHome, "bin", "tool-evolver-daemon");
    expect(fs.existsSync(globalDaemonBin)).toBe(true);

    // Create a mock release tarball for v1.1.0 (upgrade)
    const v2Tar = createSimpleTarGz([
      {
        name: "bin/tool-evolver-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v1.1.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/tool-evolver-mcp",
        content: "#!/usr/bin/env node\nconsole.log('mcp v1.1.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/tool-evolver",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.1.0');\n",
        mode: 0o755,
      },
    ]);

    // Install v1.1.0
    const install2 = await installReleaseVersion({
      version: "1.1.0",
      tarballPathOrBuffer: v2Tar,
      toolEvolverHome,
    });

    expect(install2.version).toBe("1.1.0");

    // Switch active version to v1.1.0
    const switch2 = await switchActiveVersion({
      toolEvolverHome,
      targetVersion: "1.1.0",
    });

    expect(switch2.activeVersion).toBe("1.1.0");
    expect(switch2.previousVersion).toBe("1.0.0");
    expect(switch2.rollbackRetained).toBe(true);
    expect(getActiveVersion(toolEvolverHome)).toBe("1.1.0");

    // Rollback to previous version v1.0.0
    const rollback = await rollbackActiveVersion({
      toolEvolverHome,
    });

    expect(rollback.restoredVersion).toBe("1.0.0");
    expect(getActiveVersion(toolEvolverHome)).toBe("1.0.0");
  });

  it("handles repeat install idempotently without corrupting installation or user config", async () => {
    const toolEvolverHome = path.join(fakeHome, ".tool-evolver");
    const v1Tar = createSimpleTarGz([
      {
        name: "bin/tool-evolver-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v1.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/tool-evolver-mcp",
        content: "#!/usr/bin/env node\nconsole.log('mcp v1.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/tool-evolver",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    // First install
    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      toolEvolverHome,
    });
    await switchActiveVersion({
      toolEvolverHome,
      targetVersion: "1.0.0",
    });

    // Write custom user config in data directory
    const customConfigDir = path.join(toolEvolverHome, "config");
    fs.mkdirSync(customConfigDir, { recursive: true });
    const userConfigPath = path.join(customConfigDir, "user-preferences.json");
    fs.writeFileSync(userConfigPath, JSON.stringify({ customKey: "customValue" }), "utf8");

    // Repeat install
    const repeatInstall = await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      toolEvolverHome,
    });

    expect(repeatInstall.version).toBe("1.0.0");
    expect(getActiveVersion(toolEvolverHome)).toBe("1.0.0");

    // User config must remain intact
    expect(fs.existsSync(userConfigPath)).toBe(true);
    const readConfig = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    expect(readConfig.customKey).toBe("customValue");
  });

  it("runs the full ToolEvolverInstaller in a disposable clean environment without workspace links", async () => {
    const workspace = path.join(tempTestDir, "isolated-workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const installer = new ToolEvolverInstaller({
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: fakeHome,
      workspace,
      dryRun: false,
      nonInteractive: true,
      autoApprove: true,
    });

    expect(summary.success).toBe(true);
    expect(summary.journal.status).toBe("completed");
    expect(summary.platform.isSupported).toBe(true);

    const stateJournalPath = path.join(fakeHome, ".tool-evolver", "state", "install-journal.json");
    expect(fs.existsSync(stateJournalPath)).toBe(true);
  });
});

/**
 * Helper to create a deterministic in-memory .tar.gz buffer.
 */
function createSimpleTarGz(files: Array<{ name: string; content: string; mode?: number }>): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    const contentBuf = Buffer.from(file.content, "utf8");
    const header = Buffer.alloc(512);

    // File name
    header.write(file.name, 0, 100, "utf8");
    // Mode (octal)
    const modeStr = (file.mode || 0o644).toString(8).padStart(7, "0");
    header.write(`${modeStr}\0`, 100, 8, "utf8");
    // UID & GID
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    // Size (octal)
    const sizeStr = contentBuf.length.toString(8).padStart(11, "0");
    header.write(`${sizeStr}\0`, 124, 12, "utf8");
    // Mtime (octal)
    header.write("14000000000\0", 136, 12, "utf8");
    // Type flag ('0' = file)
    header[156] = 48; // '0'
    // Magic
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");

    // Checksum
    let checksum = 0;
    // Fill checksum with spaces before calculating
    header.fill(32, 148, 156);
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    const chkStr = checksum.toString(8).padStart(6, "0");
    header.write(`${chkStr}\0 `, 148, 8, "utf8");

    blocks.push(header);
    blocks.push(contentBuf);

    // Padding to 512 bytes
    const padSize = (512 - (contentBuf.length % 512)) % 512;
    if (padSize > 0) {
      blocks.push(Buffer.alloc(padSize));
    }
  }

  // Two 512-byte zero blocks at EOF
  blocks.push(Buffer.alloc(1024));

  const tarBuffer = Buffer.concat(blocks);
  return zlib.gzipSync(tarBuffer);
}
