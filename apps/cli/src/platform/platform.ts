import os from "node:os";
import process from "node:process";

/**
 * Supported target operating systems for Tool Evolver.
 */
export type SupportedPlatform = "linux" | "darwin" | "wsl";

export type PlatformType = SupportedPlatform | "win32" | "other";

/**
 * Supported hardware architectures.
 */
export type SupportedArch = "x64" | "arm64";

/**
 * Official Release Qualification Lanes for platform matrix validation.
 */
export type PlatformQualificationLane =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "wsl-systemd"
  | "wsl-fallback";

export const ALL_QUALIFICATION_LANES: readonly PlatformQualificationLane[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "wsl-systemd",
  "wsl-fallback",
] as const;

/**
 * Detailed platform inspection result.
 */
export interface PlatformInfo {
  readonly os: SupportedPlatform;
  readonly isSupported: boolean;
  readonly rejectionReason?: string;
  readonly isWsl: boolean;
  readonly wslVersion?: number;
  readonly wslDistro?: string;
  readonly hasSystemd?: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly distro?: string;
  readonly isAppleSilicon?: boolean;
  readonly isRosetta?: boolean;
  readonly lane?: PlatformQualificationLane;
}
/**
 * Custom error thrown when the host platform is unsupported.
 */
export class UnsupportedPlatformError extends Error {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly isWsl: boolean;

  constructor(
    platform: NodeJS.Platform,
    details?: { arch?: string; nodeVersion?: string; isWsl?: boolean },
  ) {
    const message =
      platform === "win32"
        ? "Native Windows is not supported. Please run within Windows Subsystem for Linux (WSL2): `wsl --install`."
        : `Unsupported platform: ${String(platform)}. Tool Evolver requires Linux (x64/arm64), macOS (Apple Silicon/Intel), or WSL2.`;
    super(message);
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
    this.arch = details?.arch ?? process.arch;
    this.nodeVersion = details?.nodeVersion ?? process.version;
    this.isWsl = details?.isWsl ?? false;
  }
}

/**
 * Detects whether the current runtime environment is WSL (Windows Subsystem for Linux).
 */
export function isWslEnvironment(
  env: Record<string, string | undefined> = process.env,
  release?: string,
): boolean {
  if (env.WSL_DISTRO_NAME || env.IS_WSL || env.WSLENV || env.WSL_INTEROP) {
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
 * Checks if the system is running on Apple Silicon (arm64 Darwin).
 */
export function isAppleSilicon(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (platform !== "darwin") {
    return false;
  }
  if (arch === "arm64") {
    return true;
  }
  // Check for Rosetta translation
  if (env.ROSETTA_VERSION || env.TRANSLATED_PROCESS === "1") {
    return true;
  }
  return false;
}

/**
 * Determines the qualification lane for a given platform info.
 */
export function getQualificationLane(info: PlatformInfo): PlatformQualificationLane {
  if (info.isWsl) {
    return info.hasSystemd ? "wsl-systemd" : "wsl-fallback";
  }
  if (info.os === "darwin") {
    return info.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (info.os === "linux") {
    return info.arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  // Default to linux-x64
  return "linux-x64";
}

/**
 * Gets a human-readable display name for a platform lane or platform info.
 */
export function getPlatformDisplayName(
  laneOrInfo: PlatformQualificationLane | PlatformInfo,
): string {
  const lane = typeof laneOrInfo === "string" ? laneOrInfo : getQualificationLane(laneOrInfo);
  switch (lane) {
    case "linux-x64":
      return "Linux x86_64 (glibc / musl)";
    case "linux-arm64":
      return "Linux aarch64 (ARM64)";
    case "darwin-x64":
      return "macOS Intel (x86_64)";
    case "darwin-arm64":
      return "macOS Apple Silicon (ARM64 M1/M2/M3/M4)";
    case "wsl-systemd":
      return "WSL2 (systemd enabled)";
    case "wsl-fallback":
      return "WSL2 (supervisor fallback mode)";
    default:
      return String(lane);
  }
}

/**
 * Detects the runtime platform and architecture with optional overrides for testing.
 */
export function detectPlatform(
  options: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    release?: string;
    arch?: string;
    nodeVersion?: string;
    isWslOverride?: boolean;
    hasSystemdOverride?: boolean;
  } = {},
): PlatformInfo {
  const targetPlatform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const arch = options.arch ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.version;
  const release = options.release ?? (targetPlatform === "linux" ? os.release() : "");

  const isWsl =
    options.isWslOverride ?? (targetPlatform === "linux" && isWslEnvironment(env, release));
  const appleSilicon = targetPlatform === "darwin" && isAppleSilicon(targetPlatform, arch, env);

  let wslDistro: string | undefined;
  let wslVersion: number | undefined;
  let hasSystemd: boolean | undefined;

  if (isWsl) {
    wslDistro = env.WSL_DISTRO_NAME ?? "Ubuntu";
    wslVersion = 2; // Modern WSL2 standard
    hasSystemd =
      options.hasSystemdOverride ??
      (env.WSL_SYSTEMD === "1" || env.SYSTEMD_ENABLED === "1" || Boolean(env.INVOCATION_ID));
  }

  let osType: SupportedPlatform = "linux";
  if (isWsl) {
    osType = "wsl";
  } else if (targetPlatform === "darwin") {
    osType = "darwin";
  } else if (targetPlatform === "linux") {
    osType = "linux";
  }

  let distro: string | undefined;
  if (isWsl) {
    distro = wslDistro ?? "linux-wsl";
  } else if (targetPlatform === "linux") {
    distro = env.ID ?? env.DISTRIB_ID ?? "linux-generic";
  } else if (targetPlatform === "darwin") {
    distro = "macOS";
  }

  const isSupported = targetPlatform === "linux" || targetPlatform === "darwin";
  let rejectionReason: string | undefined;
  if (!isSupported) {
    if (targetPlatform === "win32") {
      rejectionReason =
        "Native Windows is not supported. Please run Tool Evolver inside WSL2 (Windows Subsystem for Linux): `wsl --install`.";
    } else {
      rejectionReason = `Operating system '${targetPlatform}' is not supported. Tool Evolver requires Linux (x64/arm64), macOS (Apple Silicon/Intel), or WSL2.`;
    }
  }

  const info: PlatformInfo = {
    os: osType,
    isSupported,
    rejectionReason,
    isWsl,
    wslVersion,
    wslDistro,
    hasSystemd,
    platform: targetPlatform,
    arch,
    nodeVersion,
    distro,
    isAppleSilicon: appleSilicon,
    isRosetta: targetPlatform === "darwin" && arch === "x64" && Boolean(env.ROSETTA_VERSION),
  };

  const lane = getQualificationLane(info);
  return {
    ...info,
    lane,
  };
}

/**
 * Validates that the detected or supplied platform is supported.
 * Throws UnsupportedPlatformError if unsupported.
 */
export function validatePlatform(platformOrInfo?: NodeJS.Platform | PlatformInfo): PlatformInfo {
  let info: PlatformInfo;
  if (typeof platformOrInfo === "object" && platformOrInfo !== null) {
    info = platformOrInfo;
  } else {
    info = detectPlatform({ platform: platformOrInfo });
  }

  if (info.platform === "win32") {
    throw new UnsupportedPlatformError("win32", {
      arch: info.arch,
      nodeVersion: info.nodeVersion,
      isWsl: false,
    });
  }

  if (info.platform !== "linux" && info.platform !== "darwin") {
    throw new UnsupportedPlatformError(info.platform, {
      arch: info.arch,
      nodeVersion: info.nodeVersion,
      isWsl: info.isWsl,
    });
  }

  return info;
}
