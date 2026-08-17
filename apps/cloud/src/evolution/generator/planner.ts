import { randomUUID } from "node:crypto";
import { CapabilityEnvelope, ToolRuntimeRequirement } from "@tool-evolver/contracts";
import { OpportunityDetection, WorkflowCluster } from "../opportunity/types.js";
import { CapabilityMapper } from "./capability-mapper.js";
import { SchemaGenerator } from "./schema-generator.js";
import {
  InvariantInputDefinition,
  ToolPlan,
  VariableInputDefinition,
  WorkflowStep,
} from "./types.js";

/**
 * Options for candidate planning.
 */
export interface PlannerOptions {
  envelope?: CapabilityEnvelope;
  cluster?: WorkflowCluster;
  targetType?: "single_tool" | "workflow";
  forceWorkflow?: boolean;
}

/**
 * Candidate planner converting OpportunityDetection into structured ToolPlan.
 */
export class CandidatePlanner {
  private readonly schemaGenerator: SchemaGenerator;
  private readonly capabilityMapper: CapabilityMapper;

  constructor(
    schemaGenerator?: SchemaGenerator,
    capabilityMapper?: CapabilityMapper
  ) {
    this.schemaGenerator = schemaGenerator ?? new SchemaGenerator();
    this.capabilityMapper = capabilityMapper ?? new CapabilityMapper();
  }

  /**
   * Plans a candidate tool or workflow from an opportunity detection record.
   */
  plan(opportunity: OpportunityDetection, options: PlannerOptions = {}): ToolPlan {
    const classification = opportunity.classification;
    const taskClass = classification.taskClass;

    // 1. Determine targetType: single_tool vs workflow
    const isMultiStep =
      options.targetType === "workflow" ||
      options.forceWorkflow === true ||
      taskClass === "multi_step" ||
      taskClass === "multi_step_workflow" ||
      classification.pattern.includes("->") ||
      classification.pattern.includes("chained");

    const targetType: "single_tool" | "workflow" = isMultiStep ? "workflow" : "single_tool";

    // 2. Derive sanitized name and description
    const rawName =
      classification.suggestedToolName ??
      classification.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    const name = this.sanitizeIdentifier(rawName || `tool_${opportunity.id.slice(0, 8)}`);
    const intent = classification.title || "Automate repetitive developer workflow";
    const description = classification.description || `Tool automatically synthesized for pattern ${classification.pattern}`;

    // 3. Extract variable and invariant inputs
    const { variableInputs, invariantInputs } = this.extractInputs(opportunity);

    // 4. Construct workflow steps
    const steps = this.constructSteps(opportunity, targetType, variableInputs);

    // 5. Derive schemas
    const inputSchema = this.schemaGenerator.deriveInputSchema(variableInputs);
    const outputSchema = this.schemaGenerator.deriveOutputSchema(
      classification.candidateOutputSchema,
      steps,
      targetType
    );

    // 6. Map required capabilities
    const capabilityRequirements = this.capabilityMapper.mapRequiredCapabilities(
      steps,
      options.envelope
    );

    // 7. Define runtime requirements
    const runtime: ToolRuntimeRequirement = {
      runtime: "node",
      minRuntimeVersion: "20.0.0",
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    };

    return {
      id: `plan-${randomUUID()}`,
      opportunityId: opportunity.id,
      workspaceId: opportunity.workspaceId,
      targetType,
      intent,
      name,
      description,
      variableInputs,
      invariantInputs,
      inputSchema,
      outputSchema,
      steps,
      capabilityRequirements,
      runtime,
      metadata: {
        pattern: classification.pattern,
        confidenceScore: classification.confidenceScore,
        priority: classification.priority,
        triggerReason: opportunity.triggerReason,
      },
      createdAt: new Date().toISOString(),
    };
  }

  private extractInputs(opportunity: OpportunityDetection): {
    variableInputs: VariableInputDefinition[];
    invariantInputs: InvariantInputDefinition[];
  } {
    const variableInputs: VariableInputDefinition[] = [];
    const invariantInputs: InvariantInputDefinition[] = [];

    const inferred = opportunity.classification.inferredInputs ?? [];
    if (inferred.length > 0) {
      for (const inf of inferred) {
        let type: VariableInputDefinition["type"] = "string";
        if (inf.type === "number" || inf.type === "boolean" || inf.type === "array" || inf.type === "object") {
          type = inf.type;
        }
        variableInputs.push({
          name: this.sanitizeIdentifier(inf.name),
          type,
          description: inf.description || `Parameter ${inf.name}`,
          required: true,
        });
      }
    } else {
      // Derive default variable inputs based on task class or pattern
      const pattern = opportunity.classification.pattern.toLowerCase();
      if (pattern.includes("file") || pattern.includes("read") || pattern.includes("edit")) {
        variableInputs.push({
          name: "path",
          type: "string",
          description: "Target file path",
          required: true,
        });
      }
      if (pattern.includes("cmd") || pattern.includes("exec") || pattern.includes("command")) {
        variableInputs.push({
          name: "command",
          type: "string",
          description: "Command to execute",
          required: true,
        });
      }
      if (pattern.includes("fetch") || pattern.includes("http") || pattern.includes("api")) {
        variableInputs.push({
          name: "url",
          type: "string",
          description: "Target URL",
          required: true,
        });
      }
      if (variableInputs.length === 0) {
        variableInputs.push({
          name: "inputData",
          type: "string",
          description: "Input payload for tool execution",
          required: false,
          defaultValue: "",
        });
      }
    }

    invariantInputs.push({
      name: "timeoutMs",
      value: 30000,
      description: "Default execution timeout in milliseconds",
    });

    return { variableInputs, invariantInputs };
  }

  private constructSteps(
    opportunity: OpportunityDetection,
    targetType: "single_tool" | "workflow",
    variableInputs: VariableInputDefinition[]
  ): WorkflowStep[] {
    const pattern = opportunity.classification.pattern.toLowerCase();
    const taskClass = opportunity.classification.taskClass.toLowerCase();

    if (targetType === "workflow") {
      // Multi-step workflow construction
      const step1Id = "step_1_inspect";
      const step2Id = "step_2_execute";
      const step3Id = "step_3_verify";

      return [
        {
          id: step1Id,
          name: "Inspect Workspace / Read Preconditions",
          description: "Reads initial state or verifies file existence",
          toolClass: "file_read",
          action: "fs.readFile",
          inputs: {
            path: variableInputs.find((v) => v.name === "path") ? "$input.path" : "package.json",
          },
          dependsOn: [],
          outputVar: "preconditionData",
        },
        {
          id: step2Id,
          name: "Apply Action / Write Modifications",
          description: "Performs primary transformation or write",
          toolClass: "file_edit",
          action: "fs.writeFile",
          inputs: {
            path: variableInputs.find((v) => v.name === "path") ? "$input.path" : "output.tmp",
            content: "synthesized_content",
          },
          dependsOn: [step1Id],
          outputVar: "writeResult",
          compensation: {
            action: "fs.removeFile",
            inputs: {
              path: variableInputs.find((v) => v.name === "path") ? "$input.path" : "output.tmp",
            },
            description: "Rolls back created file on failure",
          },
        },
        {
          id: step3Id,
          name: "Verify Results / Execute Diagnostics",
          description: "Verifies state integrity after transformation",
          toolClass: "command",
          action: "cmd.exec",
          inputs: {
            command: "git status --porcelain",
          },
          dependsOn: [step2Id],
          outputVar: "verificationResult",
        },
      ];
    }

    // Single tool step construction
    let action = "compute";
    let toolClass = "compute";
    const inputs: Record<string, unknown> = {};

    if (pattern.includes("file_read") || pattern.includes("read") || taskClass === "file_read") {
      action = "fs.readFile";
      toolClass = "file_read";
      inputs.path = "$input.path";
    } else if (pattern.includes("file_edit") || pattern.includes("write") || taskClass === "file_edit") {
      action = "fs.writeFile";
      toolClass = "file_edit";
      inputs.path = "$input.path";
      inputs.content = "$input.content";
    } else if (pattern.includes("command") || pattern.includes("exec") || taskClass === "command" || taskClass === "test_runner") {
      action = "cmd.exec";
      toolClass = "command";
      inputs.command = "$input.command";
    } else if (pattern.includes("net") || pattern.includes("fetch") || pattern.includes("http")) {
      action = "net.fetch";
      toolClass = "network";
      inputs.url = "$input.url";
    } else if (pattern.includes("secret") || taskClass === "secrets") {
      action = "secret.getSecret";
      toolClass = "secrets";
      inputs.name = "$input.name";
    }

    return [
      {
        id: "step_main",
        name: opportunity.classification.title || "Execute Main Action",
        description: opportunity.classification.description,
        toolClass,
        action,
        inputs,
        dependsOn: [],
        outputVar: "result",
      },
    ];
  }

  private sanitizeIdentifier(name: string): string {
    const cleaned = name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_");
    return cleaned.length > 0 ? cleaned : "tool";
  }
}
