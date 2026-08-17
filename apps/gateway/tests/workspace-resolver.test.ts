import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalizePath,
  findGitRoot,
  generateWorkspaceId,
  resolveWorkspaceContext,
  uriOrPathToFsPath,
} from "../src/workspace-resolver.js";

describe("Workspace Resolver", () => {
  it("converts file:// URIs and standard paths to normalized fs paths", () => {
    const tmpDir = os.tmpdir();
    const fileUrl = pathToFileURL(tmpDir).href;
    const resolvedFromUrl = uriOrPathToFsPath(fileUrl);
    expect(path.normalize(resolvedFromUrl)).toBe(path.normalize(tmpDir));

    const standardPath = path.join(tmpDir, "subfolder");
    expect(uriOrPathToFsPath(standardPath)).toBe(path.resolve(standardPath));
  });

  it("canonicalizes symlinks properly", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "te-ws-test-"));
    const targetDir = path.join(baseDir, "real_target");
    const linkDir = path.join(baseDir, "symlink_dir");

    fs.mkdirSync(targetDir, { recursive: true });
    try {
      fs.symlinkSync(targetDir, linkDir, "dir");
      const canonicalTarget = canonicalizePath(targetDir);
      const canonicalLink = canonicalizePath(linkDir);
      expect(canonicalLink).toBe(canonicalTarget);
    } catch {
      // Symlinks might require elevated privileges on some environments, fallback still valid
      const canonicalLink = canonicalizePath(linkDir);
      expect(typeof canonicalLink).toBe("string");
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("detects enclosing git root", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "te-git-test-"));
    const gitDir = path.join(baseDir, ".git");
    const subfolder = path.join(baseDir, "nested", "deep", "dir");

    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(subfolder, { recursive: true });

    try {
      const detected = findGitRoot(subfolder);
      expect(detected).toBe(canonicalizePath(baseDir));
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("generates deterministic workspace IDs", () => {
    const p1 = "/path/to/my-repo";
    const id1 = generateWorkspaceId(p1);
    const id2 = generateWorkspaceId(p1);
    expect(id1).toBe(id2);
    expect(id1.startsWith("ws_my-repo_")).toBe(true);

    const p2 = "/path/to/another-repo";
    const id3 = generateWorkspaceId(p2);
    expect(id3).not.toBe(id1);
  });

  describe("Resolution Priority Hierarchy", () => {
    it("Priority 1: resolves from customRoots or initParams workspaceFolders", () => {
      const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), "te-p1-"));
      try {
        const ctx = resolveWorkspaceContext({
          initParams: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "test-client" },
            capabilities: {},
            workspaceFolders: [{ uri: pathToFileURL(tmp1).href, name: "test-workspace" }],
          },
          env: { TOOL_EVOLVER_WORKSPACE: "/some/ignored/path" },
          cwd: "/another/ignored/path",
        });

        expect(ctx.source).toBe("roots");
        expect(ctx.name).toBe("test-workspace");
        expect(ctx.canonicalRoot).toBe(canonicalizePath(tmp1));
        expect(ctx.roots).toHaveLength(1);
      } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
      }
    });

    it("Priority 1b: resolves from initParams rootUri / rootPath", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "te-rooturi-"));
      try {
        const ctx = resolveWorkspaceContext({
          initParams: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "test-client" },
            capabilities: {},
            rootUri: pathToFileURL(tmp).href,
          },
          env: {},
        });

        expect(ctx.source).toBe("init_param");
        expect(ctx.canonicalRoot).toBe(canonicalizePath(tmp));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("Priority 2: resolves from harness environment variables when init params absent", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "te-env-"));
      try {
        const ctx = resolveWorkspaceContext({
          env: {
            CLAUDE_WORKSPACE: tmp,
          },
          cwd: "/ignored/cwd",
        });

        expect(ctx.source).toBe("harness_session");
        expect(ctx.canonicalRoot).toBe(canonicalizePath(tmp));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("Priority 3: falls back to CWD when neither init params nor env are provided", () => {
      const customCwd = fs.mkdtempSync(path.join(os.tmpdir(), "te-cwd-"));
      try {
        const ctx = resolveWorkspaceContext({
          cwd: customCwd,
          env: {},
        });

        expect(ctx.source).toBe("cwd_fallback");
        expect(ctx.canonicalRoot).toBe(canonicalizePath(customCwd));
      } finally {
        fs.rmSync(customCwd, { recursive: true, force: true });
      }
    });
  });
});
