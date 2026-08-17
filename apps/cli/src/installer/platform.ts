import os from "node:os";
import process from "node:process";

/**
 * Supported target operating systems for Tool Evolver.
 */
export type SupportedPlatform = "linux" | "darwin" | "wsl";

export type PlatformType = SupportedPlatform | "win32" | "other";

/**
 * Detailed platform inspection result.
 */
export interface PlatformInfo {
  readonly os: SupportedPlatform;
  readonly isWsl: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly distro?: string;
  readonly isSupported: boolean;
  readonly rejectionReason?: string;
}

export interface DetectPlatformOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  release?: string;
  arch?: string;
  nodeVersion?: string;
}

/**
 * Custom error thrown when Tool Evolver is run on an unsupported platform (e.g. native Windows).
 */
export class UnsupportedPlatformError extends Error {
  readonly platform: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, platform: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
    this.details = details;
    Object.setPrototypeOf(this, UnsupportedPlatformError.prototype);
  }
}

/**
 * Detects whether the current runtime environment is WSL (Windows Subsystem for Linux).
 */
export function isWslEnvironment(
  env: Record<string, string | undefined> = process.env,
  release?: string,
): boolean {
  if (env.WSL_DISTRO_NAME || env.IS_WSL || env.WSLENV) {
    return true;
  }

  const kernelRelease = (
    release ?? (process.platform === "linux" ? os.release() : "")
  ).toLowerCase();
  if (kernelRelease.includes("microsoft") || kernelRelease.includes("wsl")) {
    return true;
  }

  return false;
}

/**
 * Detects the host platform and checks compatibility with Tool Evolver.
 */
export function detectPlatform(options: DetectPlatformOptions = {}): PlatformInfo {
  const targetPlatform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const arch = options.arch ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.version;
  const release = options.release;

  const wsl = targetPlatform === "linux" && isWslEnvironment(env, release);

  if (targetPlatform === "win32") {
    return {
      os: "wsl" as unknown as SupportedPlatform, // placeholder for typing
      isWsl: false,
      platform: "win32",
      arch,
      nodeVersion,
      isSupported: false,
      rejectionReason:
        "Native Windows is not supported. Tool Evolver requires Linux, macOS, or Windows Subsystem for Linux (WSL2). Please run inside WSL2.",
    };
  }

  if (targetPlatform === "darwin") {
    return {
      os: "darwin",
      isWsl: false,
      platform: "darwin",
      arch,
      nodeVersion,
      isSupported: true,
    };
  }

  if (targetPlatform === "linux") {
    const distro = env.WSL_DISTRO_NAME || (wsl ? "WSL" : "Linux");
    return {
      os: wsl ? "wsl" : "linux",
      isWsl: wsl,
      platform: "linux",
      arch,
      nodeVersion,
      distro,
      isSupported: true,
    };
  }

  return {
    os: targetPlatform as unknown as SupportedPlatform,
    isWsl: false,
    platform: targetPlatform,
    arch,
    nodeVersion,
    isSupported: false,
    rejectionReason: `Unsupported platform "${targetPlatform}". Tool Evolver supports Linux, macOS, and WSL.`,
  };
}

/**
 * Validates that the detected platform is supported; throws UnsupportedPlatformError if not.
 */
export function validatePlatform(info: PlatformInfo = detectPlatform()): PlatformInfo {
  if (!info.isSupported) {
    throw new UnsupportedPlatformError(
      info.rejectionReason ?? `Unsupported operating system: ${info.platform}`,
      info.platform,
      {
        arch: info.arch,
        nodeVersion: info.nodeVersion,
        isWsl: info.isWsl,
      },
    );
  }
  return info;
}
