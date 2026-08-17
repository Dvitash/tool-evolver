import { InMemoryConfigFsBridge } from "@tool-evolver/harness-contracts";
import { describe, expect, it } from "vitest";
import { main } from "../src/bin/cli.js";
import { initCommand, parseInitFlags } from "../src/commands/init.js";
import { InstallationError, ToolEvolverInstaller } from "../src/installer/installer.js";

describe("Tool Evolver Installer End-to-End & CLI Command Suite", () => {
  it("parses CLI flags accurately", () => {
    const flags = parseInitFlags([
      "--dry-run",
      "--json",
      "--non-interactive",
      "--auto-approve",
      "--harness=claude-code,omp",
      "--workspace=/custom/workspace",
      "--capabilities-file=/caps.json",
      "--privacy-config=/privacy.json",
      "--gateway-url=http://127.0.0.1:9400/mcp/sse",
      "--home=/custom/home",
    ]);

    expect(flags.dryRun).toBe(true);
    expect(flags.json).toBe(true);
    expect(flags.nonInteractive).toBe(true);
    expect(flags.autoApprove).toBe(true);
    expect(flags.harness).toBe("claude-code,omp");
    expect(flags.workspace).toBe("/custom/workspace");
    expect(flags.capabilitiesFile).toBe("/caps.json");
    expect(flags.privacyConfig).toBe("/privacy.json");
    expect(flags.gatewayUrl).toBe("http://127.0.0.1:9400/mcp/sse");
    expect(flags.home).toBe("/custom/home");
  });

  it("executes full end-to-end init workflow with autoApprove", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const logs: string[] = [];

    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    const installer = new ToolEvolverInstaller({
      fsBridge: bridge,
      logger: (msg) => logs.push(msg),
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
    });

    expect(summary.success).toBe(true);
    expect(summary.dryRun).toBe(false);
    expect(summary.journal.status).toBe("completed");
    expect(summary.journal.steps.every((s) => s.status === "completed")).toBe(true);
    expect(summary.harnesses).toHaveLength(3);

    // Verify journal file was persisted in state directory
    const journalSaved = await bridge.readFile(`${home}/.tool-evolver/state/install-journal.json`);
    expect(journalSaved).not.toBeNull();
    const parsedJournal = JSON.parse(journalSaved ?? "{}");
    expect(parsedJournal.status).toBe("completed");

    // Verify Claude, Codex, OMP configs were written
    expect(await bridge.readFile(`${home}/.claude/claude.json`)).toContain("tool-evolver");
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toContain("tool_evolver_gateway");
    expect(await bridge.readFile(`${home}/.omp/config.json`)).toContain("tool-evolver-gateway");
  });

  it("runs dry-run mode without modifying filesystem", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    const installer = new ToolEvolverInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      dryRun: true,
      nonInteractive: true,
    });

    expect(summary.success).toBe(true);
    expect(summary.dryRun).toBe(true);
    expect(summary.journal.status).toBe("completed");

    // Verify no files/directories were created on disk
    expect(await bridge.readFile(`${home}/.tool-evolver/state/install-journal.json`)).toBeNull();
    expect(await bridge.readFile(`${home}/.claude/claude.json`)).toBeNull();
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toBeNull();
    expect(await bridge.readFile(`${home}/.omp/config.json`)).toBeNull();
  });

  it("enforces idempotency on repeated init runs", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    const installer = new ToolEvolverInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    // Run 1
    const run1 = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
    });
    expect(run1.success).toBe(true);
    expect(run1.harnesses.every((h) => !h.wasAlreadyConfigured)).toBe(true);

    // Run 2 (idempotent)
    const installer2 = new ToolEvolverInstaller({
      fsBridge: bridge,
      logger: () => {},
    });
    const run2 = await installer2.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
    });
    expect(run2.success).toBe(true);
    expect(run2.harnesses.every((h) => h.wasAlreadyConfigured)).toBe(true);
  });

  it("rolls back all applied configurations atomically upon failure injection", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    // Pre-create original config files
    await bridge.writeFile(`${home}/.claude/claude.json`, '{"original": "claude"}');
    await bridge.writeFile(`${home}/.codex/config.toml`, "# original codex\n");

    const installer = new ToolEvolverInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    // Non-interactive without autoApprove or capabilitiesFile should fail during authorization
    await expect(
      installer.run({
        customHome: home,
        workspace,
        nonInteractive: true,
      }),
    ).rejects.toThrow(InstallationError);

    // Original files must remain intact
    expect(await bridge.readFile(`${home}/.claude/claude.json`)).toBe('{"original": "claude"}');
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toBe("# original codex\n");
  });

  it("handles initCommand CLI wrapper with --json and --dry-run", async () => {
    const bridge = new InMemoryConfigFsBridge();

    const exitCode = await initCommand(
      [
        "--dry-run",
        "--json",
        "--non-interactive",
        "--auto-approve",
        "--home=/home/testuser",
        "--workspace=/workspace/test",
      ],
      bridge,
    );

    expect(exitCode).toBe(0);
  });

  it("handles CLI router for version and help", async () => {
    const versionExit = await main(["version"]);
    expect(versionExit).toBe(0);

    const helpExit = await main(["help"]);
    expect(helpExit).toBe(0);

    const unknownExit = await main(["unknown-command"]);
    expect(unknownExit).toBe(1);
  });
});
