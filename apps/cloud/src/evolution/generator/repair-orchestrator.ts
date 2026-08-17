import { randomUUID } from "node:crypto";
import { type CapabilityEnvelope, hashCanonical } from "@tool-evolver/contracts";
import { DeterministicSelfReviewer } from "./self-reviewer.js";
import type {
  CandidateGenerationOptions,
  CandidateRevision,
  GeneratedArtifactSet,
  SelfReviewIssue,
} from "./types.js";

/**
 * Result of repair orchestration.
 */
export interface RepairOrchestrationResult {
  revisions: CandidateRevision[];
  activeRevision: CandidateRevision;
  success: boolean;
}

/**
 * Bounded repair orchestrator applying deterministic fixes to self-review failures.
 */
export class RepairOrchestrator {
  private readonly selfReviewer: DeterministicSelfReviewer;

  constructor(selfReviewer?: DeterministicSelfReviewer) {
    this.selfReviewer = selfReviewer ?? new DeterministicSelfReviewer();
  }

  /**
   * Orchestrates self-review and bounded repair iterations up to maxRepairIterations (default: 3).
   */
  orchestrate(
    initialArtifacts: GeneratedArtifactSet,
    candidateId: string,
    options: CandidateGenerationOptions = {},
  ): RepairOrchestrationResult {
    const maxIterations = options.maxRepairIterations ?? 3;
    const envelope = options.envelope;
    const revisions: CandidateRevision[] = [];

    // Iteration 1: Initial revision
    let currentArtifacts: GeneratedArtifactSet = {
      ...initialArtifacts,
      manifest: {
        ...initialArtifacts.manifest,
        digest: initialArtifacts.manifest.digest,
      },
    };

    let reviewVerdict = this.selfReviewer.review(currentArtifacts, envelope);
    const initialRevisionId = `rev-${hashCanonical({
      candidateId,
      sourceDigest: hashCanonical(currentArtifacts.sourceCode),
      manifestDigest: currentArtifacts.manifest.digest,
      iteration: 1,
    }).slice(0, 16)}`;

    let currentRevision: CandidateRevision = {
      revisionId: initialRevisionId,
      candidateId,
      revisionNumber: 1,
      artifacts: currentArtifacts,
      selfReview: reviewVerdict,
      repairHistory: [],
      createdAt: initialArtifacts.generatedAt,
    };
    revisions.push(currentRevision);

    if (reviewVerdict.passed) {
      return {
        revisions,
        activeRevision: currentRevision,
        success: true,
      };
    }

    // Bounded repair iterations
    let iteration = 1;
    while (!reviewVerdict.passed && iteration < maxIterations) {
      iteration++;
      const previousRevisionId = currentRevision.revisionId;
      const errorIssues = reviewVerdict.issues.filter((i) => i.severity === "error");

      const { repairedArtifacts, fixedIssues } = this.applyDeterministicRepairs(
        currentArtifacts,
        errorIssues,
        envelope,
      );

      currentArtifacts = {
        ...repairedArtifacts,
        manifest: {
          ...repairedArtifacts.manifest,
          capabilities: repairedArtifacts.capabilities,
          digest: hashCanonical({
            id: repairedArtifacts.manifest.id,
            name: repairedArtifacts.manifest.name,
            version: repairedArtifacts.manifest.version,
            description: repairedArtifacts.manifest.description,
            parameters: repairedArtifacts.manifest.parameters,
            outputSchema: repairedArtifacts.manifest.outputSchema,
            capabilities: repairedArtifacts.capabilities,
            runtime: repairedArtifacts.manifest.runtime,
          }),
        },
      };

      reviewVerdict = this.selfReviewer.review(currentArtifacts, envelope);

      const nextRevisionId = `rev-${hashCanonical({
        candidateId,
        sourceDigest: hashCanonical(currentArtifacts.sourceCode),
        manifestDigest: currentArtifacts.manifest.digest,
        iteration,
      }).slice(0, 16)}`;

      currentRevision = {
        revisionId: nextRevisionId,
        candidateId,
        revisionNumber: iteration,
        parentRevisionId: previousRevisionId,
        artifacts: currentArtifacts,
        selfReview: reviewVerdict,
        repairHistory: [
          ...currentRevision.repairHistory,
          {
            iteration,
            reason: `Repaired ${fixedIssues.length} issue(s) detected during self-review`,
            fixedIssues,
            timestamp: initialArtifacts.generatedAt,
          },
        ],
        createdAt: initialArtifacts.generatedAt,
      };
      revisions.push(currentRevision);

      if (reviewVerdict.passed) {
        break;
      }
    }

    return {
      revisions,
      activeRevision: currentRevision,
      success: reviewVerdict.passed,
    };
  }

  private applyDeterministicRepairs(
    artifacts: GeneratedArtifactSet,
    errors: SelfReviewIssue[],
    envelope?: CapabilityEnvelope,
  ): { repairedArtifacts: GeneratedArtifactSet; fixedIssues: string[] } {
    let sourceCode = artifacts.sourceCode;
    let capabilities = { ...artifacts.capabilities };
    const plan = { ...artifacts.plan };
    let manifest = { ...artifacts.manifest };
    const fixedIssues: string[] = [];

    for (const error of errors) {
      // 1. Repair missing capabilities
      if (error.category === "capabilities") {
        if (error.message.includes("broker.fs")) {
          capabilities = {
            ...capabilities,
            fs: {
              ...capabilities.fs,
              allowWorkspaceRoot: true,
              allowTemp: true,
              readPaths: capabilities.fs.readPaths.length > 0 ? capabilities.fs.readPaths : ["."],
              writePaths:
                error.message.includes("write") && capabilities.fs.writePaths.length === 0
                  ? ["."]
                  : capabilities.fs.writePaths,
            },
          };
          fixedIssues.push("Granted required filesystem capabilities in manifest");
        }
        if (error.message.includes("broker.cmd")) {
          capabilities = {
            ...capabilities,
            command: {
              ...capabilities.command,
              allowedBinaries:
                capabilities.command.allowedBinaries.length > 0
                  ? capabilities.command.allowedBinaries
                  : ["git", "node", "pnpm", "npm"],
              allowedCommands:
                capabilities.command.allowedCommands.length > 0
                  ? capabilities.command.allowedCommands
                  : ["git status"],
            },
          };
          fixedIssues.push("Declared allowed command binaries in capability manifest");
        }
        if (error.message.includes("broker.net")) {
          capabilities = {
            ...capabilities,
            net: {
              ...capabilities.net,
              allowOutbound: true,
              allowedProtocols: ["https", "http"],
            },
          };
          fixedIssues.push("Enabled outbound network capability in manifest");
        }
        if (error.message.includes("broker.secret")) {
          capabilities = {
            ...capabilities,
            secrets: {
              ...capabilities.secrets,
              allowedSecretNames:
                capabilities.secrets.allowedSecretNames.length > 0
                  ? capabilities.secrets.allowedSecretNames
                  : ["SECRET"],
            },
          };
          fixedIssues.push("Added allowed secret names in capability manifest");
        }
      }

      // 2. Repair illegal imports
      if (error.category === "imports") {
        // Remove direct imports of forbidden modules
        sourceCode = sourceCode.replace(
          /import\s+.*?\s+from\s+["'](?:node:)?(?:fs|child_process|net|http|https|process)["'];?\n?/g,
          "",
        );
        fixedIssues.push("Removed illegal native runtime import statement");
      }

      // 3. Repair missing error handling
      if (error.category === "error_handling") {
        if (!sourceCode.includes("try {")) {
          // Wrap handler body in try/catch block if somehow missing
          sourceCode = sourceCode.replace(
            /export default defineTool<[^>]+>\(async \(context:[^)]+\): Promise<[^>]+> => \{([\s\S]*)\}\);/,
            (match, body) => {
              return `export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;
  try {
${body}
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logger.error("Tool execution failed", { error: errorMessage });
    throw new Error(\`Execution error: \${errorMessage}\`);
  }
});`;
            },
          );
          fixedIssues.push("Wrapped handler body in try/catch error handling block");
        }
      }

      // 4. Repair AST / defineTool wrapper
      if (error.category === "ast") {
        if (!sourceCode.includes("defineTool")) {
          sourceCode = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";\nimport { z } from "zod";\n\n${sourceCode}`;
          fixedIssues.push("Added defineTool and ToolContext SDK imports");
        }
      }
    }

    // Apply envelope boundary clamp
    if (envelope) {
      if (!envelope.command.allowShellExecution) {
        capabilities.command.allowShellExecution = false;
      }
      if (!envelope.net.allowOutbound) {
        capabilities.net.allowOutbound = false;
      }
    }

    manifest = {
      ...manifest,
      capabilities,
    };

    return {
      repairedArtifacts: {
        ...artifacts,
        sourceCode,
        capabilities,
        plan,
        manifest,
      },
      fixedIssues: fixedIssues.length > 0 ? fixedIssues : ["Applied automated manifest alignment"],
    };
  }
}
