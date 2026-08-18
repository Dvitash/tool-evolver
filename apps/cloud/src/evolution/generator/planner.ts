import { randomUUID } from "node:crypto";
import type { CapabilityEnvelope, ToolRuntimeRequirement } from "@tool-evolver/contracts";
import {
  type BrokeredToolPlanningOutput,
  BrokeredToolPlanningOutputSchema,
  type CandidatePlanningOutput,
  CandidatePlanningOutputSchema,
} from "../../models/prompt-registry.js";
import type { InferenceService } from "../../models/service.js";
import type { InferenceProvenance } from "../../models/types.js";
import type { OpportunityDetection, WorkflowCluster } from "../opportunity/types.js";
import { CapabilityMapper } from "./capability-mapper.js";
import { SchemaGenerator } from "./schema-generator.js";
import type {
  CandidatePlanningOptions,
  InvariantInputDefinition,
  ToolPlan,
  ToolRuntimeRequirementItem,
  VariableInputDefinition,
  WorkflowStep,
} from "./types.js";
/**
 * Plans tool evolution candidates from detected opportunities using structured inference and deterministic mapping.
 */
export class CandidatePlanner {
  private readonly capabilityMapper: CapabilityMapper;
  private readonly schemaGenerator: SchemaGenerator;

  constructor(
    capabilityMapper: CapabilityMapper = new CapabilityMapper(),
    schemaGenerator: SchemaGenerator = new SchemaGenerator(),
  ) {
    this.capabilityMapper = capabilityMapper;
    this.schemaGenerator = schemaGenerator;
  }

  /**
   * Plans candidate asynchronously (alias).
   */
  async planAsync(
    opportunity: OpportunityDetection,
    options: CandidatePlanningOptions = {},
  ): Promise<ToolPlan> {
    return this.planCandidateAsync(opportunity, options);
  }

  /**
   * Plans candidate synchronously (alias).
   */
  plan(opportunity: OpportunityDetection, options: CandidatePlanningOptions = {}): ToolPlan {
    return this.planCandidate(opportunity, options);
  }

  /**
   * Plans a tool candidate from an opportunity detection asynchronously using inference when available.
   */
  async planCandidateAsync(
    opportunity: OpportunityDetection,
    options: CandidatePlanningOptions = {},
  ): Promise<ToolPlan> {
    const classification = opportunity.classification;
    const taskClass = classification.taskClass.toLowerCase();
    const isWorkflow =
      options.targetType === "workflow" ||
      options.forceWorkflow === true ||
      taskClass === "multi_step" ||
      taskClass === "multi_step_workflow" ||
      classification.pattern.includes("->") ||
      classification.pattern.includes("chained");

    let inferenceOutput: CandidatePlanningOutput | BrokeredToolPlanningOutput | undefined;
    let provenance: InferenceProvenance | undefined;

    // 1. Inference-backed planning if inference service is supplied
    if (options.inferenceService) {
      try {
        const infRes = await options.inferenceService.infer<Record<string, unknown>, unknown>({
          promptTemplateId: "candidate_planning",
          tenantId: options.tenantId || "system",
          taskClass: "candidate_planning",
          inputs: {
            opportunityId: opportunity.id,
            classification: JSON.stringify(classification),
            evidence: JSON.stringify(opportunity.evidenceEventIds || []),
            capabilityEnvelope: JSON.stringify(options.envelope || {}),
          },
        });

        if (infRes.output) {
          const parsed = CandidatePlanningOutputSchema.safeParse(infRes.output);
          if (parsed.success) {
            inferenceOutput = parsed.data;
            provenance = infRes.provenance;
          } else {
            const brokeredParsed = BrokeredToolPlanningOutputSchema.safeParse(infRes.output);
            if (brokeredParsed.success) {
              inferenceOutput = brokeredParsed.data;
              provenance = infRes.provenance;
            }
          }
        }
      } catch {
        // Fallback to deterministic synthesis on inference failure
      }
    }

    // 2. Derive sanitized name and description
    const rawName =
      classification.suggestedToolName ??
      classification.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    const name = this.sanitizeIdentifier(rawName || `tool_${opportunity.id.slice(0, 8)}`);
    const description =
      classification.description ||
      `Synthesized tool for ${classification.title} (${classification.pattern})`;

    // 3. Extract variable and invariant inputs
    const { variableInputs, invariantInputs } = this.extractInputs(opportunity, options.envelope);
    if (
      inferenceOutput &&
      "suggestedInputs" in inferenceOutput &&
      inferenceOutput.suggestedInputs
    ) {
      for (const suggested of inferenceOutput.suggestedInputs) {
        if (!variableInputs.some((v) => v.name === suggested.name)) {
          variableInputs.push({
            name: this.sanitizeIdentifier(suggested.name),
            type: suggested.type as VariableInputDefinition["type"],
            description: suggested.description,
            required: suggested.required,
            defaultValue: suggested.defaultValue,
          });
        }
      }
    } else if (
      inferenceOutput &&
      "variableInputs" in inferenceOutput &&
      inferenceOutput.variableInputs
    ) {
      for (const vInput of inferenceOutput.variableInputs) {
        if (!variableInputs.some((v) => v.name === vInput.name)) {
          variableInputs.push({
            name: this.sanitizeIdentifier(vInput.name),
            type: vInput.type as VariableInputDefinition["type"],
            description: vInput.description,
            required: vInput.required,
            defaultValue: vInput.defaultValue,
          });
        }
      }
    }

    // 4. Construct workflow steps
    const targetType: "single_tool" | "workflow" = isWorkflow ? "workflow" : "single_tool";
    const steps = this.constructSteps(opportunity, targetType, variableInputs, options.envelope);

    // 5. Derive schemas
    const inputSchema = this.schemaGenerator.deriveInputSchema(variableInputs);
    const outputSchema = this.schemaGenerator.deriveOutputSchema(
      classification.candidateOutputSchema,
      steps,
      targetType,
    );

    // 6. Map required capabilities using CapabilityMapper
    let capabilities = this.capabilityMapper.mapRequiredCapabilities(steps, options.envelope);
    if (options.envelope) {
      capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, options.envelope);
    }

    // 7. Derive runtime requirements
    const runtimeRequirements: ToolRuntimeRequirementItem[] = [];
    if (capabilities.fs.readPaths.length > 0 || capabilities.fs.writePaths.length > 0) {
      runtimeRequirements.push({
        type: "permission",
        name: "fs",
        specifier: "deno:fs",
        required: true,
        reason: "Filesystem broker operations",
      });
    }
    if (capabilities.net.allowOutbound) {
      runtimeRequirements.push({
        type: "permission",
        name: "net",
        specifier: "deno:net",
        required: true,
        reason: "Outbound network broker operations",
      });
    }
    if (capabilities.command.allowedCommands.length > 0) {
      runtimeRequirements.push({
        type: "permission",
        name: "cmd",
        specifier: "deno:subprocess",
        required: true,
        reason: "Command execution broker operations",
      });
    }

    // 8. Build complete ToolPlan
    const planId = `plan-${randomUUID()}`;
    const runtime: ToolRuntimeRequirement = {
      runtime: isWorkflow ? "node" : "deno",
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    };

    return {
      id: planId,
      planId,
      opportunityId: opportunity.id,
      workspaceId: options.tenantId || opportunity.workspaceId || "default",
      targetType,
      intent: classification.title || description,
      name,
      description,
      version: options.version || "1.0.0",
      variableInputs,
      invariantInputs,
      steps,
      inputSchema,
      outputSchema,
      capabilities,
      capabilityRequirements: capabilities,
      runtime,
      runtimeRequirements,
      metadata: {
        pattern: classification.pattern,
        confidenceScore: classification.confidenceScore,
        triggerReason: opportunity.triggerReason,
        provenance,
      },
      createdAt: opportunity.createdAt || new Date().toISOString(),
    };
  }

  /**
   * Synchronous planning fallback.
   */
  planCandidate(
    opportunity: OpportunityDetection,
    options: CandidatePlanningOptions = {},
  ): ToolPlan {
    const classification = opportunity.classification;
    const taskClass = classification.taskClass.toLowerCase();
    const isMultiStep =
      options.targetType === "workflow" ||
      options.forceWorkflow === true ||
      taskClass === "multi_step" ||
      taskClass === "multi_step_workflow" ||
      classification.pattern.includes("->") ||
      classification.pattern.includes("chained");

    const targetType: "single_tool" | "workflow" = isMultiStep ? "workflow" : "single_tool";

    const rawName =
      classification.suggestedToolName ??
      classification.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    const name = this.sanitizeIdentifier(rawName || `tool_${opportunity.id.slice(0, 8)}`);
    const description =
      classification.description ||
      `Synthesized tool for ${classification.title} (${classification.pattern})`;

    const { variableInputs, invariantInputs } = this.extractInputs(opportunity, options.envelope);
    const steps = this.constructSteps(opportunity, targetType, variableInputs, options.envelope);

    const inputSchema = this.schemaGenerator.deriveInputSchema(variableInputs);
    const outputSchema = this.schemaGenerator.deriveOutputSchema(
      classification.candidateOutputSchema,
      steps,
      targetType,
    );

    let capabilities = this.capabilityMapper.mapRequiredCapabilities(steps, options.envelope);
    if (options.envelope) {
      capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, options.envelope);
    }

    const runtimeRequirements: ToolRuntimeRequirementItem[] = [];
    if (capabilities.fs.readPaths.length > 0 || capabilities.fs.writePaths.length > 0) {
      runtimeRequirements.push({
        type: "permission",
        name: "fs",
        specifier: "deno:fs",
        required: true,
        reason: "Filesystem broker operations",
      });
    }
    if (capabilities.net.allowOutbound) {
      runtimeRequirements.push({
        type: "permission",
        name: "net",
        specifier: "deno:net",
        required: true,
        reason: "Outbound network broker operations",
      });
    }
    if (capabilities.command.allowedCommands.length > 0) {
      runtimeRequirements.push({
        type: "permission",
        name: "cmd",
        specifier: "deno:subprocess",
        required: true,
        reason: "Command execution broker operations",
      });
    }

    const planId = `plan-${randomUUID()}`;
    const runtime: ToolRuntimeRequirement = {
      runtime: isMultiStep ? "node" : "deno",
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    };

    return {
      id: planId,
      planId,
      opportunityId: opportunity.id,
      workspaceId: options.tenantId || opportunity.workspaceId || "default",
      targetType,
      intent: classification.title || description,
      name,
      description,
      version: options.version || "1.0.0",
      variableInputs,
      invariantInputs,
      steps,
      inputSchema,
      outputSchema,
      capabilities,
      capabilityRequirements: capabilities,
      runtime,
      runtimeRequirements,
      metadata: {
        pattern: classification.pattern,
        confidenceScore: classification.confidenceScore,
        triggerReason: opportunity.triggerReason,
      },
      createdAt: opportunity.createdAt || new Date().toISOString(),
    };
  }

  /**
   * Plans a composite workflow candidate from a cluster of related opportunities.
   */
  planWorkflow(
    cluster: WorkflowCluster,
    opportunities: OpportunityDetection[],
    options: CandidatePlanningOptions = {},
  ): ToolPlan {
    const clusterAny = cluster as unknown as { title?: string; description?: string; id?: string };
    const rawName = (clusterAny.title || `wf_${cluster.clusterId.slice(0, 8)}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const name = this.sanitizeIdentifier(rawName);
    const description =
      clusterAny.description || `Synthesized multi-step workflow (${cluster.structuralHash})`;

    const allVariableInputs: VariableInputDefinition[] = [];
    const allInvariantInputs: InvariantInputDefinition[] = [];
    const steps: WorkflowStep[] = [];

    let stepIndex = 1;
    for (const opp of opportunities) {
      const { variableInputs, invariantInputs } = this.extractInputs(opp, options.envelope);
      for (const v of variableInputs) {
        if (!allVariableInputs.some((existing) => existing.name === v.name)) {
          allVariableInputs.push(v);
        }
      }
      for (const inv of invariantInputs) {
        if (!allInvariantInputs.some((existing) => existing.name === inv.name)) {
          allInvariantInputs.push(inv);
        }
      }

      const oppSteps = this.constructSteps(opp, "single_tool", variableInputs, options.envelope);
      for (const s of oppSteps) {
        const stepId = `step_${stepIndex}_${s.id}`;
        steps.push({
          ...s,
          id: stepId,
          dependsOn: stepIndex > 1 ? [`step_${stepIndex - 1}_${oppSteps[0]?.id || "prev"}`] : [],
        });
        stepIndex++;
      }
    }

    const inputSchema = this.schemaGenerator.deriveInputSchema(allVariableInputs);
    const outputSchema = this.schemaGenerator.deriveOutputSchema(undefined, steps, "workflow");

    let capabilities = this.capabilityMapper.mapRequiredCapabilities(steps, options.envelope);
    if (options.envelope) {
      capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, options.envelope);
    }

    const runtimeRequirements: ToolRuntimeRequirementItem[] = [];
    if (capabilities.fs.readPaths.length > 0 || capabilities.fs.writePaths.length > 0) {
      runtimeRequirements.push({
        type: "permission",
        name: "fs",
        specifier: "deno:fs",
        required: true,
        reason: "Filesystem broker operations",
      });
    }
    if (capabilities.net.allowOutbound) {
      runtimeRequirements.push({
        type: "permission",
        name: "net",
        specifier: "deno:net",
        required: true,
        reason: "Network broker operations",
      });
    }
    if (capabilities.command.allowedCommands.length > 0) {
      runtimeRequirements.push({
        type: "permission",
        name: "cmd",
        specifier: "deno:subprocess",
        required: true,
        reason: "Command broker operations",
      });
    }

    const planId = `plan-wf-${randomUUID()}`;
    const runtime: ToolRuntimeRequirement = {
      runtime: "node",
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    };

    return {
      id: planId,
      planId,
      opportunityId: cluster.clusterId,
      workspaceId: options.tenantId || cluster.workspaceId || "default",
      targetType: "workflow",
      intent: clusterAny.title || description,
      name,
      description,
      version: options.version || "1.0.0",
      variableInputs: allVariableInputs,
      invariantInputs: allInvariantInputs,
      steps,
      inputSchema,
      outputSchema,
      capabilities,
      capabilityRequirements: capabilities,
      runtime,
      runtimeRequirements,
      metadata: {
        clusterId: cluster.clusterId,
        pattern: cluster.structuralHash,
        confidenceScore: 0.9,
        opportunityCount: opportunities.length,
      },
      createdAt: cluster.firstSeenAt || new Date().toISOString(),
    };
  }

  private extractInputs(
    opportunity: OpportunityDetection,
    envelope?: CapabilityEnvelope,
  ): {
    variableInputs: VariableInputDefinition[];
    invariantInputs: InvariantInputDefinition[];
  } {
    const variableInputs: VariableInputDefinition[] = [];
    const invariantInputs: InvariantInputDefinition[] = [];

    const inferred = opportunity.classification.inferredInputs ?? [];
    if (inferred.length > 0) {
      for (const inf of inferred) {
        let type: VariableInputDefinition["type"] = "string";
        if (
          inf.type === "number" ||
          inf.type === "boolean" ||
          inf.type === "array" ||
          inf.type === "object"
        ) {
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
      const pattern = (opportunity.classification.pattern || "").toLowerCase();
      const desc = (opportunity.classification.description || "").toLowerCase();
      const taskClass = (opportunity.classification.taskClass || "").toLowerCase();
      if (
        pattern.includes("file") ||
        pattern.includes("read") ||
        pattern.includes("edit") ||
        pattern.includes("fs") ||
        desc.includes("file") ||
        desc.includes("read")
      ) {
        variableInputs.push({
          name: "path",
          type: "string",
          description: "Target file path",
          required: true,
        });
        if (pattern.includes("write") || desc.includes("write") || desc.includes("save")) {
          variableInputs.push({
            name: "content",
            type: "string",
            description: "Content to write",
            required: true,
          });
        }
      }
      if (
        pattern.includes("cmd") ||
        pattern.includes("exec") ||
        pattern.includes("command") ||
        desc.includes("command") ||
        desc.includes("exec") ||
        taskClass === "command" ||
        taskClass === "vcs"
      ) {
        variableInputs.push({
          name: "command",
          type: "string",
          description: "Command to execute",
          required: false,
          defaultValue: "git status",
        });
        variableInputs.push({
          name: "args",
          type: "array",
          description: "Command arguments",
          required: false,
          defaultValue: [],
        });
      }
      if (
        pattern.includes("fetch") ||
        pattern.includes("http") ||
        pattern.includes("api") ||
        pattern.includes("network") ||
        desc.includes("api") ||
        desc.includes("http") ||
        desc.includes("fetch")
      ) {
        variableInputs.push({
          name: "url",
          type: "string",
          description: "Target URL or endpoint",
          required: true,
        });
      }

      if (variableInputs.length === 0) {
        variableInputs.push({
          name: "input",
          type: "string",
          description: "Primary input data",
          required: true,
        });
      }
    }

    if (opportunity.classification.commandProfiles?.length) {
      for (let index = variableInputs.length - 1; index >= 0; index--) {
        if (["command", "cmd", "args"].includes(variableInputs[index]!.name.toLowerCase())) {
          variableInputs.splice(index, 1);
        }
      }
    }

    if (
      opportunity.classification.taskClass === "multi_step" ||
      opportunity.classification.pattern.includes("->")
    ) {
      invariantInputs.push({
        name: "stopOnError",
        value: true,
        description: "Halt workflow execution on first step failure",
      });
    }

    // Extract secret references if detected in classification or evidence
    const descAndEv =
      (opportunity.classification.description || "") +
      JSON.stringify(opportunity.evidenceEventIds || []);

    let secretName: string | undefined;
    if (envelope && envelope.secrets.allowedSecretNames.length > 0) {
      const matchingSecret = envelope.secrets.allowedSecretNames.find((s) =>
        descAndEv.toLowerCase().includes(s.toLowerCase()),
      );
      secretName = matchingSecret || envelope.secrets.allowedSecretNames[0];
    } else if (descAndEv.includes("GITHUB_TOKEN") || descAndEv.includes("github_token")) {
      secretName = "GITHUB_TOKEN";
    } else if (
      descAndEv.includes("API_KEY") ||
      descAndEv.includes("api_key") ||
      descAndEv.includes("Bearer")
    ) {
      secretName = "API_KEY";
    }

    if (secretName) {
      invariantInputs.push({
        name: "authSecretName",
        value: secretName,
        description: `Non-disclosing secret reference for ${secretName} authentication`,
      });
    }

    return { variableInputs, invariantInputs };
  }

  private constructSteps(
    opportunity: OpportunityDetection,
    targetType: "single_tool" | "workflow",
    variableInputs: VariableInputDefinition[],
    envelope?: CapabilityEnvelope,
  ): WorkflowStep[] {
    const pattern = (opportunity.classification.pattern || "").toLowerCase();
    const desc = (opportunity.classification.description || "").toLowerCase();
    const taskClass = (opportunity.classification.taskClass || "").toLowerCase();

    if (targetType === "workflow") {
      const step1Id = "step_1_inspect";
      const step2Id = "step_2_execute";
      const step3Id = "step_3_verify";

      return [
        {
          id: step1Id,
          name: "Inspect Workspace / Read Preconditions",
          description: "Read input state or verify preconditions",
          toolClass: "filesystem",
          action: "fs.readFile",
          service: "fs",
          inputs: { path: variableInputs.find((v) => v.name === "path")?.name || "./data" },
          dependsOn: [],
          outputVar: "preconditionState",
        },
        {
          id: step2Id,
          name: "Execute Main Transformation",
          description: "Perform primary processing action",
          toolClass: "compute",
          action: "transform",
          service: "compute",
          inputs: { data: "$preconditionState" },
          dependsOn: [step1Id],
          outputVar: "processedResult",
        },
        {
          id: step3Id,
          name: "Persist / Verify Output",
          description: "Write results or verify postconditions",
          toolClass: "filesystem",
          action: "fs.writeFile",
          service: "fs",
          inputs: {
            path: "./output.json",
            content: "$processedResult",
          },
          dependsOn: [step2Id],
          outputVar: "finalOutput",
          compensation: {
            action: "fs.removeFile",
            inputs: { path: "./output.json" },
            description: "Remove partially written file on failure",
          },
        },
      ];
    }

    // Single tool step
    let toolClass = "compute";
    let action = "transform";
    let service: "fs" | "net" | "cmd" | "secret" | "compute" = "compute";
    const inputs: Record<string, unknown> = {};

    for (const v of variableInputs) {
      inputs[v.name] = `$${v.name}`;
    }

    const descAndEv =
      (opportunity.classification.description || "") +
      JSON.stringify(opportunity.evidenceEventIds || []);

    let secretName: string | undefined;
    if (envelope && envelope.secrets.allowedSecretNames.length > 0) {
      const matchingSecret = envelope.secrets.allowedSecretNames.find((s) =>
        descAndEv.toLowerCase().includes(s.toLowerCase()),
      );
      secretName = matchingSecret || envelope.secrets.allowedSecretNames[0];
    } else if (descAndEv.includes("GITHUB_TOKEN") || descAndEv.includes("github_token")) {
      secretName = "GITHUB_TOKEN";
    } else if (
      descAndEv.includes("API_KEY") ||
      descAndEv.includes("api_key") ||
      descAndEv.includes("Bearer")
    ) {
      secretName = "API_KEY";
    }

    if (secretName) {
      inputs.secretName = secretName;
      inputs.requiredSecrets = [secretName];
    }

    if (
      taskClass === "compute" ||
      taskClass === "pure_compute" ||
      pattern.startsWith("compute") ||
      pattern === "pure_compute"
    ) {
      toolClass = "compute";
      service = "compute";
      action = "compute.transform";
    } else if (
      taskClass === "command" ||
      taskClass === "vcs" ||
      taskClass === "build_tool" ||
      taskClass === "test_runner" ||
      pattern.startsWith("cmd") ||
      pattern.startsWith("vcs") ||
      pattern.includes("exec") ||
      pattern.includes("command")
    ) {
      toolClass = "command";
      service = "cmd";
      action = "cmd.exec";
      const inferredDefault = opportunity.classification.inferredInputs?.find((input) =>
        ["command", "cmd"].includes(input.name.toLowerCase()),
      )?.default;
      const descriptiveText =
        `${opportunity.classification.title} ${opportunity.classification.description}`.toLowerCase();
      const commandProfile =
        opportunity.classification.commandProfiles?.[0] ||
        (typeof inferredDefault === "string" ? inferredDefault : undefined) ||
        envelope?.command.allowedCommands[0] ||
        envelope?.command.allowedBinaries[0] ||
        (descriptiveText.includes("git status") ? "git status --porcelain" : undefined);
      if (!commandProfile || commandProfile.startsWith("$")) {
        throw new Error(
          "Command candidates require an observed immutable command profile or an explicitly approved envelope command",
        );
      }
      const [executable, ...commandArgs] = commandProfile.trim().split(/\s+/);
      if (!executable) throw new Error("Command profile has no executable");
      inputs.command = executable;
      inputs.args = commandArgs;
      inputs.commandProfile = commandProfile;
      inputs.toolClass = "command";
    } else if (
      taskClass === "network" ||
      taskClass === "http" ||
      taskClass === "api" ||
      pattern.startsWith("http") ||
      pattern.startsWith("net") ||
      pattern.startsWith("fetch") ||
      desc.includes("api") ||
      desc.includes("http")
    ) {
      toolClass = "network";
      service = "net";
      action = "net.fetch";
      const defaultHost = envelope?.net.allowedHosts[0] || envelope?.net.allowedDomains[0];
      inputs.url =
        inputs.url || (defaultHost ? `https://${defaultHost}` : "https://api.example.com");
      inputs.toolClass = "network";
    } else if (
      taskClass === "file_read" ||
      taskClass === "file_edit" ||
      taskClass === "filesystem" ||
      taskClass === "fs" ||
      pattern.startsWith("file") ||
      pattern.startsWith("fs") ||
      desc.includes("file")
    ) {
      toolClass = "filesystem";
      service = "fs";
      action =
        pattern.includes("write") ||
        pattern.includes("edit") ||
        desc.includes("write") ||
        taskClass === "file_edit"
          ? "fs.writeFile"
          : "fs.readFile";
      inputs.path = inputs.path || "./data.txt";
      inputs.toolClass = "filesystem";
    }

    return [
      {
        id: "step_main",
        name: opportunity.classification.title || "Execute Main Action",
        description: opportunity.classification.description,
        toolClass,
        action,
        service,
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
