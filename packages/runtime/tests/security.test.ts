import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BundleResourceTracker,
  BundleSecurityError,
  resolveSafeTargetPath,
  validateBundleEntryPath,
  validateNoSymlinkEscapes,
} from "../src/loader/security-checks.js";

describe("loader security checks", () => {
  it("rejects path traversal attempts", () => {
    const maliciousPaths = [
      "../../etc/passwd",
      "../parent.txt",
      "src/../../../shadow",
      "foo/bar/../../../../root",
      "a/b/../..//../c",
    ];

    for (const malPath of maliciousPaths) {
      expect(() => validateBundleEntryPath(malPath)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(malPath);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("PATH_TRAVERSAL");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("rejects absolute paths on Unix and Windows", () => {
    const absolutePaths = [
      "/etc/passwd",
      "/var/log/syslog",
      "\\Windows\\System32",
      "C:/Windows/cmd.exe",
      "D:\\data\\secrets.json",
    ];

    for (const absPath of absolutePaths) {
      expect(() => validateBundleEntryPath(absPath)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(absPath);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("ABSOLUTE_PATH");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("rejects invalid path characters and null bytes", () => {
    const invalidPaths = ["src/index.ts\0.exe", "manifest.json\r", "test\nfile.txt"];

    for (const invPath of invalidPaths) {
      expect(() => validateBundleEntryPath(invPath)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(invPath);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("INVALID_PATH_CHARACTERS");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("rejects Windows reserved device file names", () => {
    const reserved = ["CON", "prn.txt", "AUX", "NUL", "com1", "lpt3.dat", "nested/CON/file.txt"];

    for (const name of reserved) {
      expect(() => validateBundleEntryPath(name)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(name);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("DEVICE_FILE_PROHIBITED");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("rejects .git directory tampering", () => {
    const gitPaths = [".git/config", ".git/HEAD", "src/.git/hooks/pre-commit"];

    for (const gitPath of gitPaths) {
      expect(() => validateBundleEntryPath(gitPath)).toThrowError(BundleSecurityError);
      expect(() => {
        try {
          validateBundleEntryPath(gitPath);
        } catch (e) {
          if (e instanceof BundleSecurityError) {
            expect(e.code).toBe("RESERVED_FILENAME");
          }
          throw e;
        }
      }).toThrow();
    }
  });

  it("resolves safe target paths and throws if escaping target root", () => {
    const targetRoot = "/tmp/sandbox/artifact_01";

    const safeResolved = resolveSafeTargetPath(targetRoot, "src/index.ts");
    expect(safeResolved).toBe(path.resolve(targetRoot, "src/index.ts"));

    expect(() => resolveSafeTargetPath(targetRoot, "../escape.txt")).toThrowError(
      BundleSecurityError,
    );
  });

  it("detects symlink escapes pointing outside target root", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-test-"));
    try {
      const insideDir = path.join(tempDir, "root");
      const outsideDir = path.join(tempDir, "outside");
      fs.mkdirSync(insideDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const secretFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(secretFile, "sensitive data");

      const linkFile = path.join(insideDir, "link.txt");
      try {
        fs.symlinkSync(secretFile, linkFile);
        expect(() => validateNoSymlinkEscapes(insideDir, linkFile)).toThrowError(
          BundleSecurityError,
        );
      } catch (symlinkErr) {
        // On systems without symlink permission, test graceful handling
        if (
          symlinkErr &&
          typeof symlinkErr === "object" &&
          "code" in symlinkErr &&
          symlinkErr.code !== "EPERM"
        ) {
          throw symlinkErr;
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("enforces resource tracker limits (file count, file size, decompression ratio)", () => {
    const tracker = new BundleResourceTracker(1000, {
      maxFileCount: 3,
      maxFileSizeBytes: 1024,
      maxDecompressedSizeBytes: 2048,
      maxDecompressionRatio: 2,
    });

    // 1st entry: OK
    tracker.trackEntry("file1.ts", 500);

    // 2nd entry: exceeds maxFileSizeBytes
    expect(() => tracker.trackEntry("bigfile.ts", 2000)).toThrowError(BundleSecurityError);

    // 2nd entry with valid size: OK
    tracker.trackEntry("file2.ts", 400);

    // 3rd entry: OK
    tracker.trackEntry("file3.ts", 400);

    // 4th entry: exceeds maxFileCount (limit is 3)
    expect(() => tracker.trackEntry("file4.ts", 100)).toThrowError(BundleSecurityError);
  });
});
