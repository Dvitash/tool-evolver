import {
  CapabilityEnvelope,
  CapabilityManifest,
  CapabilityManifestSchema,
  CommandCapability,
  FsCapability,
  NetCapability,
  SecretCapability,
} from "@tool-evolver/contracts";
import { WorkflowStep } from "./types.js";

/**
 * Maps required broker operations and workflow steps to minimal CapabilityManifests.
 */
export class CapabilityMapper {
  /**
   * Maps an array of workflow steps to a minimal CapabilityManifest, optionally constrained by a CapabilityEnvelope.
   */
  mapRequiredCapabilities(
    steps: WorkflowStep[],
    envelope?: CapabilityEnvelope
  ): CapabilityManifest {
    const fsCap: FsCapability = {
      readPaths: [],
      writePaths: [],
      allowWorkspaceRoot: false,
      allowTemp: false,
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

    let needsFs = false;
    let needsNet = false;
    let needsCmd = false;
    let needsSecrets = false;

    for (const step of steps) {
      const action = step.action;
      const toolClass = step.toolClass;

      // 1. Filesystem capabilities
      if (
        action.startsWith("fs.") ||
        toolClass === "file_read" ||
        toolClass === "file_edit" ||
        toolClass === "search"
      ) {
        needsFs = true;
        fsCap.allowWorkspaceRoot = true;
        fsCap.allowTemp = true;

        const pathInputs = this.extractPathInputs(step.inputs);
        if (action === "fs.writeFile" || action === "fs.removeFile" || toolClass === "file_edit") {
          for (const p of pathInputs) {
            if (!fsCap.writePaths.includes(p)) fsCap.writePaths.push(p);
          }
          if (fsCap.writePaths.length === 0) {
            fsCap.writePaths.push(".");
          }
        } else {
          for (const p of pathInputs) {
            if (!fsCap.readPaths.includes(p)) fsCap.readPaths.push(p);
          }
          if (fsCap.readPaths.length === 0) {
            fsCap.readPaths.push(".");
          }
        }
      }

      // Also check compensation for filesystem rollback
      if (step.compensation?.action.startsWith("fs.")) {
        needsFs = true;
        fsCap.allowWorkspaceRoot = true;
        const compPaths = this.extractPathInputs(step.compensation.inputs);
        for (const p of compPaths) {
          if (!fsCap.writePaths.includes(p)) fsCap.writePaths.push(p);
        }
      }

      // 2. Network capabilities
      if (action.startsWith("net.") || toolClass === "network") {
        needsNet = true;
        netCap.allowOutbound = true;

        const urls = this.extractUrlInputs(step.inputs);
        for (const urlStr of urls) {
          try {
            const parsed = new URL(urlStr);
            if (parsed.hostname && !netCap.allowedDomains.includes(parsed.hostname)) {
              netCap.allowedDomains.push(parsed.hostname);
              netCap.allowedHosts.push(parsed.hostname);
            }
            const protocol = parsed.protocol.replace(":", "") as "http" | "https";
            if (["http", "https"].includes(protocol) && !netCap.allowedProtocols.includes(protocol)) {
              netCap.allowedProtocols.push(protocol);
            }
            if (parsed.port) {
              const portNum = Number.parseInt(parsed.port, 10);
              if (!Number.isNaN(portNum) && !netCap.allowedPorts.includes(portNum)) {
                netCap.allowedPorts.push(portNum);
              }
            }
          } catch {
            // Not a full URL string, could be template
          }
        }
      }

      // 3. Command capabilities
      if (
        action.startsWith("cmd.") ||
        toolClass === "command" ||
        toolClass === "test_runner" ||
        toolClass === "build_tool" ||
        toolClass === "vcs"
      ) {
        needsCmd = true;
        const commandVal = step.inputs.command ?? step.inputs.cmd ?? step.inputs.binary;
        if (typeof commandVal === "string" && commandVal.trim().length > 0) {
          const binary = commandVal.trim().split(/\s+/)[0];
          if (binary && !cmdCap.allowedBinaries.includes(binary)) {
            cmdCap.allowedBinaries.push(binary);
          }
          if (!cmdCap.allowedCommands.includes(commandVal.trim())) {
            cmdCap.allowedCommands.push(commandVal.trim());
          }
        }
      }

      // 4. Secret capabilities
      if (action.startsWith("secret.") || toolClass === "secrets") {
        needsSecrets = true;
        const secretName = step.inputs.name ?? step.inputs.secretName ?? step.inputs.key;
        if (typeof secretName === "string" && secretName.length > 0) {
          if (!secretCap.allowedSecretNames.includes(secretName)) {
            secretCap.allowedSecretNames.push(secretName);
          }
        }
      }
    }

    // Apply envelope constraints if envelope is present
    if (envelope) {
      if (envelope.fs) {
        if (!envelope.fs.allowWorkspaceRoot && fsCap.allowWorkspaceRoot) {
          fsCap.allowWorkspaceRoot = false;
        }
        if (!envelope.fs.allowTemp && fsCap.allowTemp) {
          fsCap.allowTemp = false;
        }
        if (envelope.fs.denyPaths && envelope.fs.denyPaths.length > 0) {
          fsCap.denyPaths = Array.from(new Set([...fsCap.denyPaths, ...envelope.fs.denyPaths]));
        }
        if (envelope.fs.maxFileSizeBytes) {
          fsCap.maxFileSizeBytes = Math.min(fsCap.maxFileSizeBytes, envelope.fs.maxFileSizeBytes);
        }
      }

      if (envelope.net) {
        if (!envelope.net.allowOutbound) {
          netCap.allowOutbound = false;
        }
        if (envelope.net.allowedDomains && envelope.net.allowedDomains.length > 0) {
          netCap.allowedDomains = netCap.allowedDomains.filter((d) =>
            envelope.net.allowedDomains.includes(d)
          );
        }
        if (envelope.net.denyPrivateRanges !== undefined) {
          netCap.denyPrivateRanges = envelope.net.denyPrivateRanges;
        }
      }

      if (envelope.command) {
        if (!envelope.command.allowShellExecution) {
          cmdCap.allowShellExecution = false;
        }
        if (envelope.command.forbiddenPatterns && envelope.command.forbiddenPatterns.length > 0) {
          cmdCap.forbiddenPatterns = Array.from(
            new Set([...cmdCap.forbiddenPatterns, ...envelope.command.forbiddenPatterns])
          );
        }
      }
    }

    const manifest: CapabilityManifest = {
      fs: fsCap,
      net: netCap,
      command: cmdCap,
      secrets: secretCap,
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    };

    return CapabilityManifestSchema.parse(manifest);
  }

  private extractPathInputs(inputs: Record<string, unknown>): string[] {
    const paths: string[] = [];
    for (const [key, val] of Object.entries(inputs)) {
      if (
        (key.toLowerCase().includes("path") ||
          key.toLowerCase().includes("file") ||
          key.toLowerCase().includes("dir")) &&
        typeof val === "string" &&
        val.trim().length > 0
      ) {
        paths.push(val.trim());
      }
    }
    return paths;
  }

  private extractUrlInputs(inputs: Record<string, unknown>): string[] {
    const urls: string[] = [];
    for (const [key, val] of Object.entries(inputs)) {
      if (
        (key.toLowerCase().includes("url") ||
          key.toLowerCase().includes("endpoint") ||
          key.toLowerCase().includes("host")) &&
        typeof val === "string" &&
        val.trim().length > 0
      ) {
        urls.push(val.trim());
      }
    }
    return urls;
  }
}
