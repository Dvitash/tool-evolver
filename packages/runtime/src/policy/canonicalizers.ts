import os from "node:os";
import path from "node:path";
import type {
  CommandCapability,
  FsCapability,
  NetCapability,
  SecretCapability,
} from "@tool-evolver/contracts";

/**
 * Standard Error code types for canonicalization rejections.
 */
export type CanonicalizationErrorCode =
  | "PATH_TRAVERSAL"
  | "PARENT_WIDENING"
  | "INVALID_PATH_CHARACTERS"
  | "EMPTY_PATH"
  | "INVALID_HOST"
  | "INVALID_SCHEME"
  | "INVALID_PORT"
  | "PRIVATE_IP_BLOCKED"
  | "SHELL_EXECUTION_DENIED"
  | "SHELL_METACHARACTERS_DETECTED"
  | "DANGEROUS_ENV_VAR"
  | "INVALID_SECRET_NAME"
  | "INVALID_SECRET_PREFIX"
  | "WORKING_DIR_OUTSIDE_ROOT";

export class PolicyCanonicalizationError extends Error {
  readonly code: CanonicalizationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CanonicalizationErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "PolicyCanonicalizationError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// =============================================================================
// Filesystem Canonicalizer
// =============================================================================

export interface FsCanonicalizeOptions {
  allowTemp?: boolean;
  tempDir?: string;
  allowGlob?: boolean;
}

/**
 * Normalizes all path separators to POSIX standard forward-slashes.
 */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\+/g, "/");
}

/**
 * Checks whether a target path is strictly contained within a given root directory.
 */
export function isPathInsideRoot(targetPath: string, rootDir: string): boolean {
  const normTarget = normalizeSlashes(path.resolve(rootDir, targetPath));
  const normRoot = normalizeSlashes(path.resolve(rootDir));

  if (normTarget === normRoot) {
    return true;
  }

  const rootPrefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  return normTarget.startsWith(rootPrefix);
}

/**
 * Replaces <WORKSPACE_ROOT> placeholder with the actual workspace root path.
 */
export function expandWorkspacePlaceholder(rawPath: string, workspaceRoot: string): string {
  const normRoot = normalizeSlashes(path.resolve(workspaceRoot));
  return rawPath.replace(/<WORKSPACE_ROOT>/g, normRoot);
}

/**
 * Checks for invalid characters (null bytes, control characters, unprintable chars).
 */
export function validatePathCharacters(rawPath: string): void {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new PolicyCanonicalizationError("EMPTY_PATH", "Path must be a non-empty string");
  }

  // Null bytes or control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(rawPath)) {
    throw new PolicyCanonicalizationError(
      "INVALID_PATH_CHARACTERS",
      `Path contains null or control characters: ${JSON.stringify(rawPath)}`,
      { rawPath },
    );
  }

  // Encoded null bytes or traversal tricks
  if (/%00|%2e%2e|\.\.%2f|\.\.%5c/i.test(rawPath)) {
    throw new PolicyCanonicalizationError(
      "PATH_TRAVERSAL",
      `Path contains encoded traversal sequences: ${rawPath}`,
      { rawPath },
    );
  }
}

/**
 * Canonicalizes a filesystem path against the workspace root.
 * Enforces:
 * 1. Unicode NFC normalization.
 * 2. Path traversal rejection (`..` climbing above root).
 * 3. Prevention of parent widening.
 * 4. Resolving relative paths against workspaceRoot.
 * 5. Allowing temp directory only if explicit allowTemp is enabled.
 */
export function canonicalizePath(
  rawPath: string,
  workspaceRoot: string,
  options: FsCanonicalizeOptions = {},
): string {
  validatePathCharacters(rawPath);

  const normalizedUnicode = rawPath.normalize("NFC");
  const expanded = expandWorkspacePlaceholder(normalizedUnicode, workspaceRoot);
  const normalizedSlashes = normalizeSlashes(expanded);

  const normWorkspaceRoot = normalizeSlashes(path.resolve(workspaceRoot));
  const effectiveTempDir = normalizeSlashes(path.resolve(options.tempDir ?? os.tmpdir()));

  // If the path is a glob pattern containing wildcards (* or ?)
  const isGlob = options.allowGlob && /[*?]/.test(normalizedSlashes);

  if (isGlob) {
    // For glob patterns, check the non-glob prefix directory
    const parts = normalizedSlashes.split("/");
    const nonGlobParts: string[] = [];
    for (const part of parts) {
      if (/[*?]/.test(part)) break;
      nonGlobParts.push(part);
    }
    const baseDir = nonGlobParts.join("/") || "/";
    const resolvedBase = path.isAbsolute(baseDir)
      ? path.resolve(baseDir)
      : path.resolve(normWorkspaceRoot, baseDir);
    const normResolvedBase = normalizeSlashes(resolvedBase);

    const insideWorkspace =
      normResolvedBase === normWorkspaceRoot ||
      normResolvedBase.startsWith(
        normWorkspaceRoot.endsWith("/") ? normWorkspaceRoot : `${normWorkspaceRoot}/`,
      );

    const insideTemp =
      options.allowTemp &&
      (normResolvedBase === effectiveTempDir ||
        normResolvedBase.startsWith(
          effectiveTempDir.endsWith("/") ? effectiveTempDir : `${effectiveTempDir}/`,
        ));

    if (!insideWorkspace && !insideTemp) {
      throw new PolicyCanonicalizationError(
        "PARENT_WIDENING",
        `Glob base path escapes allowed workspace/temp root: ${rawPath}`,
        { rawPath, baseDir: normResolvedBase, workspaceRoot: normWorkspaceRoot },
      );
    }

    return normalizedSlashes;
  }

  // Exact path resolution
  const resolved = path.isAbsolute(normalizedSlashes)
    ? path.resolve(normalizedSlashes)
    : path.resolve(normWorkspaceRoot, normalizedSlashes);

  const canonical = normalizeSlashes(resolved);

  const insideWorkspace =
    canonical === normWorkspaceRoot ||
    canonical.startsWith(
      normWorkspaceRoot.endsWith("/") ? normWorkspaceRoot : `${normWorkspaceRoot}/`,
    );

  const insideTemp =
    options.allowTemp &&
    (canonical === effectiveTempDir ||
      canonical.startsWith(
        effectiveTempDir.endsWith("/") ? effectiveTempDir : `${effectiveTempDir}/`,
      ));

  if (!insideWorkspace && !insideTemp) {
    throw new PolicyCanonicalizationError(
      "PARENT_WIDENING",
      `Path escapes workspace root (${normWorkspaceRoot}): ${rawPath} -> ${canonical}`,
      { rawPath, canonical, workspaceRoot: normWorkspaceRoot },
    );
  }

  return canonical;
}

/**
 * Converts a glob pattern into a regular expression.
 */
export function globToRegExp(globPattern: string): RegExp {
  const normPattern = normalizeSlashes(globPattern);
  let regexStr = "^";
  let i = 0;
  while (i < normPattern.length) {
    const char = normPattern[i];
    if (char === "*") {
      if (normPattern[i + 1] === "*") {
        // Recursive wildcard **
        if (normPattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // Single wildcard *
        regexStr += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (/[.\\+^$[\](){}|]/.test(char)) {
      regexStr += `\\${char}`;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Checks whether a given canonical path matches an allowed or denied path pattern.
 */
export function matchesPathPattern(
  targetPath: string,
  pattern: string,
  workspaceRoot: string,
): boolean {
  const normTarget = normalizeSlashes(path.resolve(workspaceRoot, targetPath));
  const expandedPattern = expandWorkspacePlaceholder(pattern, workspaceRoot);
  const normPattern = normalizeSlashes(expandedPattern);

  // If pattern is a glob
  if (/[*?]/.test(normPattern)) {
    const resolvedPattern = path.isAbsolute(normPattern)
      ? normPattern
      : `${normalizeSlashes(path.resolve(workspaceRoot))}/${normPattern.replace(/^\.\//, "")}`;
    const re = globToRegExp(resolvedPattern);
    if (re.test(normTarget)) {
      return true;
    }
    // Also test relative pattern
    const relTarget = normalizeSlashes(path.relative(workspaceRoot, normTarget));
    const reRel = globToRegExp(normPattern.replace(/^\.\//, ""));
    return reRel.test(relTarget);
  }

  // Exact path or directory prefix
  const resolvedPattern = normalizeSlashes(path.resolve(workspaceRoot, normPattern));
  if (normTarget === resolvedPattern) {
    return true;
  }

  const dirPrefix = resolvedPattern.endsWith("/") ? resolvedPattern : `${resolvedPattern}/`;
  return normTarget.startsWith(dirPrefix);
}

/**
 * Checks whether a path is allowed given read/write allowed list and deny list.
 */
export function isPathPermitted(
  targetPath: string,
  allowedPatterns: string[],
  denyPatterns: string[],
  workspaceRoot: string,
): boolean {
  const normTarget = canonicalizePath(targetPath, workspaceRoot, { allowTemp: true });

  // Deny list takes strict precedence
  for (const denyPattern of denyPatterns) {
    if (matchesPathPattern(normTarget, denyPattern, workspaceRoot)) {
      return false;
    }
  }

  // If allowedPatterns is empty, check if target is inside workspace root
  if (allowedPatterns.length === 0) {
    return isPathInsideRoot(normTarget, workspaceRoot);
  }

  for (const allowedPattern of allowedPatterns) {
    if (matchesPathPattern(normTarget, allowedPattern, workspaceRoot)) {
      return true;
    }
  }

  return false;
}

export interface CanonicalFsCapability {
  readPaths: string[];
  writePaths: string[];
  allowWorkspaceRoot: boolean;
  allowTemp: boolean;
  denyPaths: string[];
  maxFileSizeBytes: number;
}

/**
 * Canonicalizes a FsCapability object deterministically.
 */
export function canonicalizeFsCapability(
  fsCap: FsCapability,
  workspaceRoot: string,
): CanonicalFsCapability {
  const normRead = (fsCap.readPaths ?? []).map((p) =>
    canonicalizePath(p, workspaceRoot, {
      allowTemp: fsCap.allowTemp,
      allowGlob: true,
    }),
  );
  const normWrite = (fsCap.writePaths ?? []).map((p) =>
    canonicalizePath(p, workspaceRoot, {
      allowTemp: fsCap.allowTemp,
      allowGlob: true,
    }),
  );
  const normDeny = (fsCap.denyPaths ?? []).map((p) =>
    canonicalizePath(p, workspaceRoot, {
      allowTemp: true,
      allowGlob: true,
    }),
  );

  return {
    readPaths: Array.from(new Set(normRead)).sort(),
    writePaths: Array.from(new Set(normWrite)).sort(),
    allowWorkspaceRoot: Boolean(fsCap.allowWorkspaceRoot),
    allowTemp: Boolean(fsCap.allowTemp),
    denyPaths: Array.from(new Set(normDeny)).sort(),
    maxFileSizeBytes: Math.max(1, Math.floor(fsCap.maxFileSizeBytes ?? 10485760)),
  };
}

// =============================================================================
// Network Canonicalizer
// =============================================================================

export interface CanonicalNetCapability {
  allowOutbound: boolean;
  allowedDomains: string[];
  allowedHosts: string[];
  allowedPorts: number[];
  allowedProtocols: ("http" | "https" | "ws" | "wss")[];
  allowLocalhost: boolean;
  denyPrivateRanges: boolean;
}

/**
 * Standard protocol schemes supported by the network broker.
 */
export const ALLOWED_PROTOCOLS = ["http", "https", "ws", "wss"] as const;
export type AllowedProtocol = (typeof ALLOWED_PROTOCOLS)[number];

/**
 * Canonicalizes and validates a network scheme / protocol.
 */
export function canonicalizeScheme(rawScheme: string): AllowedProtocol {
  if (typeof rawScheme !== "string") {
    throw new PolicyCanonicalizationError("INVALID_SCHEME", "Scheme must be a string");
  }
  const clean = rawScheme
    .toLowerCase()
    .replace(/[:/]+$/, "")
    .trim();
  if (clean === "http" || clean === "https" || clean === "ws" || clean === "wss") {
    return clean;
  }
  throw new PolicyCanonicalizationError(
    "INVALID_SCHEME",
    `Unsupported network protocol scheme: ${rawScheme}`,
    { rawScheme },
  );
}

/**
 * Canonicalizes a port number.
 */
export function canonicalizePort(
  port: number | string | undefined,
  defaultScheme?: string,
): number {
  if (port === undefined || port === null || port === "") {
    if (defaultScheme === "https" || defaultScheme === "wss") return 443;
    return 80;
  }

  const num = typeof port === "string" ? Number.parseInt(port, 10) : port;
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new PolicyCanonicalizationError(
      "INVALID_PORT",
      `Port must be an integer between 1 and 65535: ${port}`,
      { port },
    );
  }
  return num;
}

/**
 * Canonicalizes a hostname or domain pattern.
 * Trims trailing dots, normalizes to lowercase, rejects invalid chars.
 */
export function canonicalizeHost(rawHost: string): string {
  if (typeof rawHost !== "string" || rawHost.trim().length === 0) {
    throw new PolicyCanonicalizationError("INVALID_HOST", "Host must be a non-empty string");
  }

  let host = rawHost.trim().toLowerCase().normalize("NFC");

  // Strip protocol prefix if present
  if (host.includes("://")) {
    try {
      const url = new URL(host);
      host = url.hostname;
    } catch {
      host = host.replace(/^[a-z]+:\/\//, "");
    }
  }

  // Strip trailing slash or port if provided as host:port
  if (host.includes("/")) {
    host = host.split("/")[0];
  }
  if (host.includes(":") && !host.startsWith("[")) {
    // IPv4 or hostname with port
    host = host.split(":")[0];
  }

  // Trim trailing dot (e.g. example.com.)
  host = host.replace(/\.+$/, "");

  if (host.length === 0) {
    throw new PolicyCanonicalizationError("INVALID_HOST", `Invalid empty host from: ${rawHost}`);
  }

  // Allow wildcard prefix *.
  const isWildcard = host.startsWith("*.");
  const checkHost = isWildcard ? host.slice(2) : host;

  if (checkHost.length === 0) {
    throw new PolicyCanonicalizationError("INVALID_HOST", `Invalid wildcard host: ${rawHost}`);
  }

  // Validate characters: only alphanumeric, hyphen, dot, and IPv6 brackets/colons
  if (!/^[a-z0-9_.-]+$/.test(checkHost) && !/^\[[a-f0-9:]+\]$/.test(checkHost)) {
    throw new PolicyCanonicalizationError(
      "INVALID_HOST",
      `Host contains invalid characters: ${rawHost}`,
      { rawHost, host },
    );
  }

  return host;
}

/**
 * Parses numeric IPv4 representation (e.g. hex 0x7f000001, octal 0177.0.0.1, integer 2130706433).
 */
function parseIpv4ToNumber(ipStr: string): number | null {
  const parts = ipStr.trim().split(".");
  if (parts.length === 1) {
    // Single integer / hex representation e.g. 2130706433 or 0x7f000001
    const raw = parts[0];
    const num =
      raw.startsWith("0x") || raw.startsWith("0X")
        ? Number.parseInt(raw, 16)
        : raw.startsWith("0") && raw.length > 1
          ? Number.parseInt(raw, 8)
          : Number.parseInt(raw, 10);
    if (!Number.isNaN(num) && num >= 0 && num <= 0xffffffff) {
      return num;
    }
    return null;
  }

  if (parts.length !== 4) {
    return null;
  }

  let fullNum = 0;
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    let byteVal: number;
    if (p.startsWith("0x") || p.startsWith("0X")) {
      byteVal = Number.parseInt(p, 16);
    } else if (p.startsWith("0") && p.length > 1 && /^[0-7]+$/.test(p)) {
      byteVal = Number.parseInt(p, 8);
    } else {
      byteVal = Number.parseInt(p, 10);
    }

    if (Number.isNaN(byteVal) || byteVal < 0 || byteVal > 255) {
      return null;
    }
    fullNum = (fullNum << 8) | byteVal;
  }

  return fullNum >>> 0; // Unsigned 32-bit int
}

/**
 * Checks whether an IPv4 numeric address falls into private, loopback, or reserved ranges.
 */
function isPrivateIpv4Number(ipNum: number): boolean {
  const b0 = (ipNum >>> 24) & 0xff;
  const b1 = (ipNum >>> 16) & 0xff;
  const b2 = (ipNum >>> 8) & 0xff;
  const b3 = ipNum & 0xff;

  // 0.0.0.0/8 (Current network / default route)
  if (b0 === 0) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 10.0.0.0/8 (Private-Use RFC 1918)
  if (b0 === 10) return true;

  // 172.16.0.0/12 (Private-Use RFC 1918: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.168.0.0/16 (Private-Use RFC 1918)
  if (b0 === 192 && b1 === 168) return true;

  // 169.254.0.0/16 (Link-Local RFC 3927)
  if (b0 === 169 && b1 === 254) return true;

  // 100.64.0.0/10 (Carrier-Grade NAT RFC 6598: 100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 192.0.2.0/24 (TEST-NET-1 RFC 5737)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;

  // 198.51.100.0/24 (TEST-NET-2 RFC 5737)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3 RFC 5737)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;

  // 224.0.0.0/4 (Multicast RFC 5771: 224.0.0.0 - 239.255.255.255)
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 (Reserved RFC 1112: 240.0.0.0 - 255.255.255.255)
  if (b0 >= 240) return true;

  return false;
}

/**
 * Checks whether a given host or IP is private, reserved, loopback, or local.
 */
export function isPrivateOrReservedIp(ipOrHost: string): boolean {
  const host = ipOrHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  // Localhost names
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local")
  ) {
    return true;
  }

  // Check IPv4 parsing
  const ipv4Num = parseIpv4ToNumber(host);
  if (ipv4Num !== null) {
    return isPrivateIpv4Number(ipv4Num);
  }

  // Check IPv6 addresses
  if (host.includes(":")) {
    // Loopback
    if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "::") {
      return true;
    }

    // IPv4-mapped IPv6 ::ffff:127.0.0.1 or ::ffff:7f00:1
    if (host.startsWith("::ffff:") || host.startsWith("0:0:0:0:0:ffff:")) {
      const remainder = host.split("ffff:")[1];
      if (remainder) {
        if (remainder.includes(".")) {
          const mappedIpv4 = parseIpv4ToNumber(remainder);
          if (mappedIpv4 !== null) return isPrivateIpv4Number(mappedIpv4);
        } else {
          // Hex format e.g. 7f00:1
          const hexParts = remainder.split(":");
          if (hexParts.length === 2) {
            const high = Number.parseInt(hexParts[0], 16);
            const low = Number.parseInt(hexParts[1], 16);
            if (!Number.isNaN(high) && !Number.isNaN(low)) {
              const num = ((high << 16) | low) >>> 0;
              return isPrivateIpv4Number(num);
            }
          }
        }
      }
      return true;
    }

    // Unique Local Addresses (fc00::/7 -> fc00:: through fdff::)
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) {
      return true;
    }

    // Link-Local (fe80::/10 -> fe80:: through febf::)
    if (/^fe[89ab][0-9a-f]:/i.test(host)) {
      return true;
    }

    // Documentation (2001:db8::/32)
    if (host.startsWith("2001:db8:") || host.startsWith("2001:0db8:")) {
      return true;
    }

    // Multicast (ff00::/8)
    if (host.startsWith("ff")) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether a hostname matches an allowed domain or host pattern (including wildcards).
 */
export function matchesHostPattern(targetHost: string, allowedPattern: string): boolean {
  const normTarget = canonicalizeHost(targetHost);
  const normPattern = canonicalizeHost(allowedPattern);

  if (normTarget === normPattern) {
    return true;
  }

  if (normPattern.startsWith("*.")) {
    const rootDomain = normPattern.slice(2);
    // Matches sub.domain.com and domain.com itself
    if (normTarget === rootDomain || normTarget.endsWith(`.${rootDomain}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Canonicalizes a NetCapability object deterministically.
 */
export function canonicalizeNetCapability(netCap: NetCapability): CanonicalNetCapability {
  const normDomains = (netCap.allowedDomains ?? []).map(canonicalizeHost);
  const normHosts = (netCap.allowedHosts ?? []).map(canonicalizeHost);
  const normPorts = (netCap.allowedPorts ?? []).map((p) => canonicalizePort(p));
  const normProtocols = (netCap.allowedProtocols ?? ["https"]).map(canonicalizeScheme);

  return {
    allowOutbound: Boolean(netCap.allowOutbound),
    allowedDomains: Array.from(new Set(normDomains)).sort(),
    allowedHosts: Array.from(new Set(normHosts)).sort(),
    allowedPorts: Array.from(new Set(normPorts)).sort((a, b) => a - b),
    allowedProtocols: Array.from(new Set(normProtocols)).sort(),
    allowLocalhost: Boolean(netCap.allowLocalhost),
    denyPrivateRanges: netCap.denyPrivateRanges !== false, // default true
  };
}

// =============================================================================
// Command Canonicalizer
// =============================================================================

export interface CanonicalCommandCapability {
  allowShellExecution: boolean;
  allowedCommands: string[];
  allowedBinaries: string[];
  forbiddenPatterns: string[];
  allowEnvPassthrough: string[];
}

/**
 * Known shell binaries that execute shell scripts and arbitrary commands.
 */
export const SHELL_EXECUTABLES: Record<string, true> = {
  sh: true,
  bash: true,
  zsh: true,
  csh: true,
  tcsh: true,
  ksh: true,
  fish: true,
  dash: true,
  ash: true,
  cmd: true,
  "cmd.exe": true,
  powershell: true,
  "powershell.exe": true,
  pwsh: true,
  "pwsh.exe": true,
  wscript: true,
  "wscript.exe": true,
  cscript: true,
  "cscript.exe": true,
};

/**
 * Checks whether an executable name or path refers to a shell executable.
 */
export function isShellExecutable(cmd: string): boolean {
  const baseName = path.basename(cmd).toLowerCase();
  return SHELL_EXECUTABLES[baseName] === true;
}

/**
 * Detects shell metacharacters that enable command chaining, redirection, or injection.
 */
export function containsShellMetacharacters(commandStr: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[;&|`$><\n\r\t]|\$\(|\$\{/.test(commandStr);
}

/**
 * Dangerous environment variables that can hijack process execution or shared library loading.
 */
export const DANGEROUS_ENV_VARS: Record<string, true> = {
  LD_PRELOAD: true,
  LD_LIBRARY_PATH: true,
  DYLD_INSERT_LIBRARIES: true,
  DYLD_LIBRARY_PATH: true,
  DYLD_FRAMEWORK_PATH: true,
  NODE_OPTIONS: true,
  PYTHONPATH: true,
  PYTHONHOME: true,
  RUBYOPT: true,
  PERL5OPT: true,
  PERL5LIB: true,
  BASH_ENV: true,
  ENV: true,
  PROMPT_COMMAND: true,
  SHELLOPTS: true,
  BASHOPTS: true,
  GLIBC_TUNABLES: true,
};

/**
 * Checks whether an environment variable name is dangerous.
 */
export function isDangerousEnvVar(envName: string): boolean {
  return DANGEROUS_ENV_VARS[envName.toUpperCase()] === true;
}
/**
 * Validates whether an environment variable name is safe and valid.
 */
export function canonicalizeEnvName(rawName: string): string {
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new PolicyCanonicalizationError("DANGEROUS_ENV_VAR", "Env var name must be non-empty");
  }

  const name = rawName.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new PolicyCanonicalizationError(
      "DANGEROUS_ENV_VAR",
      `Invalid environment variable identifier: ${name}`,
      { name },
    );
  }

  return name;
}

/**
 * Canonicalizes a command / executable name.
 */
export function canonicalizeCommand(cmd: string): string {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    throw new PolicyCanonicalizationError("EMPTY_PATH", "Command must be a non-empty string");
  }

  const clean = cmd.trim();

  // Traversal check
  if (clean.includes("..")) {
    throw new PolicyCanonicalizationError(
      "PATH_TRAVERSAL",
      `Command executable path cannot contain path traversal: ${clean}`,
      { cmd },
    );
  }

  // Metacharacters check
  if (containsShellMetacharacters(clean)) {
    throw new PolicyCanonicalizationError(
      "SHELL_METACHARACTERS_DETECTED",
      `Command contains forbidden shell metacharacters: ${clean}`,
      { cmd },
    );
  }

  return normalizeSlashes(clean);
}

/**
 * Matches an argument against an argument pattern (exact, prefix, or regex).
 */
export function matchesArgPattern(arg: string, pattern: string): boolean {
  if (arg === pattern) return true;

  if (pattern.startsWith("^") || pattern.endsWith("$")) {
    try {
      const re = new RegExp(pattern);
      return re.test(arg);
    } catch {
      return false;
    }
  }

  if (pattern.includes("*")) {
    const re = globToRegExp(pattern);
    return re.test(arg);
  }

  return false;
}

/**
 * Validates a working directory against workspace root and temp directory.
 */
export function validateWorkingDir(
  workingDir: string,
  workspaceRoot: string,
  allowTemp = false,
  tempDir?: string,
): void {
  const normTarget = normalizeSlashes(path.resolve(workspaceRoot, workingDir));
  const normRoot = normalizeSlashes(path.resolve(workspaceRoot));
  const effectiveTemp = normalizeSlashes(path.resolve(tempDir ?? os.tmpdir()));

  const inWorkspace =
    normTarget === normRoot ||
    normTarget.startsWith(normRoot.endsWith("/") ? normRoot : `${normRoot}/`);
  const inTemp =
    allowTemp &&
    (normTarget === effectiveTemp ||
      normTarget.startsWith(effectiveTemp.endsWith("/") ? effectiveTemp : `${effectiveTemp}/`));

  if (!inWorkspace && !inTemp) {
    throw new PolicyCanonicalizationError(
      "WORKING_DIR_OUTSIDE_ROOT",
      `Working directory escapes workspace root: ${workingDir}`,
      { workingDir, normTarget, workspaceRoot: normRoot },
    );
  }
}

/**
 * Canonicalizes a CommandCapability object deterministically.
 */
export function canonicalizeCommandCapability(
  cmdCap: CommandCapability,
): CanonicalCommandCapability {
  const normCommands = (cmdCap.allowedCommands ?? []).map(canonicalizeCommand);
  const normBinaries = (cmdCap.allowedBinaries ?? []).map(canonicalizeCommand);
  const normEnv = (cmdCap.allowEnvPassthrough ?? [])
    .map(canonicalizeEnvName)
    .filter((name) => !isDangerousEnvVar(name));

  return {
    allowShellExecution: Boolean(cmdCap.allowShellExecution),
    allowedCommands: Array.from(new Set(normCommands)).sort(),
    allowedBinaries: Array.from(new Set(normBinaries)).sort(),
    forbiddenPatterns: Array.from(new Set(cmdCap.forbiddenPatterns ?? [])).sort(),
    allowEnvPassthrough: Array.from(new Set(normEnv)).sort(),
  };
}

// =============================================================================
// Secret Canonicalizer
// =============================================================================

export interface CanonicalSecretCapability {
  allowedSecretNames: string[];
  allowedPrefixes: string[];
  denyDirectRead: boolean;
  injectAsEnv: boolean;
}

/**
 * Canonicalizes and validates a secret alias / name.
 */
export function canonicalizeSecretName(secretName: string): string {
  if (typeof secretName !== "string" || secretName.trim().length === 0) {
    throw new PolicyCanonicalizationError("INVALID_SECRET_NAME", "Secret name must be non-empty");
  }

  const name = secretName.trim();
  // Standard secret naming: uppercase alphanumeric with underscores or dots/hyphens
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new PolicyCanonicalizationError(
      "INVALID_SECRET_NAME",
      `Secret name contains invalid characters: ${name}`,
      { name },
    );
  }

  return name;
}

/**
 * Canonicalizes and validates a secret prefix.
 */
export function canonicalizeSecretPrefix(prefix: string): string {
  if (typeof prefix !== "string" || prefix.trim().length === 0) {
    throw new PolicyCanonicalizationError(
      "INVALID_SECRET_PREFIX",
      "Secret prefix must be non-empty",
    );
  }

  const clean = prefix.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(clean)) {
    throw new PolicyCanonicalizationError(
      "INVALID_SECRET_PREFIX",
      `Secret prefix contains invalid characters: ${clean}`,
      { prefix },
    );
  }

  return clean;
}

/**
 * Checks whether a named secret alias is permitted by allowed secret names or allowed prefixes.
 */
export function isSecretAllowed(
  secretName: string,
  allowedNames: string[],
  allowedPrefixes: string[],
): boolean {
  const normName = canonicalizeSecretName(secretName);

  for (const allowed of allowedNames) {
    if (normName === allowed) {
      return true;
    }
  }

  for (const prefix of allowedPrefixes) {
    if (normName.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

/**
 * Canonicalizes a SecretCapability object deterministically.
 */
export function canonicalizeSecretCapability(
  secretCap: SecretCapability,
): CanonicalSecretCapability {
  const normNames = (secretCap.allowedSecretNames ?? []).map(canonicalizeSecretName);
  const normPrefixes = (secretCap.allowedPrefixes ?? []).map(canonicalizeSecretPrefix);

  return {
    allowedSecretNames: Array.from(new Set(normNames)).sort(),
    allowedPrefixes: Array.from(new Set(normPrefixes)).sort(),
    denyDirectRead: secretCap.denyDirectRead !== false, // default true
    injectAsEnv: secretCap.injectAsEnv !== false, // default true
  };
}
