import path from "node:path";
import type { CapabilityEnvelope, CapabilityManifest, ToolManifest } from "@tool-evolver/contracts";
import type {
  ArtifactInspectionResult,
  PreactivationCheckResult,
  PreactivationViolation,
  ToolOverrideRecord,
} from "./types.js";

/**
 * List of known dangerous environment variables that must never be set in commands.
 */
const DANGEROUS_ENV_VARS: readonly string[] = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "PERL5OPT",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "SSLKEYLOGFILE",
];

/**
 * Known private/loopback IP address patterns.
 */
const PRIVATE_IP_REGEX =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|::1|fc00:|fe80:)/i;

/**
 * Options for configuring LocalPreactivationChecker.
 */
export interface LocalPreactivationCheckerOptions {
  supportedEngines?: string[];
  supportedSdkVersions?: string[];
  strictPathChecks?: boolean;
}

/**
 * Context passed to preactivation check.
 */
export interface PreactivationContext {
  manifest: ToolManifest;
  workspaceId: string;
  envelope?: CapabilityEnvelope | null;
  overrides?: ToolOverrideRecord[] | null;
  inspection?: ArtifactInspectionResult | null;
  targetVersion?: string;
  targetDigest?: string;
  workspaceRoot?: string;
}

/**
 * Helper to match domain with wildcard support (e.g. *.api.com matches sub.api.com).
 */
export function isDomainAllowed(domain: string, allowedPatterns: string[]): boolean {
  const normDomain = domain.toLowerCase().trim();
  for (const pattern of allowedPatterns) {
    const normPattern = pattern.toLowerCase().trim();
    if (normPattern === normDomain || normPattern === "*") {
      return true;
    }
    if (normPattern.startsWith("*.")) {
      const suffix = normPattern.slice(2);
      if (normDomain === suffix || normDomain.endsWith(`.${suffix}`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Helper to check if a path is safe and permitted under base allowed/denied paths.
 */
export function isPathPermitted(
  targetPath: string,
  allowedPaths: string[],
  denyPaths: string[],
  workspaceRoot?: string,
): { permitted: boolean; reason?: string } {
  const normalizedTarget = path.normalize(targetPath);

  // Check deny paths first (denials take strict precedence)
  for (const deny of denyPaths) {
    const normalizedDeny = path.normalize(deny);
    if (
      normalizedTarget === normalizedDeny ||
      normalizedTarget.startsWith(`${normalizedDeny}${path.sep}`) ||
      normalizedTarget.startsWith(normalizedDeny)
    ) {
      return {
        permitted: false,
        reason: `Path '${targetPath}' is matched by deny pattern '${deny}'`,
      };
    }
  }

  // If no allowed paths are specified, allow if workspaceRoot contains it
  if (allowedPaths.length === 0) {
    if (workspaceRoot) {
      const normRoot = path.normalize(workspaceRoot);
      if (normalizedTarget === normRoot || normalizedTarget.startsWith(`${normRoot}${path.sep}`)) {
        return { permitted: true };
      }
      return {
        permitted: false,
        reason: `Path '${targetPath}' is outside workspace root '${workspaceRoot}'`,
      };
    }
    return { permitted: true };
  }

  // Check if matches any allowed path
  for (const allowed of allowedPaths) {
    const normalizedAllowed = path.normalize(allowed);
    if (
      normalizedTarget === normalizedAllowed ||
      normalizedTarget.startsWith(`${normalizedAllowed}${path.sep}`) ||
      normalizedAllowed === "." ||
      normalizedAllowed === "*"
    ) {
      return { permitted: true };
    }
  }

  return {
    permitted: false,
    reason: `Path '${targetPath}' is not within any allowed paths: [${allowedPaths.join(", ")}]`,
  };
}

/**
 * Local preactivation checker verifying capability envelope constraints (TE-021),
 * user pin/disable overrides, runtime/SDK support, and non-executing loader inspection (TE-019).
 */
export class LocalPreactivationChecker {
  private readonly supportedEngines: Set<string>;
  private readonly supportedSdkVersions: Set<string>;

  constructor(options: LocalPreactivationCheckerOptions = {}) {
    this.supportedEngines = new Set(
      options.supportedEngines ?? ["deno", "node", "bun", "wasm", "process", "builtin"],
    );
    this.supportedSdkVersions = new Set(options.supportedSdkVersions ?? ["1.0.0", "0.1.0"]);
  }

  /**
   * Evaluates all preactivation checks for a tool candidate.
   */
  async checkPreactivation(context: PreactivationContext): Promise<PreactivationCheckResult> {
    const violations: PreactivationViolation[] = [];
    const warnings: string[] = [];
    const metadata: Record<string, unknown> = {};

    const { manifest, workspaceId, envelope, overrides, inspection, targetVersion, workspaceRoot } =
      context;
    const versionToCheck = targetVersion ?? manifest.version;

    // -------------------------------------------------------------------------
    // 1. Non-executing loader inspection checks (TE-019)
    // -------------------------------------------------------------------------
    if (inspection) {
      if (inspection.signature && !inspection.signature.valid) {
        violations.push({
          code: "INVALID_SIGNATURE",
          subsystem: "security",
          message: `Artifact signature verification failed: ${inspection.signature.error ?? "Invalid"}`,
          field: "signature",
        });
      }

      for (const file of inspection.files) {
        if (file.path.startsWith("../") || file.path.includes("/../")) {
          violations.push({
            code: "PATH_TRAVERSAL_DETECTED",
            subsystem: "security",
            message: `Bundle contains dangerous path traversal entry: ${file.path}`,
            field: "files",
            requestedValue: file.path,
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // 2. User Overrides & Pin Constraints
    // -------------------------------------------------------------------------
    if (overrides && overrides.length > 0) {
      for (const override of overrides) {
        if (override.toolId === manifest.id) {
          // Check explicit disable override
          if (override.action === "disable" || override.isEnabled === false) {
            violations.push({
              code: "USER_DISABLED_OVERRIDE",
              subsystem: "override",
              message: `Tool '${manifest.id}' is explicitly disabled by user override`,
              field: "action",
              requestedValue: "disable",
            });
          }

          // Check explicit version pin override
          if (override.action === "pin" && override.pinnedVersion) {
            if (versionToCheck !== override.pinnedVersion) {
              violations.push({
                code: "USER_PIN_OVERRIDE",
                subsystem: "override",
                message: `Tool '${manifest.id}' is pinned to version '${override.pinnedVersion}'; candidate version '${versionToCheck}' rejected`,
                field: "pinnedVersion",
                requestedValue: versionToCheck,
              });
            }
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. Runtime & SDK Support
    // -------------------------------------------------------------------------
    const runtimeReq = manifest.runtime as Record<string, unknown> | undefined;
    if (runtimeReq) {
      const engine =
        typeof runtimeReq.engine === "string" ? runtimeReq.engine.toLowerCase() : "node";
      if (!this.supportedEngines.has(engine)) {
        violations.push({
          code: "UNSUPPORTED_RUNTIME",
          subsystem: "runtime",
          message: `Tool requires unsupported runtime engine '${engine}'. Supported: ${Array.from(this.supportedEngines).join(", ")}`,
          field: "runtime.engine",
          requestedValue: engine,
        });
      }

      if (typeof runtimeReq.sdkVersion === "string") {
        if (
          this.supportedSdkVersions.size > 0 &&
          !this.supportedSdkVersions.has(runtimeReq.sdkVersion)
        ) {
          warnings.push(
            `Tool requested SDK version '${runtimeReq.sdkVersion}' may not be fully supported`,
          );
        }
      }
    }

    // -------------------------------------------------------------------------
    // 4. Capability Envelope Constraints (TE-021)
    // -------------------------------------------------------------------------
    if (envelope) {
      const caps: Partial<CapabilityManifest> =
        (manifest.capabilities as Partial<CapabilityManifest> | undefined) ?? {};

      // --- FS Capabilities ---
      if (caps.fs) {
        const envFs = envelope.fs;
        const toolFs = caps.fs;

        // Check read paths
        for (const readPath of toolFs.readPaths ?? []) {
          const res = isPathPermitted(
            readPath,
            envFs.readPaths ?? [],
            envFs.denyPaths ?? [],
            workspaceRoot,
          );
          if (!res.permitted) {
            violations.push({
              code: "FS_READ_PATH_DISALLOWED",
              subsystem: "fs",
              message: res.reason ?? `Read access to path '${readPath}' disallowed by envelope`,
              field: "capabilities.fs.readPaths",
              requestedValue: readPath,
            });
          }
        }

        // Check write paths
        for (const writePath of toolFs.writePaths ?? []) {
          const res = isPathPermitted(
            writePath,
            envFs.writePaths ?? [],
            envFs.denyPaths ?? [],
            workspaceRoot,
          );
          if (!res.permitted) {
            violations.push({
              code: "FS_WRITE_PATH_DISALLOWED",
              subsystem: "fs",
              message: res.reason ?? `Write access to path '${writePath}' disallowed by envelope`,
              field: "capabilities.fs.writePaths",
              requestedValue: writePath,
            });
          }
        }

        // Check max file size limit
        if (toolFs.maxFileSizeBytes && envFs.maxFileSizeBytes) {
          if (toolFs.maxFileSizeBytes > envFs.maxFileSizeBytes) {
            violations.push({
              code: "FS_MAX_SIZE_EXCEEDED",
              subsystem: "fs",
              message: `Requested maxFileSizeBytes (${toolFs.maxFileSizeBytes}) exceeds envelope limit (${envFs.maxFileSizeBytes})`,
              field: "capabilities.fs.maxFileSizeBytes",
              requestedValue: toolFs.maxFileSizeBytes,
            });
          }
        }
      }

      // --- Net Capabilities ---
      if (caps.net) {
        const envNet = envelope.net;
        const toolNet = caps.net;

        // If tool requests outbound, envelope must allow outbound
        if (toolNet.allowOutbound && !envNet.allowOutbound) {
          violations.push({
            code: "NET_OUTBOUND_DISALLOWED",
            subsystem: "net",
            message: "Tool requested network outbound access, but envelope has allowOutbound=false",
            field: "capabilities.net.allowOutbound",
            requestedValue: true,
          });
        }

        // Check domains
        for (const domain of toolNet.allowedDomains ?? []) {
          if (envNet.denyPrivateRanges && PRIVATE_IP_REGEX.test(domain)) {
            violations.push({
              code: "NET_PRIVATE_IP_BLOCKED",
              subsystem: "net",
              message: `Domain/host '${domain}' is a private or loopback address prohibited by envelope`,
              field: "capabilities.net.allowedDomains",
              requestedValue: domain,
            });
            continue;
          }

          if (envNet.allowedDomains && envNet.allowedDomains.length > 0) {
            if (!isDomainAllowed(domain, envNet.allowedDomains)) {
              violations.push({
                code: "NET_DOMAIN_DISALLOWED",
                subsystem: "net",
                message: `Domain '${domain}' is not permitted by capability envelope allowedDomains: [${envNet.allowedDomains.join(", ")}]`,
                field: "capabilities.net.allowedDomains",
                requestedValue: domain,
              });
            }
          }
        }

        // Check ports
        if (envNet.allowedPorts && envNet.allowedPorts.length > 0 && toolNet.allowedPorts) {
          const allowedPortsSet = new Set(envNet.allowedPorts);
          for (const port of toolNet.allowedPorts) {
            if (!allowedPortsSet.has(port)) {
              violations.push({
                code: "NET_PORT_DISALLOWED",
                subsystem: "net",
                message: `Port ${port} is not in capability envelope allowedPorts: [${envNet.allowedPorts.join(", ")}]`,
                field: "capabilities.net.allowedPorts",
                requestedValue: port,
              });
            }
          }
        }

        // Check protocols
        if (
          envNet.allowedProtocols &&
          envNet.allowedProtocols.length > 0 &&
          toolNet.allowedProtocols
        ) {
          const allowedProtoSet = new Set(envNet.allowedProtocols);
          for (const proto of toolNet.allowedProtocols) {
            if (!allowedProtoSet.has(proto)) {
              violations.push({
                code: "NET_PROTOCOL_DISALLOWED",
                subsystem: "net",
                message: `Protocol '${proto}' is not in capability envelope allowedProtocols: [${envNet.allowedProtocols.join(", ")}]`,
                field: "capabilities.net.allowedProtocols",
                requestedValue: proto,
              });
            }
          }
        }
      }

      // --- Command Capabilities ---
      if (caps.command) {
        const envCmd = envelope.command;
        const toolCmd = caps.command;

        // Shell execution
        if (toolCmd.allowShellExecution && !envCmd.allowShellExecution) {
          violations.push({
            code: "COMMAND_SHELL_DISALLOWED",
            subsystem: "command",
            message:
              "Tool requested shell execution, but capability envelope has allowShellExecution=false",
            field: "capabilities.command.allowShellExecution",
            requestedValue: true,
          });
        }

        // Whitelisted commands
        if (
          envCmd.allowedCommands &&
          envCmd.allowedCommands.length > 0 &&
          toolCmd.allowedCommands
        ) {
          const allowedCmdsSet = new Set(envCmd.allowedCommands.map((c) => c.toLowerCase()));
          for (const cmd of toolCmd.allowedCommands) {
            if (!allowedCmdsSet.has(cmd.toLowerCase())) {
              violations.push({
                code: "COMMAND_DISALLOWED",
                subsystem: "command",
                message: `Command '${cmd}' is not in capability envelope allowedCommands whitelist`,
                field: "capabilities.command.allowedCommands",
                requestedValue: cmd,
              });
            }
          }
        }

        // Dangerous environment variables
        const envPassthrough =
          toolCmd.allowEnvPassthrough ??
          ((toolCmd as Record<string, unknown>).allowedEnvVars as string[] | undefined);
        if (envPassthrough) {
          for (const envVar of envPassthrough) {
            if (DANGEROUS_ENV_VARS.includes(envVar.toUpperCase())) {
              violations.push({
                code: "DANGEROUS_ENV_VAR_REQUESTED",
                subsystem: "command",
                message: `Dangerous environment variable '${envVar}' cannot be granted`,
                field: "capabilities.command.allowEnvPassthrough",
                requestedValue: envVar,
              });
            }
          }
        }
      }

      // --- Secrets Capabilities ---
      if (caps.secrets) {
        const envSec = envelope.secrets;
        const toolSec = caps.secrets;

        if (
          toolSec.denyDirectRead === false ||
          (toolSec as Record<string, unknown>).allowDirectRead === true
        ) {
          violations.push({
            code: "DIRECT_READ_DISALLOWED",
            subsystem: "secrets",
            message: `Tool '${manifest.id}' requests direct secret reads (denyDirectRead: false), which is prohibited by protocol v1.0.0. Migrate tool to use opaque secret references and trusted broker mediation.`,
            field: "capabilities.secrets.denyDirectRead",
            requestedValue: false,
          });
        }

        const secretNames =
          toolSec.allowedSecretNames ??
          ((toolSec as Record<string, unknown>).requiredSecrets as string[] | undefined);
        if (envSec.allowedSecretNames && envSec.allowedSecretNames.length > 0 && secretNames) {
          const allowedSecretsSet = new Set(envSec.allowedSecretNames);
          for (const secret of secretNames) {
            if (!allowedSecretsSet.has(secret)) {
              violations.push({
                code: "SECRET_NAME_DISALLOWED",
                subsystem: "secrets",
                message: `Secret '${secret}' is not permitted by capability envelope allowedSecretNames`,
                field: "capabilities.secrets.allowedSecretNames",
                requestedValue: secret,
              });
            }
          }
        }
      }

      // --- Limits ---
      if (envelope.limits) {
        const envLimits = envelope.limits;
        const rawLimits = (manifest.limits ?? {}) as Record<string, unknown>;
        const maxMem =
          typeof rawLimits.maxMemoryMb === "number"
            ? rawLimits.maxMemoryMb
            : typeof rawLimits.maxMemoryBytes === "number"
              ? Math.ceil(rawLimits.maxMemoryBytes / (1024 * 1024))
              : undefined;

        if (maxMem && envLimits.maxMemoryMb && maxMem > envLimits.maxMemoryMb) {
          violations.push({
            code: "LIMIT_MEMORY_EXCEEDED",
            subsystem: "limits",
            message: `Requested maxMemoryMb (${maxMem}MB) exceeds envelope limit (${envLimits.maxMemoryMb}MB)`,
            field: "limits.maxMemoryMb",
            requestedValue: maxMem,
          });
        }

        const timeout =
          typeof rawLimits.timeoutMs === "number"
            ? rawLimits.timeoutMs
            : typeof rawLimits.maxExecutionTimeMs === "number"
              ? rawLimits.maxExecutionTimeMs
              : typeof rawLimits.executionTimeoutMs === "number"
                ? rawLimits.executionTimeoutMs
                : undefined;

        if (timeout && envLimits.maxExecutionTimeMs && timeout > envLimits.maxExecutionTimeMs) {
          violations.push({
            code: "LIMIT_TIMEOUT_EXCEEDED",
            subsystem: "limits",
            message: `Requested timeout (${timeout}ms) exceeds envelope limit (${envLimits.maxExecutionTimeMs}ms)`,
            field: "limits.timeoutMs",
            requestedValue: timeout,
          });
        }
      }
    }

    const eligible = violations.length === 0;

    return {
      eligible,
      violations,
      warnings,
      metadata: {
        workspaceId,
        toolId: manifest.id,
        version: versionToCheck,
        envelopeChecked: Boolean(envelope),
        overridesChecked: Boolean(overrides && overrides.length > 0),
        ...metadata,
      },
    };
  }
}
