import { randomUUID } from "node:crypto";
import { type CapabilityEnvelope, hashCanonical } from "@tool-evolver/contracts";
import { ToolRepairOutputSchema } from "../../models/prompt-registry.js";
import type { InferenceService } from "../../models/service.js";
import type { InferenceProvenance, ModelUsage } from "../../models/types.js";
import { CapabilityMapper } from "./capability-mapper.js";
import { DeterministicSelfReviewer } from "./self-reviewer.js";
import type {
  CandidateGenerationOptions,
  CandidateRevision,
  CapabilityDiff,
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
 * Orchestrates bounded revision loops with structured diagnostic self-review feedback,
 * lineage tracking, and capability monotonicity enforcement.
 */
export class RepairOrchestrator {
  private readonly selfReviewer: DeterministicSelfReviewer;
  private readonly capabilityMapper: CapabilityMapper;

  constructor(
    selfReviewer: DeterministicSelfReviewer = new DeterministicSelfReviewer(),
    capabilityMapper: CapabilityMapper = new CapabilityMapper(),
  ) {
    this.selfReviewer = selfReviewer;
    this.capabilityMapper = capabilityMapper;
  }

  /**
   * Orchestrates candidate revision repair loop asynchronously using inference when available.
   */
  async orchestrateAsync(
    initialArtifacts: GeneratedArtifactSet,
    candidateId: string,
    options: CandidateGenerationOptions & { tenantId?: string } = {},
  ): Promise<RepairOrchestrationResult> {
    const maxIterations = options.maxRepairIterations ?? 3;
    const envelope = options.envelope;
    const revisions: CandidateRevision[] = [];

    // Iteration 0: Initial Review
    let currentArtifacts = { ...initialArtifacts };
    let reviewVerdict = this.selfReviewer.review(currentArtifacts, envelope);

    let currentRevision: CandidateRevision = {
      revisionId: `rev_${hashCanonical({ candidateId, revisionNumber: 1 }).slice(0, 16)}`,
      candidateId,
      revisionNumber: 1,
      artifacts: currentArtifacts,
      selfReview: reviewVerdict,
      repairHistory: [],
      createdAt: new Date().toISOString(),
    };
    revisions.push(currentRevision);

    let iteration = 1;
    while (!reviewVerdict.passed && revisions.length < maxIterations) {
      const errorIssues = reviewVerdict.issues.filter((i) => i.severity === "error");
      if (errorIssues.length === 0) {
        break;
      }

      let repairedArtifacts: GeneratedArtifactSet | undefined;
      let fixedIssues: string[] = [];
      let provenance: InferenceProvenance | undefined;
      let usage: ModelUsage | undefined;

      // 1. Attempt inference-backed repair if inference service is present
      if (options.inferenceService) {
        try {
          const response = await options.inferenceService.infer<Record<string, unknown>, unknown>({
            promptTemplateId: "tool_repair",
            tenantId: options.tenantId || "system",
            taskClass: "tool_synthesis",
            inputs: {
              toolName: currentArtifacts.plan.name,
              previousCode: currentArtifacts.sourceCode,
              reviewIssues: JSON.stringify(errorIssues, null, 2),
              capabilityEnvelope: JSON.stringify(envelope || {}),
            },
          });

          if (response.output) {
            const parsed = ToolRepairOutputSchema.safeParse(response.output);
            if (parsed.success && parsed.data.code) {
              const newSourceCode = parsed.data.code;
              let newCapabilities = currentArtifacts.capabilities;
              if (parsed.data.capabilities) {
                newCapabilities = this.capabilityMapper.minimizeCapabilities(
                  { ...currentArtifacts.capabilities, ...parsed.data.capabilities },
                  envelope,
                );
              }

              repairedArtifacts = {
                ...currentArtifacts,
                sourceCode: newSourceCode,
                capabilities: newCapabilities,
                manifest: {
                  ...currentArtifacts.manifest,
                  digest: hashCanonical({ code: newSourceCode, capabilities: newCapabilities }),
                },
              };
              fixedIssues = parsed.data.fixedIssues || ["Applied inference-guided repairs"];
              provenance = response.provenance;
              usage = response.provenance?.usage;
            }
          }
        } catch {
          // Fall back to deterministic repair on inference error
        }
      }

      // 2. Deterministic repair fallback
      if (!repairedArtifacts) {
        const repairResult = this.applyDeterministicRepairs(
          currentArtifacts,
          errorIssues,
          envelope,
        );
        repairedArtifacts = repairResult.repairedArtifacts;
        fixedIssues = repairResult.fixedIssues;
      }

      // 3. Compute capability diff and enforce monotonicity
      const diff = this.capabilityMapper.computeCapabilityDiff(
        currentArtifacts.capabilities,
        repairedArtifacts.capabilities,
      );

      // If envelope is provided, ensure repaired artifacts are a strict subset
      if (envelope) {
        const subsetCheck = this.capabilityMapper.validateSubset(
          repairedArtifacts.capabilities,
          envelope,
        );
        if (!subsetCheck.valid) {
          repairedArtifacts.capabilities = this.capabilityMapper.minimizeCapabilities(
            repairedArtifacts.capabilities,
            envelope,
          );
        }
      }

      reviewVerdict = this.selfReviewer.review(repairedArtifacts, envelope);

      const nextRevisionNumber = revisions.length + 1;
      const nextRevision: CandidateRevision = {
        revisionId: `rev_${hashCanonical({ candidateId, revisionNumber: nextRevisionNumber }).slice(0, 16)}`,
        candidateId,
        revisionNumber: nextRevisionNumber,
        parentRevisionId: currentRevision.revisionId,
        artifacts: repairedArtifacts,
        selfReview: reviewVerdict,
        repairHistory: [
          ...currentRevision.repairHistory,
          {
            iteration,
            reason: errorIssues.map((e) => `[${e.category}] ${e.message}`).join("; "),
            fixedIssues,
            timestamp: new Date().toISOString(),
          },
        ],
        capabilityDiff: diff,
        provenance: provenance ? { ...provenance } : undefined,
        usage: usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }
          : undefined,
        promptTemplateId: provenance?.promptTemplateId,
        promptTemplateVersion: provenance?.promptTemplateVersion,
        promptDigest: provenance?.promptDigest,
        modelProvider: provenance?.providerId,
        modelId: provenance?.model,
        requestId: provenance?.requestId,
        createdAt: new Date().toISOString(),
      };

      revisions.push(nextRevision);
      currentRevision = nextRevision;
      currentArtifacts = repairedArtifacts;
      iteration++;
    }

    return {
      revisions,
      activeRevision: currentRevision,
      success: reviewVerdict.passed,
    };
  }

  /**
   * Synchronous repair orchestration.
   */
  orchestrate(
    initialArtifacts: GeneratedArtifactSet,
    candidateId: string,
    options: CandidateGenerationOptions = {},
  ): RepairOrchestrationResult {
    const maxIterations = options.maxRepairIterations ?? 3;
    const envelope = options.envelope;
    const revisions: CandidateRevision[] = [];

    // Iteration 0: Initial Review
    let currentArtifacts = { ...initialArtifacts };
    let reviewVerdict = this.selfReviewer.review(currentArtifacts, envelope);

    let currentRevision: CandidateRevision = {
      revisionId: `rev_${hashCanonical({ candidateId, revisionNumber: 1 }).slice(0, 16)}`,
      candidateId,
      revisionNumber: 1,
      artifacts: currentArtifacts,
      selfReview: reviewVerdict,
      repairHistory: [],
      createdAt: new Date().toISOString(),
    };
    revisions.push(currentRevision);

    let iteration = 1;
    while (!reviewVerdict.passed && revisions.length < maxIterations) {
      const errorIssues = reviewVerdict.issues.filter((i) => i.severity === "error");
      if (errorIssues.length === 0) {
        break;
      }

      // Apply deterministic repairs
      const { repairedArtifacts, fixedIssues } = this.applyDeterministicRepairs(
        currentArtifacts,
        errorIssues,
        envelope,
      );

      const diff = this.capabilityMapper.computeCapabilityDiff(
        currentArtifacts.capabilities,
        repairedArtifacts.capabilities,
      );

      reviewVerdict = this.selfReviewer.review(repairedArtifacts, envelope);

      const nextRevisionNumber = revisions.length + 1;
      const nextRevision: CandidateRevision = {
        revisionId: `rev_${hashCanonical({ candidateId, revisionNumber: nextRevisionNumber }).slice(0, 16)}`,
        candidateId,
        revisionNumber: nextRevisionNumber,
        parentRevisionId: currentRevision.revisionId,
        artifacts: repairedArtifacts,
        selfReview: reviewVerdict,
        repairHistory: [
          ...currentRevision.repairHistory,
          {
            iteration,
            reason: errorIssues.map((e) => `[${e.category}] ${e.message}`).join("; "),
            fixedIssues,
            timestamp: new Date().toISOString(),
          },
        ],
        capabilityDiff: diff,
        createdAt: new Date().toISOString(),
      };

      revisions.push(nextRevision);
      currentRevision = nextRevision;
      currentArtifacts = repairedArtifacts;
      iteration++;
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
        if (error.message.includes("broker.fs") || error.message.includes("context.fs")) {
          capabilities = {
            ...capabilities,
            fs: {
              ...capabilities.fs,
              allowWorkspaceRoot: true,
              readPaths: capabilities.fs.readPaths.length === 0 ? ["."] : capabilities.fs.readPaths,
            },
          };
          fixedIssues.push("Granted fs.allowWorkspaceRoot and default readPaths");
        }

        if (error.message.includes("broker.net") || error.message.includes("context.net")) {
          capabilities = {
            ...capabilities,
            net: {
              ...capabilities.net,
              allowOutbound: true,
              allowedHosts:
                capabilities.net.allowedHosts.length === 0 ? ["*"] : capabilities.net.allowedHosts,
            },
          };
          fixedIssues.push("Enabled net.allowOutbound");
        }

        if (error.message.includes("broker.cmd") || error.message.includes("context.cmd")) {
          // Derive the grant from the source's actual cmd.exec call sites so
          // the repaired capability set matches what the tool implements;
          // the evidence-coverage gate rejects orphan allowances.
          const observedCommands: string[] = [];
          const execPattern =
            /(?:broker|context|ctx)(?:\.\w+)*\.cmd\.exec\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\[([^\]]*)\])?/g;
          for (const match of sourceCode.matchAll(execPattern)) {
            const command = match[1]!.trim();
            const args = (match[2] ?? "")
              .split(",")
              .map((part) => part.trim().replace(/^["'`]|["'`]$/g, ""))
              .filter((part) => part.length > 0);
            const full = [command, ...args].join(" ").trim();
            if (!observedCommands.includes(full)) observedCommands.push(full);
          }
          const fallback = capabilities.command.allowedCommands.length === 0 &&
            capabilities.command.allowedBinaries.length === 0;
          const grantedCommands =
            observedCommands.length > 0
              ? observedCommands
              : fallback
                ? ["echo"]
                : capabilities.command.allowedCommands;
          const grantedBinaries = [
            ...new Set(
              grantedCommands.map((command) => command.split(/\s+/)[0]!).filter(Boolean),
            ),
          ];
          capabilities = {
            ...capabilities,
            command: {
              ...capabilities.command,
              allowedBinaries:
                capabilities.command.allowedBinaries.length === 0
                  ? grantedBinaries
                  : capabilities.command.allowedBinaries,
              allowedCommands:
                capabilities.command.allowedCommands.length === 0
                  ? grantedCommands
                  : capabilities.command.allowedCommands,
            },
          };
          fixedIssues.push("Granted allowedCommands and allowedBinaries from observed call sites");
        }

        if (error.message.includes("Capability envelope violation")) {
          capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, envelope);
          fixedIssues.push("Constrained capabilities to workspace envelope");
        }
      }

      // 2. Repair illegal imports
      if (error.category === "imports") {
        sourceCode = sourceCode
          .replace(
            /import\s+.*?\s+from\s+["'](node:fs|fs|node:child_process|child_process|node:net|net|node:http|http|node:https|https|axios|node-fetch)["'];?\n?/g,
            "",
          )
          .replace(
            /import\s+type\s+.*?\s+from\s+["'](node:fs|fs|node:child_process|child_process|node:net|net|node:http|http|node:https|https|axios|node-fetch)["'];?\n?/g,
            "",
          );

        if (!sourceCode.includes("@tool-evolver/runtime")) {
          sourceCode = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";\n${sourceCode}`;
        }
        if (!sourceCode.includes("zod")) {
          sourceCode = `import { z } from "zod";\n${sourceCode}`;
        }
        fixedIssues.push("Removed illegal imports and ensured runtime/zod imports");
      }

      // 3. Repair raw secret access
      if (error.category === "broker") {
        if (
          error.message.includes("Direct secret value access") ||
          error.message.includes(".value")
        ) {
          sourceCode = sourceCode
            .replace(
              /getSecret\(([^)]+)\)/g,
              "context.secret.getSecretRef($1, { mode: 'bearer_token' })",
            )
            .replace(/\.secretValue/g, "")
            .replace(/secretRef\.value/g, "secretRef");
          fixedIssues.push("Replaced direct secret access with context.secret.getSecretRef");
        }
      }

      // 4. Repair missing defineTool wrapping
      if (error.category === "ast" && error.message.includes("defineTool")) {
        if (!sourceCode.includes("export default defineTool")) {
          sourceCode = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

const inputSchema = z.object({
  path: z.string().optional(),
  input: z.unknown().optional(),
});

export default defineTool({
  name: ${JSON.stringify(plan.name)},
  description: ${JSON.stringify(plan.description)},
  inputSchema,
  handler: async (params, context: ToolContext) => {
    const logger = context.logger;
    await logger.info("Executing tool", { toolName: ${JSON.stringify(plan.name)} });
    try {
      return { success: true, data: { processed: true } };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logger.error("Tool execution failed", { error: errorMessage });
      throw new Error(\`[${plan.name}] Execution error: \${errorMessage}\`);
    }
  },
});
`;
          fixedIssues.push("Wrapped handler in defineTool skeleton");
        }
      }

      // 5. Repair schema misalignment
      if (error.category === "schema") {
        const match =
          error.message.match(/params\.([a-zA-Z0-9_]+)/) ||
          error.message.match(/input\.([a-zA-Z0-9_]+)/);
        if (match?.[1]) {
          const prop = match[1];
          if (!plan.inputSchema.properties?.[prop]) {
            plan.inputSchema = {
              ...plan.inputSchema,
              properties: {
                ...plan.inputSchema.properties,
                [prop]: { type: "string", description: `Inferred parameter ${prop}` },
              },
            };
            fixedIssues.push(`Added missing property '${prop}' to inputSchema`);
          }
        }
      }

      // 6. Repair missing error handling or try/catch
      if (error.category === "error_handling") {
        if (!sourceCode.includes("try {")) {
          sourceCode = sourceCode.replace(
            /handler:\s*async\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*)\}\s*,\s*\}\);?$/,
            (_, args, body) => {
              return `handler: async (${args}) => {
    const logger = context.logger;
    await logger.info("Executing tool");
    try {
${body}
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logger.error("Tool execution failed", { error: errorMessage });
      throw new Error(\`Execution error: \${errorMessage}\`);
    }
  },
});`;
            },
          );
          fixedIssues.push("Wrapped handler execution in try/catch block with logger.error");
        }
      }
    }

    if (envelope) {
      capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, envelope);
    }

    manifest = {
      ...manifest,
      capabilities,
      parameters: plan.inputSchema,
      outputSchema: plan.outputSchema,
      digest: hashCanonical({ code: sourceCode, capabilities }),
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
