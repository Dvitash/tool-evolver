import {
  type CapabilityEnvelope,
  type CapabilityLimits,
  type CapabilityManifest,
  CapabilityManifestSchema,
  type CommandCapability,
  type FsCapability,
  type NetCapability,
  type SecretCapability,
} from "@tool-evolver/contracts";
import type { CapabilityDiff, WorkflowStep } from "./types.js";

/**
 * Maps required broker operations and workflow steps to minimal CapabilityManifests.
 */
export class CapabilityMapper {
  /**
   * Maps an array of workflow steps to a minimal CapabilityManifest, optionally constrained by a CapabilityEnvelope.
   */
  mapRequiredCapabilities(
    steps: WorkflowStep[],
    envelope?: CapabilityEnvelope,
  ): CapabilityManifest {
    const fsCap: FsCapability = {
      readPaths: [],
      writePaths: [],
      allowWorkspaceRoot: true,
      allowTemp: true,
      denyPaths: [],
      maxFileSizeBytes: 10485760, // 10MB
    };

    const netCap: NetCapability = {
      allowOutbound: false,
      allowedDomains: [],
      allowedHosts: [],
      allowedPorts: [],
      allowedProtocols: ["https"],
      allowLocalhost: false,
      denyPrivateRanges: true,
    };

    const cmdCap: CommandCapability = {
      allowShellExecution: false,
      allowedCommands: [],
      allowedBinaries: [],
      forbiddenPatterns: [],
      allowEnvPassthrough: [],
    };

    const secretCap: SecretCapability = {
      allowedSecretNames: [],
      allowedPrefixes: [],
      denyDirectRead: true,
      injectAsEnv: true,
    };

    const limits: CapabilityLimits = {
      maxConcurrentExecutions: 4,
      maxCpuUsagePercent: 100,
      maxMemoryMb: 128,
      maxExecutionTimeMs: 30000,
      maxOutputSizeBytes: 1048576,
    };

    let needsFs = false;
    let needsNet = false;
    let needsCmd = false;
    let needsSecrets = false;

    for (const step of steps) {
      const action = step.action.toLowerCase();
      const service = step.service?.toLowerCase();
      const toolClass = (step.inputs.toolClass as string | undefined)?.toLowerCase();

      // 1. Filesystem capabilities
      if (
        service === "fs" ||
        action.startsWith("fs.") ||
        action.includes("readfile") ||
        action.includes("writefile") ||
        action.includes("listdir") ||
        action.includes("stat") ||
        toolClass === "filesystem" ||
        toolClass === "fs"
      ) {
        needsFs = true;
        const readPath =
          step.inputs.readPath ??
          step.inputs.path ??
          step.inputs.filePath ??
          step.inputs.sourcePath;
        if (typeof readPath === "string" && readPath.trim().length > 0) {
          const trimmed = readPath.trim();
          if (!fsCap.readPaths.includes(trimmed)) {
            fsCap.readPaths.push(trimmed);
          }
        }

        const writePath =
          step.inputs.writePath ??
          step.inputs.destinationPath ??
          step.inputs.outputPath ??
          (action.includes("write") || action.includes("create") ? step.inputs.path : undefined);
        if (typeof writePath === "string" && writePath.trim().length > 0) {
          const trimmed = writePath.trim();
          if (!fsCap.writePaths.includes(trimmed)) {
            fsCap.writePaths.push(trimmed);
          }
        }
      }

      // 2. Network capabilities
      if (
        service === "net" ||
        action.startsWith("net.") ||
        action.startsWith("http.") ||
        action.includes("fetch") ||
        action.includes("request") ||
        toolClass === "network" ||
        toolClass === "http" ||
        toolClass === "api"
      ) {
        needsNet = true;
        netCap.allowOutbound = true;

        const urlVal = step.inputs.url ?? step.inputs.endpoint ?? step.inputs.uri;
        const hostVal = step.inputs.host ?? step.inputs.domain;

        if (typeof hostVal === "string" && hostVal.trim().length > 0) {
          const host = hostVal.trim();
          if (!netCap.allowedHosts.includes(host)) {
            netCap.allowedHosts.push(host);
          }
          if (!netCap.allowedDomains.includes(host)) {
            netCap.allowedDomains.push(host);
          }
        }

        const urls = this.extractUrls(urlVal);
        for (const urlStr of urls) {
          try {
            const parsed = new URL(urlStr);
            const hostname = parsed.hostname;
            if (hostname && !netCap.allowedHosts.includes(hostname)) {
              netCap.allowedHosts.push(hostname);
            }
            if (hostname && !netCap.allowedDomains.includes(hostname)) {
              netCap.allowedDomains.push(hostname);
            }
            const protocol = parsed.protocol.replace(":", "") as "http" | "https" | "ws" | "wss";
            if (
              ["http", "https", "ws", "wss"].includes(protocol) &&
              !netCap.allowedProtocols.includes(protocol)
            ) {
              netCap.allowedProtocols.push(protocol);
            }
            if (parsed.port) {
              const portNum = Number.parseInt(parsed.port, 10);
              if (!Number.isNaN(portNum) && !netCap.allowedPorts.includes(portNum)) {
                netCap.allowedPorts.push(portNum);
              }
            }
          } catch {
            // Not a full URL string, could be host or template
            if (typeof urlStr === "string" && urlStr.includes(".") && !urlStr.includes("/")) {
              if (!netCap.allowedHosts.includes(urlStr)) {
                netCap.allowedHosts.push(urlStr);
              }
            }
          }
        }
      }

      // 3. Command capabilities
      if (
        service === "cmd" ||
        action.startsWith("cmd.") ||
        action.includes("exec") ||
        toolClass === "command" ||
        toolClass === "test_runner" ||
        toolClass === "build_tool" ||
        toolClass === "vcs"
      ) {
        needsCmd = true;
        const commandVal = step.inputs.command ?? step.inputs.cmd ?? step.inputs.binary;
        if (typeof commandVal === "string" && commandVal.trim().length > 0) {
          const fullCmd = commandVal.trim();
          const binary = fullCmd.split(/\s+/)[0];
          if (binary && !cmdCap.allowedBinaries.includes(binary)) {
            cmdCap.allowedBinaries.push(binary);
          }
          if (fullCmd && !cmdCap.allowedCommands.includes(fullCmd)) {
            cmdCap.allowedCommands.push(fullCmd);
          }
          if (binary && !cmdCap.allowedCommands.includes(binary)) {
            cmdCap.allowedCommands.push(binary);
          }
        }
      }

      // 4. Secret references
      if (
        service === "secret" ||
        action.startsWith("secret.") ||
        action.includes("secret") ||
        toolClass === "secret_access" ||
        toolClass === "secrets" ||
        step.inputs.secretName ||
        step.inputs.requiredSecrets ||
        (action.includes("secret") && step.inputs.name)
      ) {
        needsSecrets = true;
        const secretName =
          step.inputs.secretName ??
          step.inputs.secret ??
          (action.includes("secret") || toolClass === "secrets" ? step.inputs.name : undefined);
        if (typeof secretName === "string" && secretName.trim().length > 0) {
          const name = secretName.trim();
          if (!secretCap.allowedSecretNames.includes(name)) {
            secretCap.allowedSecretNames.push(name);
          }
        }
        if (Array.isArray(step.inputs.requiredSecrets)) {
          for (const s of step.inputs.requiredSecrets) {
            if (typeof s === "string" && !secretCap.allowedSecretNames.includes(s)) {
              secretCap.allowedSecretNames.push(s);
            }
          }
        }
      }
    }
    if (needsFs && fsCap.readPaths.length === 0 && fsCap.writePaths.length === 0) {
      fsCap.readPaths.push(".");
      fsCap.allowWorkspaceRoot = true;
    }

    let manifest: CapabilityManifest = {
      fs: fsCap,
      net: netCap,
      command: cmdCap,
      secrets: secretCap,
      limits,
    };

    manifest = this.minimizeCapabilities(manifest, envelope);
    return CapabilityManifestSchema.parse(manifest);
  }

  /**
   * Derives minimal capabilities from explicit inputs and options.
   */
  mapBrokeredCapabilities(options: {
    steps?: WorkflowStep[];
    fsPaths?: { read?: string[]; write?: string[] };
    netHosts?: string[];
    netUrls?: string[];
    commands?: string[];
    secrets?: string[];
    envelope?: CapabilityEnvelope;
  }): CapabilityManifest {
    const manifest = this.mapRequiredCapabilities(options.steps ?? [], options.envelope);

    if (options.fsPaths?.read) {
      for (const p of options.fsPaths.read) {
        if (!manifest.fs.readPaths.includes(p)) manifest.fs.readPaths.push(p);
      }
    }
    if (options.fsPaths?.write) {
      for (const p of options.fsPaths.write) {
        if (!manifest.fs.writePaths.includes(p)) manifest.fs.writePaths.push(p);
      }
    }
    if (options.netHosts) {
      for (const h of options.netHosts) {
        if (!manifest.net.allowedHosts.includes(h)) manifest.net.allowedHosts.push(h);
        if (!manifest.net.allowedDomains.includes(h)) manifest.net.allowedDomains.push(h);
      }
      if (options.netHosts.length > 0) manifest.net.allowOutbound = true;
    }
    if (options.netUrls) {
      for (const u of options.netUrls) {
        try {
          const parsed = new URL(u);
          if (parsed.hostname && !manifest.net.allowedHosts.includes(parsed.hostname)) {
            manifest.net.allowedHosts.push(parsed.hostname);
          }
          if (parsed.hostname && !manifest.net.allowedDomains.includes(parsed.hostname)) {
            manifest.net.allowedDomains.push(parsed.hostname);
          }
        } catch {
          // ignore
        }
      }
      if (options.netUrls.length > 0) manifest.net.allowOutbound = true;
    }
    if (options.commands) {
      for (const c of options.commands) {
        const bin = c.trim().split(/\s+/)[0];
        if (bin && !manifest.command.allowedCommands.includes(bin)) {
          manifest.command.allowedCommands.push(bin);
        }
        if (bin && !manifest.command.allowedBinaries.includes(bin)) {
          manifest.command.allowedBinaries.push(bin);
        }
      }
    }
    if (options.secrets) {
      for (const s of options.secrets) {
        if (!manifest.secrets.allowedSecretNames.includes(s)) {
          manifest.secrets.allowedSecretNames.push(s);
        }
      }
    }

    return this.minimizeCapabilities(manifest, options.envelope);
  }

  /**
   * Validates if a capability manifest is a strict subset of the given capability envelope.
   */
  validateSubset(
    manifest: CapabilityManifest,
    envelope: CapabilityEnvelope,
  ): { valid: boolean; violations: string[] } {
    const violations: string[] = [];

    // 1. Filesystem subset validation
    if (manifest.fs.allowWorkspaceRoot && !envelope.fs.allowWorkspaceRoot) {
      violations.push("Manifest requests allowWorkspaceRoot but envelope strictly forbids it.");
    }
    if (manifest.fs.allowTemp && !envelope.fs.allowTemp) {
      violations.push("Manifest requests allowTemp but envelope strictly forbids it.");
    }
    if (manifest.fs.maxFileSizeBytes > envelope.fs.maxFileSizeBytes) {
      violations.push(
        `Manifest maxFileSizeBytes (${manifest.fs.maxFileSizeBytes}) exceeds envelope limit (${envelope.fs.maxFileSizeBytes}).`,
      );
    }

    // Deny paths check
    for (const denyPath of envelope.fs.denyPaths) {
      for (const readPath of manifest.fs.readPaths) {
        if (this.pathMatches(readPath, denyPath)) {
          violations.push(
            `Manifest read path '${readPath}' matches envelope deny path '${denyPath}'.`,
          );
        }
      }
      for (const writePath of manifest.fs.writePaths) {
        if (this.pathMatches(writePath, denyPath)) {
          violations.push(
            `Manifest write path '${writePath}' matches envelope deny path '${denyPath}'.`,
          );
        }
      }
    }

    // Read paths containment
    if (envelope.fs.readPaths.length > 0) {
      for (const readPath of manifest.fs.readPaths) {
        const allowed = envelope.fs.readPaths.some((ep) => this.pathCovers(ep, readPath));
        if (!allowed && !(envelope.fs.allowWorkspaceRoot && !readPath.startsWith("/"))) {
          violations.push(
            `Manifest read path '${readPath}' is not permitted by envelope read paths.`,
          );
        }
      }
    }

    // Write paths containment
    if (manifest.fs.writePaths.length > 0) {
      if (
        envelope.fs.writePaths.length === 0 &&
        !envelope.fs.allowWorkspaceRoot &&
        !envelope.fs.allowTemp
      ) {
        violations.push("Manifest requests writePaths but envelope allows no write operations.");
      } else if (envelope.fs.writePaths.length > 0) {
        for (const writePath of manifest.fs.writePaths) {
          const allowed = envelope.fs.writePaths.some((ep) => this.pathCovers(ep, writePath));
          if (!allowed && !(envelope.fs.allowWorkspaceRoot && !writePath.startsWith("/"))) {
            violations.push(
              `Manifest write path '${writePath}' is not permitted by envelope write paths.`,
            );
          }
        }
      }
    }

    // 2. Network subset validation
    if (manifest.net.allowOutbound && !envelope.net.allowOutbound) {
      violations.push(
        "Manifest requests outbound network access but envelope strictly forbids outbound network.",
      );
    }
    if (manifest.net.allowLocalhost && !envelope.net.allowLocalhost) {
      violations.push(
        "Manifest requests localhost network access but envelope strictly forbids it.",
      );
    }
    if (!manifest.net.denyPrivateRanges && envelope.net.denyPrivateRanges) {
      violations.push("Manifest disables denyPrivateRanges but envelope requires it.");
    }

    // Allowed hosts & domains containment
    const envHosts = [...envelope.net.allowedHosts, ...envelope.net.allowedDomains];
    if (manifest.net.allowOutbound && envHosts.length > 0) {
      for (const host of manifest.net.allowedHosts) {
        const allowed = envHosts.some((eh) => this.hostMatches(host, eh));
        if (!allowed) {
          violations.push(`Manifest host '${host}' is not in envelope allowed hosts/domains.`);
        }
      }
      for (const domain of manifest.net.allowedDomains) {
        const allowed = envHosts.some((eh) => this.hostMatches(domain, eh));
        if (!allowed) {
          violations.push(`Manifest domain '${domain}' is not in envelope allowed hosts/domains.`);
        }
      }
    } else if (manifest.net.allowOutbound && envHosts.length === 0 && !envelope.net.allowOutbound) {
      violations.push(
        "Manifest requests outbound network access with hosts but envelope specifies no allowed hosts.",
      );
    }

    // Protocols containment
    for (const proto of manifest.net.allowedProtocols) {
      if (!envelope.net.allowedProtocols.includes(proto)) {
        violations.push(`Manifest protocol '${proto}' is not permitted by envelope.`);
      }
    }

    // Ports containment
    if (envelope.net.allowedPorts.length > 0) {
      for (const port of manifest.net.allowedPorts) {
        if (!envelope.net.allowedPorts.includes(port)) {
          violations.push(`Manifest port '${port}' is not permitted by envelope.`);
        }
      }
    }

    // 3. Command execution containment
    if (manifest.command.allowShellExecution && !envelope.command.allowShellExecution) {
      violations.push(
        "Candidate requests shell execution but envelope strictly forbids shell execution",
      );
    }

    const envCmds = [...envelope.command.allowedCommands, ...envelope.command.allowedBinaries];
    if (
      manifest.command.allowedCommands.length > 0 ||
      manifest.command.allowedBinaries.length > 0
    ) {
      if (envCmds.length === 0 && !envelope.command.allowShellExecution) {
        violations.push(
          "Manifest requests command execution but envelope permits no commands or binaries.",
        );
      } else if (envCmds.length > 0) {
        for (const cmd of manifest.command.allowedCommands) {
          if (!envCmds.includes(cmd)) {
            violations.push(
              `Manifest command '${cmd}' is not permitted by envelope allowed commands.`,
            );
          }
        }
        for (const bin of manifest.command.allowedBinaries) {
          if (!envCmds.includes(bin)) {
            violations.push(
              `Manifest binary '${bin}' is not permitted by envelope allowed binaries.`,
            );
          }
        }
      }
    }

    // 4. Secrets containment
    if (!manifest.secrets.denyDirectRead && envelope.secrets.denyDirectRead) {
      violations.push("Manifest allows direct secret reads but envelope strictly forbids it.");
    }

    const envSecrets = envelope.secrets.allowedSecretNames;
    const envPrefixes = envelope.secrets.allowedPrefixes;
    if (manifest.secrets.allowedSecretNames.length > 0) {
      if (envSecrets.length === 0 && envPrefixes.length === 0) {
        violations.push("Manifest requests secret access but envelope grants no secrets.");
      } else {
        for (const sec of manifest.secrets.allowedSecretNames) {
          const allowed = envSecrets.includes(sec) || envPrefixes.some((p) => sec.startsWith(p));
          if (!allowed) {
            violations.push(
              `Manifest secret '${sec}' is not in envelope allowed secrets or prefixes.`,
            );
          }
        }
      }
    }

    // 5. Limits containment
    if (manifest.limits.maxExecutionTimeMs > envelope.limits.maxExecutionTimeMs) {
      violations.push(
        `Manifest maxExecutionTimeMs (${manifest.limits.maxExecutionTimeMs}) exceeds envelope limit (${envelope.limits.maxExecutionTimeMs}).`,
      );
    }
    if (manifest.limits.maxMemoryMb > envelope.limits.maxMemoryMb) {
      violations.push(
        `Manifest maxMemoryMb (${manifest.limits.maxMemoryMb}) exceeds envelope limit (${envelope.limits.maxMemoryMb}).`,
      );
    }
    if (manifest.limits.maxOutputSizeBytes > envelope.limits.maxOutputSizeBytes) {
      violations.push(
        `Manifest maxOutputSizeBytes (${manifest.limits.maxOutputSizeBytes}) exceeds envelope limit (${envelope.limits.maxOutputSizeBytes}).`,
      );
    }

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  /**
   * Helper returning boolean whether manifest is a subset of envelope.
   */
  isSubsetOfEnvelope(manifest: CapabilityManifest, envelope: CapabilityEnvelope): boolean {
    return this.validateSubset(manifest, envelope).valid;
  }

  /**
   * Minimizes a capability manifest by deduplicating and constraining to envelope.
   */
  minimizeCapabilities(
    manifest: CapabilityManifest,
    envelope?: CapabilityEnvelope,
  ): CapabilityManifest {
    const fs: FsCapability = {
      readPaths: Array.from(new Set(manifest.fs.readPaths)).sort(),
      writePaths: Array.from(new Set(manifest.fs.writePaths)).sort(),
      allowWorkspaceRoot: manifest.fs.allowWorkspaceRoot,
      allowTemp: manifest.fs.allowTemp,
      denyPaths: Array.from(new Set(manifest.fs.denyPaths)).sort(),
      maxFileSizeBytes: manifest.fs.maxFileSizeBytes,
    };

    const net: NetCapability = {
      allowOutbound: manifest.net.allowOutbound,
      allowedDomains: Array.from(new Set(manifest.net.allowedDomains)).sort(),
      allowedHosts: Array.from(new Set(manifest.net.allowedHosts)).sort(),
      allowedPorts: Array.from(new Set(manifest.net.allowedPorts)).sort(),
      allowedProtocols: Array.from(new Set(manifest.net.allowedProtocols)),
      allowLocalhost: manifest.net.allowLocalhost,
      denyPrivateRanges: manifest.net.denyPrivateRanges,
    };

    const command: CommandCapability = {
      allowShellExecution: manifest.command.allowShellExecution,
      allowedCommands: Array.from(new Set(manifest.command.allowedCommands)).sort(),
      allowedBinaries: Array.from(new Set(manifest.command.allowedBinaries)).sort(),
      forbiddenPatterns: Array.from(new Set(manifest.command.forbiddenPatterns)).sort(),
      allowEnvPassthrough: Array.from(new Set(manifest.command.allowEnvPassthrough)).sort(),
    };

    const secrets: SecretCapability = {
      allowedSecretNames: Array.from(new Set(manifest.secrets.allowedSecretNames)).sort(),
      allowedPrefixes: Array.from(new Set(manifest.secrets.allowedPrefixes)).sort(),
      denyDirectRead: true, // Always enforce non-disclosing secret model
      injectAsEnv: manifest.secrets.injectAsEnv,
    };

    const limits: CapabilityLimits = { ...manifest.limits };

    // Constrain by envelope if provided
    if (envelope) {
      if (!envelope.fs.allowWorkspaceRoot) fs.allowWorkspaceRoot = false;
      if (!envelope.fs.allowTemp) fs.allowTemp = false;
      fs.maxFileSizeBytes = Math.min(fs.maxFileSizeBytes, envelope.fs.maxFileSizeBytes);

      if (!envelope.net.allowOutbound) {
        net.allowOutbound = false;
        net.allowedHosts = [];
        net.allowedDomains = [];
      }
      if (!envelope.net.allowLocalhost) net.allowLocalhost = false;
      if (envelope.net.denyPrivateRanges) net.denyPrivateRanges = true;

      if (!envelope.command.allowShellExecution) command.allowShellExecution = false;
      const allowedCmds = [
        ...envelope.command.allowedCommands,
        ...envelope.command.allowedBinaries,
      ];
      if (allowedCmds.length > 0) {
        const filteredCmds = command.allowedCommands.filter((c) =>
          allowedCmds.some((ec) => ec === c || c.startsWith(`${ec} `) || ec.startsWith(`${c} `)),
        );
        const filteredBins = command.allowedBinaries.filter((b) =>
          allowedCmds.some((ec) => ec === b || ec.startsWith(`${b} `)),
        );
        if (filteredCmds.length > 0 || filteredBins.length > 0) {
          command.allowedCommands = filteredCmds;
          command.allowedBinaries = filteredBins;
        } else if (
          manifest.command.allowedCommands.length > 0 ||
          manifest.command.allowedBinaries.length > 0
        ) {
          command.allowedCommands = [...envelope.command.allowedCommands];
          command.allowedBinaries = [...envelope.command.allowedBinaries];
        }
      }
      limits.maxMemoryMb = Math.min(limits.maxMemoryMb, envelope.limits.maxMemoryMb);
      limits.maxOutputSizeBytes = Math.min(
        limits.maxOutputSizeBytes,
        envelope.limits.maxOutputSizeBytes,
      );
    }

    return CapabilityManifestSchema.parse({
      fs,
      net,
      command,
      secrets,
      limits,
    });
  }

  /**
   * Computes structural difference between two capability manifests.
   */
  computeCapabilityDiff(before: CapabilityManifest, after: CapabilityManifest): CapabilityDiff {
    const beforeReadPaths = new Set(before.fs.readPaths);
    const afterReadPaths = new Set(after.fs.readPaths);
    const addedReadPaths = Array.from(afterReadPaths).filter(
      (p) =>
        !beforeReadPaths.has(p) &&
        !Array.from(beforeReadPaths).some((bp) => this.pathCovers(bp, p)),
    );
    const removedReadPaths = Array.from(beforeReadPaths).filter((p) => !afterReadPaths.has(p));

    const beforeWritePaths = new Set(before.fs.writePaths);
    const afterWritePaths = new Set(after.fs.writePaths);
    const addedWritePaths = Array.from(afterWritePaths).filter(
      (p) =>
        !beforeWritePaths.has(p) &&
        !Array.from(beforeWritePaths).some((bp) => this.pathCovers(bp, p)),
    );
    const removedWritePaths = Array.from(beforeWritePaths).filter((p) => !afterWritePaths.has(p));
    const beforeHosts = new Set(before.net.allowedHosts);
    const afterHosts = new Set(after.net.allowedHosts);
    const addedHosts = Array.from(afterHosts).filter((h) => !beforeHosts.has(h));
    const removedHosts = Array.from(beforeHosts).filter((h) => !afterHosts.has(h));

    const beforeUrls = new Set(before.net.allowedDomains);
    const afterUrls = new Set(after.net.allowedDomains);
    const addedUrls = Array.from(afterUrls).filter((u) => !beforeUrls.has(u));
    const removedUrls = Array.from(beforeUrls).filter((u) => !afterUrls.has(u));

    const beforeMethods = new Set(before.net.allowedProtocols);
    const afterMethods = new Set(after.net.allowedProtocols);
    const addedMethods = Array.from(afterMethods).filter((m) => !beforeMethods.has(m));
    const removedMethods = Array.from(beforeMethods).filter((m) => !afterMethods.has(m));

    const beforeCmds = new Set(before.command.allowedCommands);
    const afterCmds = new Set(after.command.allowedCommands);
    const addedCommands = Array.from(afterCmds).filter((c) => !beforeCmds.has(c));
    const removedCommands = Array.from(beforeCmds).filter((c) => !afterCmds.has(c));

    const beforeSecs = new Set(before.secrets.allowedSecretNames);
    const afterSecs = new Set(after.secrets.allowedSecretNames);
    const addedSecrets = Array.from(afterSecs).filter((s) => !beforeSecs.has(s));
    const removedSecrets = Array.from(beforeSecs).filter((s) => !afterSecs.has(s));

    const summary: string[] = [];
    if (addedReadPaths.length > 0) summary.push(`+fs.readPaths: ${addedReadPaths.join(", ")}`);
    if (removedReadPaths.length > 0) summary.push(`-fs.readPaths: ${removedReadPaths.join(", ")}`);
    if (addedWritePaths.length > 0) summary.push(`+fs.writePaths: ${addedWritePaths.join(", ")}`);
    if (removedWritePaths.length > 0)
      summary.push(`-fs.writePaths: ${removedWritePaths.join(", ")}`);
    if (addedHosts.length > 0) summary.push(`+net.hosts: ${addedHosts.join(", ")}`);
    if (removedHosts.length > 0) summary.push(`-net.hosts: ${removedHosts.join(", ")}`);
    if (addedCommands.length > 0) summary.push(`+command: ${addedCommands.join(", ")}`);
    if (removedCommands.length > 0) summary.push(`-command: ${removedCommands.join(", ")}`);
    if (addedSecrets.length > 0) summary.push(`+secrets: ${addedSecrets.join(", ")}`);
    if (removedSecrets.length > 0) summary.push(`-secrets: ${removedSecrets.join(", ")}`);

    const isBroadening =
      addedReadPaths.length > 0 ||
      addedWritePaths.length > 0 ||
      addedHosts.length > 0 ||
      addedUrls.length > 0 ||
      addedMethods.length > 0 ||
      addedCommands.length > 0 ||
      addedSecrets.length > 0 ||
      (!before.fs.allowWorkspaceRoot && after.fs.allowWorkspaceRoot) ||
      (!before.fs.allowTemp && after.fs.allowTemp) ||
      (!before.net.allowOutbound && after.net.allowOutbound) ||
      (!before.command.allowShellExecution && after.command.allowShellExecution) ||
      after.limits.maxExecutionTimeMs > before.limits.maxExecutionTimeMs ||
      after.limits.maxMemoryMb > before.limits.maxMemoryMb ||
      after.limits.maxOutputSizeBytes > before.limits.maxOutputSizeBytes;

    const hasChanges =
      summary.length > 0 ||
      before.fs.allowWorkspaceRoot !== after.fs.allowWorkspaceRoot ||
      before.fs.allowTemp !== after.fs.allowTemp ||
      before.net.allowOutbound !== after.net.allowOutbound ||
      before.command.allowShellExecution !== after.command.allowShellExecution;

    return {
      hasChanges,
      isBroadening,
      fs: {
        addedReadPaths,
        removedReadPaths,
        addedWritePaths,
        removedWritePaths,
        workspaceRootChanged: before.fs.allowWorkspaceRoot !== after.fs.allowWorkspaceRoot,
        tempChanged: before.fs.allowTemp !== after.fs.allowTemp,
      },
      net: {
        addedHosts,
        removedHosts,
        addedUrls,
        removedUrls,
        addedMethods,
        removedMethods,
        outboundChanged: before.net.allowOutbound !== after.net.allowOutbound,
      },
      command: {
        addedCommands,
        removedCommands,
        shellChanged: before.command.allowShellExecution !== after.command.allowShellExecution,
      },
      secrets: {
        addedSecrets,
        removedSecrets,
        addedModes: [],
        removedModes: [],
      },
      summary,
    };
  }

  /**
   * Helper returning whether 'after' is broader in permissions than 'before'.
   */
  isBroadening(before: CapabilityManifest, after: CapabilityManifest): boolean {
    return this.computeCapabilityDiff(before, after).isBroadening;
  }

  private pathMatches(p1: string, p2: string): boolean {
    const norm1 = p1.replace(/^\.\//, "").replace(/\/$/, "");
    const norm2 = p2.replace(/^\.\//, "").replace(/\/$/, "");
    return norm1 === norm2 || norm1.startsWith(`${norm2}/`) || norm2.startsWith(`${norm1}/`);
  }

  private pathCovers(envelopePath: string, manifestPath: string): boolean {
    if (envelopePath === "*" || envelopePath === ".") return true;
    const normEnv = envelopePath.replace(/^\.\//, "").replace(/\/$/, "");
    const normMan = manifestPath.replace(/^\.\//, "").replace(/\/$/, "");
    return normMan === normEnv || normMan.startsWith(`${normEnv}/`);
  }

  private hostMatches(host: string, pattern: string): boolean {
    if (pattern === "*" || pattern === host) return true;
    if (pattern.startsWith("*.")) {
      const rootDomain = pattern.slice(2);
      return host === rootDomain || host.endsWith(`.${rootDomain}`);
    }
    return false;
  }

  private extractUrls(val: unknown): string[] {
    const urls: string[] = [];
    if (!val) return urls;
    if (Array.isArray(val)) {
      for (const item of val) {
        urls.push(...this.extractUrls(item));
      }
    } else if (typeof val === "string") {
      const matches = val.match(/https?:\/\/[^\s"',]+/g);
      if (matches) {
        urls.push(...matches);
      } else if (val.trim().length > 0) {
        urls.push(val.trim());
      }
    } else if (typeof val === "object") {
      for (const nestedVal of Object.values(val as Record<string, unknown>)) {
        urls.push(...this.extractUrls(nestedVal));
      }
    }
    return urls;
  }
}
