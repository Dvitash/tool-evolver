import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_QUALIFICATION_LANES,
  type PlatformInfo,
  type PlatformQualificationLane,
  UnsupportedPlatformError,
  canonicalizePlatformPath,
  detectPlatform,
  getPlatformDisplayName,
  getQualificationLane,
  isAppleSilicon,
  isWslEnvironment,
  isWslHostDrivePath,
  resolvePlatformPaths,
  resolveWindowsHostPath,
  resolveWslToWindowsPath,
  validatePlatform,
} from "../../src/platform/index.js";

describe("Platform Matrix Qualification Suite", () => {
  describe("Qualification Lanes Detection & Classification", () => {
    it("recognizes all 6 required qualification lanes", () => {
      expect(ALL_QUALIFICATION_LANES).toEqual([
        "linux-x64",
        "linux-arm64",
        "darwin-x64",
        "darwin-arm64",
        "wsl-systemd",
        "wsl-fallback",
      ]);
      expect(ALL_QUALIFICATION_LANES).toHaveLength(6);
    });

    it("correctly identifies Linux x64 lane", () => {
      const info = detectPlatform({
        platform: "linux",
        arch: "x64",
        env: { WSL_DISTRO_NAME: undefined },
        release: "6.8.0-generic",
      });

      expect(info.os).toBe("linux");
      expect(info.arch).toBe("x64");
      expect(info.isWsl).toBe(false);
      expect(getQualificationLane(info)).toBe("linux-x64");
      expect(getPlatformDisplayName(info)).toContain("Linux x86_64");
    });

    it("correctly identifies Linux arm64 lane", () => {
      const info = detectPlatform({
        platform: "linux",
        arch: "arm64",
        env: { WSL_DISTRO_NAME: undefined },
        release: "6.8.0-generic",
      });

      expect(info.os).toBe("linux");
      expect(info.arch).toBe("arm64");
      expect(info.isWsl).toBe(false);
      expect(getQualificationLane(info)).toBe("linux-arm64");
      expect(getPlatformDisplayName(info)).toContain("Linux aarch64");
    });

    it("correctly identifies macOS Intel (darwin-x64) lane", () => {
      const info = detectPlatform({
        platform: "darwin",
        arch: "x64",
        env: {},
      });

      expect(info.os).toBe("darwin");
      expect(info.arch).toBe("x64");
      expect(info.isAppleSilicon).toBe(false);
      expect(getQualificationLane(info)).toBe("darwin-x64");
      expect(getPlatformDisplayName(info)).toContain("macOS Intel");
    });

    it("correctly identifies macOS Apple Silicon (darwin-arm64) lane", () => {
      const info = detectPlatform({
        platform: "darwin",
        arch: "arm64",
        env: {},
      });

      expect(info.os).toBe("darwin");
      expect(info.arch).toBe("arm64");
      expect(info.isAppleSilicon).toBe(true);
      expect(getQualificationLane(info)).toBe("darwin-arm64");
      expect(getPlatformDisplayName(info)).toContain("macOS Apple Silicon");
    });

    it("correctly identifies WSL with systemd enabled lane", () => {
      const info = detectPlatform({
        platform: "linux",
        arch: "x64",
        env: {
          WSL_DISTRO_NAME: "Ubuntu-24.04",
          WSL_SYSTEMD: "1",
        },
        release: "5.15.153.1-microsoft-standard-WSL2",
      });

      expect(info.os).toBe("wsl");
      expect(info.isWsl).toBe(true);
      expect(info.hasSystemd).toBe(true);
      expect(getQualificationLane(info)).toBe("wsl-systemd");
      expect(getPlatformDisplayName(info)).toContain("systemd enabled");
    });

    it("correctly identifies WSL with fallback supervisor lane", () => {
      const info = detectPlatform({
        platform: "linux",
        arch: "x64",
        env: {
          WSL_DISTRO_NAME: "Debian",
          WSL_SYSTEMD: "0",
        },
        release: "5.15.153.1-microsoft-standard-WSL2",
        hasSystemdOverride: false,
      });

      expect(info.os).toBe("wsl");
      expect(info.isWsl).toBe(true);
      expect(info.hasSystemd).toBe(false);
      expect(getQualificationLane(info)).toBe("wsl-fallback");
      expect(getPlatformDisplayName(info)).toContain("fallback mode");
    });
  });

  describe("Platform Path Resolution & Standards Compliance", () => {
    it("resolves macOS standard Library and Application Support paths", () => {
      const customHome = "/Users/testuser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "darwin",
          isWsl: false,
          platform: "darwin",
          arch: "arm64",
          nodeVersion: "v22.0.0",
        },
      });

      expect(paths.configDir).toBe("/Users/testuser/Library/Application Support/ToolEvolver");
      expect(paths.dataDir).toBe("/Users/testuser/Library/Application Support/ToolEvolver");
      expect(paths.stateDir).toBe("/Users/testuser/Library/Caches/tool-evolver");
      expect(paths.logDir).toBe("/Users/testuser/Library/Logs/tool-evolver");
      expect(paths.socketPath).toBe("/Users/testuser/Library/Caches/tool-evolver/daemon.sock");
      expect(paths.homeDir).toBe("/Users/testuser/.tool-evolver");
    });

    it("resolves Linux XDG Base Directory Specification paths", () => {
      const customHome = "/home/testuser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "linux",
          isWsl: false,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
        env: {
          XDG_CONFIG_HOME: "/home/testuser/.custom-config",
          XDG_DATA_HOME: "/home/testuser/.custom-share",
          XDG_STATE_HOME: "/home/testuser/.custom-state",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
      });

      expect(paths.configDir).toBe("/home/testuser/.custom-config/tool-evolver");
      expect(paths.dataDir).toBe("/home/testuser/.custom-share/tool-evolver");
      expect(paths.stateDir).toBe("/home/testuser/.custom-state/tool-evolver");
      expect(paths.logDir).toBe("/home/testuser/.custom-state/tool-evolver/logs");
      expect(paths.socketPath).toBe("/run/user/1000/tool-evolver.sock");
    });

    it("resolves Linux default paths when XDG environment variables are unset", () => {
      const customHome = "/home/testuser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "linux",
          isWsl: false,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
        env: {},
      });

      expect(paths.configDir).toBe("/home/testuser/.config/tool-evolver");
      expect(paths.dataDir).toBe("/home/testuser/.local/share/tool-evolver");
      expect(paths.stateDir).toBe("/home/testuser/.local/state/tool-evolver");
      expect(paths.logDir).toBe("/home/testuser/.local/state/tool-evolver/logs");
      expect(paths.socketPath).toBe("/home/testuser/.local/state/tool-evolver/daemon.sock");
    });

    it("resolves WSL paths with Windows host interop paths", () => {
      const customHome = "/home/wsluser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "wsl",
          isWsl: true,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
        env: {
          USER: "WindowsUser",
        },
      });

      expect(paths.wslHostConfig).toBeDefined();
      expect(paths.wslHostConfig?.windowsAppDataDir).toBe(
        "/mnt/c/Users/WindowsUser/AppData/Roaming/ToolEvolver",
      );
      expect(paths.wslHostConfig?.windowsLocalAppDataDir).toBe(
        "/mnt/c/Users/WindowsUser/AppData/Local/ToolEvolver",
      );
      expect(paths.wslHostConfig?.windowsUserHome).toBe("/mnt/c/Users/WindowsUser");
    });
  });

  describe("WSL & Windows Host Path Conversions", () => {
    it("converts Windows drive paths to WSL mount paths", () => {
      expect(resolveWindowsHostPath("C:\\Users\\Alice\\code")).toBe("/mnt/c/Users/Alice/code");
      expect(resolveWindowsHostPath("D:/Projects/app")).toBe("/mnt/d/Projects/app");
      expect(resolveWindowsHostPath("C:\\")).toBe("/mnt/c");
      expect(resolveWindowsHostPath("C:")).toBe("/mnt/c");
    });

    it("converts WSL mount paths to Windows drive paths", () => {
      expect(resolveWslToWindowsPath("/mnt/c/Users/Alice/code")).toBe("C:/Users/Alice/code");
      expect(resolveWslToWindowsPath("/mnt/d/Projects/app")).toBe("D:/Projects/app");
      expect(resolveWslToWindowsPath("/mnt/c")).toBe("C:");
    });

    it("accurately detects WSL host drive paths", () => {
      expect(isWslHostDrivePath("/mnt/c/Users/Bob")).toBe(true);
      expect(isWslHostDrivePath("/mnt/d/data")).toBe(true);
      expect(isWslHostDrivePath("/home/user/code")).toBe(false);
      expect(isWslHostDrivePath("/var/log")).toBe(false);
    });
  });

  describe("Path Canonicalization & Security Traversal Checks", () => {
    it("canonicalizes relative paths and verifies traversal safety", () => {
      const res = canonicalizePlatformPath("src/platform/paths.ts", { cwd: "/app" });
      expect(res.canonicalPath).toBe("/app/src/platform/paths.ts");
      expect(res.isTraversalSafe).toBe(true);
      expect(res.isWindowsDrive).toBe(false);
    });

    it("canonicalizes Windows paths in WSL format", () => {
      const res = canonicalizePlatformPath("C:\\Users\\Alice\\project", { cwd: "/app" });
      expect(res.canonicalPath).toBe("/mnt/c/Users/Alice/project");
      expect(res.isWindowsDrive).toBe(true);
      expect(res.isTraversalSafe).toBe(true);
    });

    it("rejects paths with null bytes as security violations", () => {
      expect(() => {
        canonicalizePlatformPath("/safe/path\0/malicious", { cwd: "/app" });
      }).toThrow(/null byte detected/i);
    });

    it("rejects empty paths", () => {
      expect(() => {
        canonicalizePlatformPath("", { cwd: "/app" });
      }).toThrow(/Cannot canonicalize empty path/i);
    });
  });

  describe("Platform Validation & Error Handling", () => {
    it("accepts valid Linux platforms", () => {
      const info = validatePlatform(
        detectPlatform({ platform: "linux", release: "6.8.0-generic" }),
      );
      expect(info.os).toBe("linux");
    });

    it("accepts valid macOS platforms", () => {
      const info = validatePlatform(detectPlatform({ platform: "darwin", arch: "arm64" }));
      expect(info.os).toBe("darwin");
    });

    it("rejects native Windows with actionable WSL2 guidance", () => {
      expect(() => {
        validatePlatform(detectPlatform({ platform: "win32" }));
      }).toThrow(UnsupportedPlatformError);

      try {
        validatePlatform(detectPlatform({ platform: "win32" }));
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedPlatformError);
        expect((err as UnsupportedPlatformError).message).toContain("wsl --install");
        expect((err as UnsupportedPlatformError).platform).toBe("win32");
      }
    });

    it("rejects unsupported OSes such as AIX or FreeBSD", () => {
      expect(() => {
        validatePlatform(detectPlatform({ platform: "aix" as NodeJS.Platform }));
      }).toThrow(UnsupportedPlatformError);

      expect(() => {
        validatePlatform(detectPlatform({ platform: "freebsd" as NodeJS.Platform }));
      }).toThrow(UnsupportedPlatformError);
    });
  });
});
