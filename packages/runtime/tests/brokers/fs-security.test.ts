import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvocationGrant } from "../../src/policy/grant.js";
import {
  BrokerSecurityError,
  FilesystemBroker,
} from "../../src/brokers/index.js";

describe("Filesystem Broker Security & Containment", () => {
  let tempWorkspace: string;
  let outsideDir: string;
  let broker: FilesystemBroker;

  beforeAll(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs_broker_ws_"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs_broker_outside_"));
    fs.writeFileSync(path.join(outsideDir, "outside_secret.txt"), "TOP_SECRET_OUTSIDE");
    broker = new FilesystemBroker();
  });

  afterAll(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {}
  });

  const createGrant = (overrides: Record<string, unknown> = {}) => {
    return createInvocationGrant({
      grantId: "grant_fs_test",
      invocationId: "inv_fs_001",
      toolId: "fs_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_fs",
      envelopeId: "env_fs",
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: ["**/denied_dir/**", "**/.secret*"],
          maxFileSizeBytes: 1024 * 1024, // 1MB
          ...overrides,
        },
      },
    });
  };

  it("permits authorized read, write, and stat operations inside workspace root", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // 1. Write file
    const writeRes = await broker.writeFile(
      { path: "hello.txt", content: "Hello Broker Security!" },
      ctx
    );
    expect(writeRes.bytesWritten).toBeGreaterThan(0);

    // 2. Stat file
    const statRes = await broker.stat({ path: "hello.txt" }, ctx);
    expect(statRes.isFile).toBe(true);
    expect(statRes.size).toBe(Buffer.byteLength("Hello Broker Security!"));

    // 3. Read file
    const readRes = await broker.readFile({ path: "hello.txt" }, ctx);
    expect(readRes.content).toBe("Hello Broker Security!");

    // 4. Exists
    const existsRes = await broker.exists({ path: "hello.txt" }, ctx);
    expect(existsRes.exists).toBe(true);
  });

  it("blocks directory traversal attempts using '../' outside workspace", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const traversalPaths = [
      "../outside.txt",
      "../../../../etc/passwd",
      "subdir/../../../outside_secret.txt",
      "/etc/shadow",
    ];

    for (const badPath of traversalPaths) {
      await expect(
        broker.readFile({ path: badPath }, ctx)
      ).rejects.toThrow(BrokerSecurityError);

      try {
        await broker.readFile({ path: badPath }, ctx);
      } catch (err) {
        expect(["OUTSIDE_ALLOWED_ROOT", "PATH_TRAVERSAL", "HIDDEN_FILE_DENIED"]).toContain(
          (err as BrokerSecurityError).code
        );
      }
    }
  });

  it("blocks null bytes and path injection characters", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    const invalidPaths = [
      "test.txt\0.js",
      "test%00.txt",
      "test\x1f.txt",
    ];

    for (const badPath of invalidPaths) {
      await expect(
        broker.readFile({ path: badPath }, ctx)
      ).rejects.toThrow(BrokerSecurityError);
    }
  });

  it("detects and prevents symlink escape outside authorized workspace", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Create a symlink pointing to an outside secret file
    const symlinkPath = path.join(tempWorkspace, "malicious_symlink.txt");
    try {
      fs.symlinkSync(path.join(outsideDir, "outside_secret.txt"), symlinkPath);
    } catch {}

    // Reading through the symlink must be blocked
    await expect(
      broker.readFile({ path: "malicious_symlink.txt" }, ctx)
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.readFile({ path: "malicious_symlink.txt" }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("SYMLINK_ESCAPE");
    }
  });

  it("blocks sensitive hidden files (.git, .env, .ssh) by default", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Write a hidden file on disk directly
    fs.writeFileSync(path.join(tempWorkspace, ".env"), "API_KEY=secret123");

    await expect(
      broker.readFile({ path: ".env" }, ctx)
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.readFile({ path: ".env" }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("HIDDEN_FILE_DENIED");
    }
  });

  it("strictly enforces denyPaths precedence over allowed roots", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Create denied directory inside workspace
    const deniedSubdir = path.join(tempWorkspace, "denied_dir");
    fs.mkdirSync(deniedSubdir, { recursive: true });
    fs.writeFileSync(path.join(deniedSubdir, "data.txt"), "Denied Content");

    await expect(
      broker.readFile({ path: "denied_dir/data.txt" }, ctx)
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.readFile({ path: "denied_dir/data.txt" }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("PATH_DENIED");
    }
  });

  it("enforces maxFileSizeBytes limit on readFile and writeFile", async () => {
    const grant = createGrant({ maxFileSizeBytes: 100 }); // 100 bytes max
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // Write 200 bytes -> rejected
    await expect(
      broker.writeFile({ path: "oversized.txt", content: "X".repeat(200) }, ctx)
    ).rejects.toThrow(BrokerSecurityError);

    try {
      await broker.writeFile({ path: "oversized.txt", content: "X".repeat(200) }, ctx);
    } catch (err) {
      expect((err as BrokerSecurityError).code).toBe("MAX_FILE_SIZE_EXCEEDED");
    }

    // Write small file directly on disk (150 bytes) and try reading via broker -> rejected
    fs.writeFileSync(path.join(tempWorkspace, "large_on_disk.txt"), "Y".repeat(150));
    await expect(
      broker.readFile({ path: "large_on_disk.txt" }, ctx)
    ).rejects.toThrow(BrokerSecurityError);
  });

  it("supports atomic file writes without leaving corrupted temporary files", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    await broker.writeFile(
      { path: "atomic_target.txt", content: "Atomic payload", atomic: true },
      ctx
    );

    const readBack = await broker.readFile({ path: "atomic_target.txt" }, ctx);
    expect(readBack.content).toBe("Atomic payload");

    // Ensure no .tmp files linger in workspace
    const entries = fs.readdirSync(tempWorkspace);
    const tmpFiles = entries.filter((e) => e.includes(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  it("handles directory creation, listing, renaming, and deletion", async () => {
    const grant = createGrant();
    const ctx = {
      invocationId: "inv_fs_001",
      grant,
      workspaceRoot: tempWorkspace,
    };

    // 1. Create directory
    await broker.createDirectory({ path: "test_dir/nested", recursive: true }, ctx);

    // 2. Write file in nested dir
    await broker.writeFile({ path: "test_dir/nested/file.txt", content: "nested content" }, ctx);

    // 3. List directory
    const listRes = await broker.listDirectory({ path: "test_dir", recursive: true }, ctx);
    expect(listRes).toContain("nested");
    expect(listRes).toContain("nested/file.txt");

    // 4. Rename file
    await broker.rename(
      { oldPath: "test_dir/nested/file.txt", newPath: "test_dir/nested/renamed.txt" },
      ctx
    );
    const existsOld = await broker.exists({ path: "test_dir/nested/file.txt" }, ctx);
    const existsNew = await broker.exists({ path: "test_dir/nested/renamed.txt" }, ctx);
    expect(existsOld.exists).toBe(false);
    expect(existsNew.exists).toBe(true);

    // 5. Delete directory recursively
    await broker.delete({ path: "test_dir", recursive: true }, ctx);
    const existsDir = await broker.exists({ path: "test_dir" }, ctx);
    expect(existsDir.exists).toBe(false);
  });
});
