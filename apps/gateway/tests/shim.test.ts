import net from "node:net";
import os from "node:os";
import path from "node:path";
import stream from "node:stream";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/bin/mcp-shim.js";
import { McpStdioShim, checkDaemonReachable } from "../src/shim/stdio-bridge.js";

describe("Stdio Shim & Bridge Lifecycle", () => {
  it("parses CLI flags accurately", () => {
    const args1 = parseArgs(["--standalone", "--cwd", "/custom/dir", "--harness", "claude"]);
    expect(args1.standaloneFallback).toBe(true);
    expect(args1.cwd).toBe("/custom/dir");
    expect(args1.harnessId).toBe("claude");

    const args2 = parseArgs(["--no-standalone", "--socket", "/tmp/custom.sock"]);
    expect(args2.standaloneFallback).toBe(false);
    expect(args2.socketPath).toBe("/tmp/custom.sock");
  });

  it("detects absent daemon and starts in standalone mode by default", async () => {
    const nonExistentSocket = path.join(
      os.tmpdir(),
      `test-nonexistent-${Date.now()}.sock`
    );

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();

    const shim = new McpStdioShim({
      socketPath: nonExistentSocket,
      standaloneFallback: true,
      maxStartupAttempts: 0,
      stdin,
      stdout,
      stderr,
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("standalone_inprocess");
      expect(status.daemonReachable).toBe(false);
    } finally {
      await shim.stop();
    }
  });

  it("reports actionable error when daemon is absent and standalone fallback disabled", async () => {
    const nonExistentSocket = path.join(
      os.tmpdir(),
      `test-absent-${Date.now()}.sock`
    );

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    let stderrOutput = "";
    const stderr = new stream.Writable({
      write(chunk, _enc, cb) {
        stderrOutput += chunk.toString("utf8");
        cb();
      },
    });

    const shim = new McpStdioShim({
      socketPath: nonExistentSocket,
      standaloneFallback: false,
      maxStartupAttempts: 0,
      stdin,
      stdout,
      stderr,
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("failed");
      expect(status.daemonReachable).toBe(false);
      expect(stderrOutput).toContain("tool-evolver daemon start");
      expect(stderrOutput).toContain("--standalone");
    } finally {
      await shim.stop();
    }
  });

  it("bridges to daemon socket when daemon is active", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `test-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
    );

    // Mock daemon server
    const server = net.createServer((sock) => {
      sock.on("data", (data) => {
        // Echo back
        sock.write(data);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => resolve());
    });

    const isReachable = await checkDaemonReachable(socketPath, 500);
    expect(isReachable).toBe(true);

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();

    const shim = new McpStdioShim({
      socketPath,
      standaloneFallback: false,
      stdin,
      stdout,
      stderr,
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("daemon_ipc");
      expect(status.daemonReachable).toBe(true);
    } finally {
      await shim.stop();
      server.close();
    }
  });
});
