import type { CapabilityEnvelope } from "@tool-evolver/contracts";
import {
  type Episode,
  type SuppressionOptions,
  SuppressionReason,
  type SuppressionResult,
  type WorkflowCluster,
} from "./types.js";

const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MIN_MEANINGFUL_STEPS = 2;

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+-(rf|fr|r|f)\s+(\/|~|\*|\.\/|\.\.)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bchmod\s+(-R\s+)?777\s+(\/|~)/i,
  /\b(drop\s+database|truncate\s+table|drop\s+table)\b/i,
  /\bgit\s+(reset\s+--hard|push\s+--force|clean\s+-fdx)\b/i,
  /\b(cat\s+\/etc\/shadow|cat\s+~\/\.ssh\/id_rsa)\b/i,
  /\bshutdown\s+-h\b/i,
  /\breboot\b/i,
];

const TRIVIAL_COMMANDS = new Set([
  "echo",
  "pwd",
  "whoami",
  "hostname",
  "date",
  "true",
  "false",
  "clear",
]);

/**
 * Workflow opportunity suppression engine.
 * Suppresses trivial, out-of-envelope, destructive, unobservable, or cooldown-active workflows.
 */
export class SuppressionEngine {
  private readonly cooldownMs: number;
  private readonly minMeaningfulSteps: number;
  private readonly disallowedCommands: string[];

  constructor(options: SuppressionOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.minMeaningfulSteps = options.minMeaningfulSteps ?? DEFAULT_MIN_MEANINGFUL_STEPS;
    this.disallowedCommands = options.disallowedCommands ?? [];
  }

  getCooldownMs(): number {
    return this.cooldownMs;
  }

  /**
   * Evaluates if a workflow cluster or episode should be suppressed from opportunity creation.
   */
  evaluateSuppression(
    cluster: WorkflowCluster,
    options: {
      envelope?: CapabilityEnvelope;
      recentOpportunityHashes?: Set<string> | Map<string, number>;
      now?: number;
    } = {},
  ): SuppressionResult {
    const now = options.now ?? Date.now();

    // 1. Check Cooldown Window
    if (options.recentOpportunityHashes) {
      const hash = cluster.structuralHash;
      if (options.recentOpportunityHashes instanceof Set) {
        if (options.recentOpportunityHashes.has(hash)) {
          return {
            suppressed: true,
            reason: "in_cooldown",
            details: `Workflow with structural hash ${hash.slice(0, 12)} was recently evaluated and is in cooldown.`,
          };
        }
      } else if (options.recentOpportunityHashes instanceof Map) {
        const lastSeen = options.recentOpportunityHashes.get(hash);
        if (lastSeen && now - lastSeen < this.cooldownMs) {
          const remainingMins = Math.round((this.cooldownMs - (now - lastSeen)) / (60 * 1000));
          return {
            suppressed: true,
            reason: "in_cooldown",
            details: `Workflow is in cooldown for another ${remainingMins} minutes.`,
          };
        }
      }
    }

    // 2. Check Destructive Patterns
    const destructiveCheck = this.checkDestructiveOperations(cluster.episodes);
    if (destructiveCheck.isDestructive) {
      return {
        suppressed: true,
        reason: "destructive",
        details: destructiveCheck.reason,
      };
    }

    // 3. Check Out-of-Envelope (if envelope provided)
    if (options.envelope) {
      const envelopeCheck = this.checkEnvelopeViolation(cluster, options.envelope);
      if (envelopeCheck.violates) {
        return {
          suppressed: true,
          reason: "out_of_envelope",
          details: envelopeCheck.reason,
        };
      }
    }

    // 4. Check Trivial Workflows
    const trivialCheck = this.checkTrivialWorkflow(cluster);
    if (trivialCheck.isTrivial) {
      return {
        suppressed: true,
        reason: "trivial",
        details: trivialCheck.reason,
      };
    }

    // 5. Check Unobservable Workflows
    const unobservableCheck = this.checkUnobservable(cluster);
    if (unobservableCheck.isUnobservable) {
      return {
        suppressed: true,
        reason: "unobservable",
        details: unobservableCheck.reason,
      };
    }

    return {
      suppressed: false,
      reason: "none",
      details: "Workflow is eligible and meets all viability criteria.",
    };
  }

  /**
   * Checks for destructive commands across cluster episodes.
   */
  private checkDestructiveOperations(episodes: Episode[]): {
    isDestructive: boolean;
    reason: string;
  } {
    for (const ep of episodes) {
      for (const evt of ep.events) {
        if (evt.type === "command_exec") {
          const cmd = (evt as unknown as { command?: string }).command ?? "";
          for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
            if (pattern.test(cmd)) {
              return {
                isDestructive: true,
                reason: `Detected destructive command pattern '${cmd}'`,
              };
            }
          }
          for (const disallowed of this.disallowedCommands) {
            if (cmd.includes(disallowed)) {
              return {
                isDestructive: true,
                reason: `Command contains explicitly disallowed string '${disallowed}'`,
              };
            }
          }
        }
      }
    }
    return { isDestructive: false, reason: "" };
  }

  /**
   * Checks if operations exceed capability envelope.
   */
  private checkEnvelopeViolation(
    cluster: WorkflowCluster,
    envelope: CapabilityEnvelope,
  ): { violates: boolean; reason: string } {
    // Check frozen envelope
    if (envelope.isFrozen) {
      return {
        violates: true,
        reason:
          "Capability envelope for this workspace is frozen; new tool synthesis is disallowed.",
      };
    }

    // Check command capability
    if (envelope.command) {
      const allowShellExecution = envelope.command.allowShellExecution;
      const allowedCommands = envelope.command.allowedCommands ?? [];
      const allowedBinaries = envelope.command.allowedBinaries ?? [];
      const forbiddenPatterns = envelope.command.forbiddenPatterns ?? [];

      for (const cmdPattern of cluster.representativeSignature.commandPatterns) {
        const cmdName = cmdPattern.split(":")[0];
        for (const forbidden of forbiddenPatterns) {
          if (cmdPattern.includes(forbidden) || cmdName.includes(forbidden)) {
            return {
              violates: true,
              reason: `Command '${cmdName}' matches forbidden pattern '${forbidden}' in capability envelope.`,
            };
          }
        }
        if (
          !allowShellExecution &&
          allowedCommands.length > 0 &&
          !allowedCommands.includes(cmdName) &&
          !allowedBinaries.includes(cmdName)
        ) {
          return {
            violates: true,
            reason: `Command '${cmdName}' is not permitted by capability envelope command whitelist.`,
          };
        }
      }
    }

    // Check net capability
    if (envelope.net) {
      const allowOutbound = envelope.net.allowOutbound;
      const hasNetClass = cluster.representativeSignature.toolClasses.includes("network");
      if (hasNetClass && !allowOutbound) {
        return {
          violates: true,
          reason: "Network access requested by workflow but allowOutbound is disabled in envelope.",
        };
      }
    }

    // Check fs capability
    if (envelope.fs?.denyPaths && envelope.fs.denyPaths.length > 0) {
      for (const path of cluster.representativeSignature.normalizedPaths) {
        for (const denyPath of envelope.fs.denyPaths) {
          if (path.includes(denyPath)) {
            return {
              violates: true,
              reason: `Filesystem path '${path}' violates denied path '${denyPath}' in envelope.`,
            };
          }
        }
      }
    }

    return { violates: false, reason: "" };
  }

  /**
   * Checks if workflow is trivial (< 2 steps without substantial duration/cost).
   */
  private checkTrivialWorkflow(cluster: WorkflowCluster): { isTrivial: boolean; reason: string } {
    const avgSteps = cluster.metrics.avgStepCount;
    const avgDuration = cluster.metrics.avgDurationMs;

    // Single step check
    if (avgSteps < this.minMeaningfulSteps) {
      // Check if it's a known trivial command
      for (const cmd of cluster.representativeSignature.commandPatterns) {
        const root = cmd.split(":")[0];
        if (TRIVIAL_COMMANDS.has(root)) {
          return {
            isTrivial: true,
            reason: `Single trivial utility command '${root}'`,
          };
        }
      }

      // If duration is very low (< 3s) and single step, consider trivial
      if (avgDuration < 3000 && cluster.metrics.avgTokens < 500) {
        return {
          isTrivial: true,
          reason: `Workflow consists of only ${avgSteps} steps with minimal execution time (${avgDuration}ms)`,
        };
      }
    }

    return { isTrivial: false, reason: "" };
  }

  /**
   * Checks if workflow is unobservable (empty events or missing causal refs).
   */
  private checkUnobservable(cluster: WorkflowCluster): { isUnobservable: boolean; reason: string } {
    if (cluster.evidenceEventIds.length === 0) {
      return {
        isUnobservable: true,
        reason: "Workflow has no associated evidence event IDs.",
      };
    }

    // Verify all episodes have valid timestamps
    for (const ep of cluster.episodes) {
      if (!ep.events || ep.events.length === 0) {
        return {
          isUnobservable: true,
          reason: "Episode contains empty event stream.",
        };
      }
    }

    return { isUnobservable: false, reason: "" };
  }
}

/**
 * Convenience function to evaluate suppression.
 */
export function evaluateSuppression(
  cluster: WorkflowCluster,
  options?: SuppressionOptions & {
    envelope?: CapabilityEnvelope;
    recentOpportunityHashes?: Set<string> | Map<string, number>;
    now?: number;
  },
): SuppressionResult {
  const engine = new SuppressionEngine(options);
  return engine.evaluateSuppression(cluster, options);
}
