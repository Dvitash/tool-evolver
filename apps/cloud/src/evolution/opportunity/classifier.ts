import type { InferenceService } from "../../models/service.js";
import type {
  EpisodeSignature,
  OpportunityClassification,
  OpportunityInferredInput,
  WorkflowCluster,
} from "./types.js";

/**
 * Heuristic generator for opportunity title and pattern when LLM is unavailable or as fallback.
 */
function generateHeuristicClassification(sig: EpisodeSignature): OpportunityClassification {
  const primaryClass = sig.toolClasses[0] || "general";
  const opsSummary = sig.operationSequence.slice(0, 4).join(" -> ");

  let title = `Automate ${primaryClass.replace(/_/g, " ")} workflow`;
  let pattern = `sequential_${primaryClass}`;
  let suggestedToolName = `auto_${primaryClass}`;
  let description = `Recurring sequence of operations: ${opsSummary}.`;

  const inferredInputs: OpportunityInferredInput[] = [];
  const commandProfiles = [...sig.commandPatterns];

  if (sig.normalizedPaths.length > 0) {
    inferredInputs.push({
      name: "targetPaths",
      type: "array",
      description: "Target file or directory paths to operate on.",
      required: true,
    });
  }

  if (sig.toolClasses.includes("vcs")) {
    // VCS candidates execute an observed immutable command profile. Generic paths
    // observed elsewhere in the episode are not parameters unless the profile
    // explicitly supports templating, which the current command contract does not.
    inferredInputs.length = 0;
    const profile = commandProfiles[0] ?? "git status --porcelain";
    title = profile.startsWith("git status")
      ? "Inspect Git Working Tree Status"
      : "Automate Repeated Git Operation";
    pattern = `vcs_${profile.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")}`;
    suggestedToolName = profile.startsWith("git status")
      ? "git_status_checker"
      : "git_operation_helper";
    description = `Executes the observed immutable command profile: ${profile}.`;
  } else if (sig.toolClasses.includes("test_runner")) {
    title = "Automated Test Discovery and Execution";
    pattern = "test_execution_flow";
    suggestedToolName = "run_test_suite";
    description =
      "Executes test runner commands and parses results with automated failure recovery.";
    inferredInputs.push({
      name: "testPattern",
      type: "string",
      description: "Optional test filter or path pattern.",
      required: false,
    });
  } else if (sig.toolClasses.includes("file_edit") && sig.toolClasses.includes("file_read")) {
    title = "Batch File Inspection and Modification";
    pattern = "read_edit_cycle";
    suggestedToolName = "batch_file_modifier";
    description = "Inspects target files and applies structured edits across matching files.";
  } else if (sig.toolClasses.includes("search")) {
    title = "Targeted Codebase Search and Aggregation";
    pattern = "search_and_extract";
    suggestedToolName = "codebase_search_helper";
    description = "Performs structural search and extracts relevant matches.";
  }

  return {
    title,
    description,
    taskClass: primaryClass,
    pattern,
    confidenceScore: 0.85,
    priority: sig.retryCount > 0 || sig.totalDurationMs > 60_000 ? "high" : "medium",
    inferredInputs,
    suggestedToolName,
    commandProfiles,
    candidateOutputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        summary: { type: "string" },
        resultData: { type: "object" },
      },
      required: ["success", "summary"],
    },
  };
}

/**
 * Opportunity classification engine integrating with InferenceService.
 * Invariant: The model cannot change deterministic occurrence counts, distinct session counts,
 * evidence event IDs, metrics, or trigger reasons.
 */
export class OpportunityClassifier {
  constructor(private inferenceService?: InferenceService) {}

  /**
   * Classifies a workflow cluster, enriching it with intent summary, suggested parameters, and schemas.
   */
  async classifyOpportunity(
    tenantId: string,
    cluster: WorkflowCluster,
    triggerReason: string,
  ): Promise<OpportunityClassification> {
    const fallback = generateHeuristicClassification(cluster.representativeSignature);

    if (!this.inferenceService) {
      return fallback;
    }

    try {
      const traceData = cluster.representativeSignature.operationSequence.join("\n");
      const telemetrySummary = JSON.stringify({
        completedOccurrences: cluster.completedOccurrences,
        avgDurationMs: cluster.metrics.avgDurationMs,
        avgTokens: cluster.metrics.avgTokens,
        retries: cluster.metrics.totalRetries,
        triggerReason,
      });

      const response = await this.inferenceService.infer({
        tenantId,
        taskClass: "opportunity_detection",
        promptTemplateId: "opportunity_detection",
        inputs: {
          sessionId: cluster.distinctSessionIds[0] || "session-unknown",
          traceData,
          telemetrySummary,
        },
      });

      const output = response.output as {
        opportunities?: Array<{
          id?: string;
          title?: string;
          description?: string;
          taskClass?: string;
          pattern?: string;
          confidenceScore?: number;
          priority?: "low" | "medium" | "high" | "critical";
          evidence?: string[];
        }>;
      };

      if (output && Array.isArray(output.opportunities) && output.opportunities.length > 0) {
        const opp = output.opportunities[0];
        return {
          title: opp.title || fallback.title,
          description: opp.description || fallback.description,
          taskClass: opp.taskClass || fallback.taskClass,
          pattern: opp.pattern || fallback.pattern,
          confidenceScore:
            typeof opp.confidenceScore === "number"
              ? opp.confidenceScore
              : fallback.confidenceScore,
          priority: opp.priority || fallback.priority,
          inferredInputs: fallback.inferredInputs,
          candidateOutputSchema: fallback.candidateOutputSchema,
          suggestedToolName: fallback.suggestedToolName,
          commandProfiles: fallback.commandProfiles,
          provenance: {
            requestId: response.requestId,
            providerId: response.provenance.providerId,
            model: response.provenance.model,
            promptDigest: response.provenance.promptDigest,
          },
        };
      }

      return fallback;
    } catch {
      // If inference fails, gracefully fall back to heuristic classification
      return fallback;
    }
  }
}

/**
 * Convenience function to classify an opportunity.
 */
export async function classifyOpportunity(
  tenantId: string,
  cluster: WorkflowCluster,
  triggerReason: string,
  inferenceService?: InferenceService,
): Promise<OpportunityClassification> {
  const classifier = new OpportunityClassifier(inferenceService);
  return classifier.classifyOpportunity(tenantId, cluster, triggerReason);
}
