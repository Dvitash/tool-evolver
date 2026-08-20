import { randomUUID } from "node:crypto";
import type { CapabilityEnvelope, ToolOutputSchema, ToolRuntimeRequirement } from "@tool-evolver/contracts";
import {
  type BrokeredToolPlanningOutput,
  BrokeredToolPlanningOutputSchema,
  type CandidatePlanningOutput,
  CandidatePlanningOutputSchema,
} from "../../models/prompt-registry.js";
import type { InferenceService } from "../../models/service.js";
import type { InferenceProvenance } from "../../models/types.js";
import type { OpportunityDetection, WorkflowCluster, WorkflowContract } from "../opportunity/types.js";
import { CapabilityMapper } from "./capability-mapper.js";
import { SchemaGenerator } from "./schema-generator.js";
import { buildWorkflowCoverage } from "./workflow-coverage.js";
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
    const contract = classification.workflowContract as WorkflowContract | undefined;
    const taskClass = classification.taskClass.toLowerCase();
    const isWorkflow =
      options.targetType === "workflow" ||
      options.forceWorkflow === true ||
      taskClass === "multi_step" ||
      taskClass === "multi_step_workflow" ||
      classification.pattern.includes("->") ||
      classification.pattern.includes("chained") ||
      (contract !== undefined && contract.operations.length > 1);

    let inferenceOutput: CandidatePlanningOutput | BrokeredToolPlanningOutput | undefined;
    let provenance: InferenceProvenance | undefined;

    // 1. Inference-backed planning if inference service is supplied
    if (options.inferenceService) {
      try {
        const inputs: Record<string, unknown> = {
          opportunityId: opportunity.id,
          classification: JSON.stringify(classification),
          evidence: JSON.stringify(opportunity.evidenceEventIds || []),
          capabilityEnvelope: JSON.stringify(options.envelope || {}),
        };
        if (contract) {
          inputs.workflowContract = JSON.stringify(contract);
          inputs.operations = JSON.stringify(contract.operations);
          inputs.outputRequirements = JSON.stringify(contract.outputRequirements);
          inputs.requiredInputs = JSON.stringify(contract.requiredInputs);
          inputs.invariants = JSON.stringify(contract.invariants);
        }
        const infRes = await options.inferenceService.infer<Record<string, unknown>, unknown>({
          promptTemplateId: "candidate_planning",
          tenantId: options.tenantId || "system",
          taskClass: "candidate_planning",
          inputs,
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

    // Contract: ensure requiredInputs from workflowContract are represented as variable inputs (if not already)
    if (contract) {
      for (const reqIn of contract.requiredInputs) {
        const sanitized = this.sanitizeIdentifier(reqIn.name);
        if (!variableInputs.some((v) => v.name === sanitized)) {
          let t: VariableInputDefinition["type"] = "string";
          if (reqIn.type === "number" || reqIn.type === "boolean" || reqIn.type === "array" || reqIn.type === "object") {
            t = reqIn.type;
          }
          variableInputs.push({
            name: sanitized,
            type: t,
            description: reqIn.description || `Parameter ${reqIn.name}`,
            required: reqIn.required,
            defaultValue: (reqIn as unknown as { default?: unknown }).default,
          });
        }
      }
    }

    // 4. Construct workflow steps
    const targetType: "single_tool" | "workflow" = isWorkflow ? "workflow" : "single_tool";
    let steps: WorkflowStep[];
    if (contract) {
      steps = this.constructContractSteps(contract, variableInputs, options.envelope);
    } else {
      steps = this.constructSteps(opportunity, targetType, variableInputs, options.envelope);
    }

    // 5. Derive schemas
    const inputSchema = this.schemaGenerator.deriveInputSchema(variableInputs, contract);
    let outputSchema = this.schemaGenerator.deriveOutputSchema(
      classification.candidateOutputSchema,
      steps,
      targetType,
      contract,
    );
    if (contract) {
      outputSchema = this.unionContractOutputs(outputSchema, contract);
    }

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

    let workflowCoverage: ToolPlan["workflowCoverage"] | undefined;
    if (contract) {
      workflowCoverage = buildWorkflowCoverage(contract, steps, outputSchema);
    }

    const plan: ToolPlan = {
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

    if (contract) {
      plan.workflowContract = contract;
      plan.workflowCoverage = workflowCoverage;
    }

    return plan;
  }

  /**
   * Synchronous planning fallback.
   */
  planCandidate(
    opportunity: OpportunityDetection,
    options: CandidatePlanningOptions = {},
  ): ToolPlan {
    const classification = opportunity.classification;
    const contract = classification.workflowContract as WorkflowContract | undefined;
    const taskClass = classification.taskClass.toLowerCase();
    const isMultiStep =
      options.targetType === "workflow" ||
      options.forceWorkflow === true ||
      taskClass === "multi_step" ||
      taskClass === "multi_step_workflow" ||
      classification.pattern.includes("->") ||
      classification.pattern.includes("chained") ||
      (contract !== undefined && contract.operations.length > 1);

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

    // Contract: ensure requiredInputs present
    if (contract) {
      for (const reqIn of contract.requiredInputs) {
        const sanitized = this.sanitizeIdentifier(reqIn.name);
        if (!variableInputs.some((v) => v.name === sanitized)) {
          let t: VariableInputDefinition["type"] = "string";
          if (reqIn.type === "number" || reqIn.type === "boolean" || reqIn.type === "array" || reqIn.type === "object") {
            t = reqIn.type;
          }
          variableInputs.push({
            name: sanitized,
            type: t,
            description: reqIn.description || `Parameter ${reqIn.name}`,
            required: reqIn.required,
            defaultValue: (reqIn as unknown as { default?: unknown }).default,
          });
        }
      }
    }

    let steps: WorkflowStep[];
    if (contract) {
      steps = this.constructContractSteps(contract, variableInputs, options.envelope);
    } else {
      steps = this.constructSteps(opportunity, targetType, variableInputs, options.envelope);
    }

    const inputSchema = this.schemaGenerator.deriveInputSchema(variableInputs, contract);
    let outputSchema = this.schemaGenerator.deriveOutputSchema(
      classification.candidateOutputSchema,
      steps,
      targetType,
      contract,
    );
    if (contract) {
      outputSchema = this.unionContractOutputs(outputSchema, contract);
    }

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

    let workflowCoverage: ToolPlan["workflowCoverage"] | undefined;
    if (contract) {
      workflowCoverage = buildWorkflowCoverage(contract, steps, outputSchema);
    }

    const plan: ToolPlan = {
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

    if (contract) {
      plan.workflowContract = contract;
      plan.workflowCoverage = workflowCoverage;
    }

    return plan;
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
      const allProfiles = [
        ...new Set([
          ...(opportunity.classification.commandProfiles ?? []),
          commandProfile,
        ]),
      ];
      if (allProfiles.length > 1) {
        inputs.commandProfiles = allProfiles;
      }
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

  private constructContractSteps(
    contract: WorkflowContract,
    variableInputs: VariableInputDefinition[],
    envelope?: CapabilityEnvelope,
  ): WorkflowStep[] {
    const sortedOps = [...contract.operations].sort((a, b) => a.order - b.order);
    const steps: WorkflowStep[] = [];

    for (let idx = 0; idx < sortedOps.length; idx++) {
      const op = sortedOps[idx]!;
      const stepId = `step_${op.id}`;
      const previousId = idx > 0 ? `step_${sortedOps[idx - 1]!.id}` : undefined;
      const dependsOn = previousId ? [previousId] : [];

      const { toolClass, action, service, inputs } = this.mapOperationToStepDetails(op, variableInputs, envelope);

      steps.push({
        id: stepId,
        name: op.name,
        description: `Execute ${op.name} (${op.id})`,
        toolClass,
        action,
        service,
        inputs,
        dependsOn,
        outputVar: `result_${op.id}`,
        coveredOperationIds: [op.id],
      });
    }

    return steps;
  }

  private mapOperationToStepDetails(
    op: WorkflowContract["operations"][number],
    variableInputs: VariableInputDefinition[],
    envelope?: CapabilityEnvelope,
  ): { toolClass: string; action: string; service: WorkflowStep["service"]; inputs: Record<string, unknown> } {
    const inputs: Record<string, unknown> = {};

    // Prefer explicit commandProfile
    if (op.commandProfile) {
      const [executable, ...args] = op.commandProfile.trim().split(/\s+/);
      return {
        toolClass: op.toolClass || "command",
        action: "cmd.exec",
        service: "cmd",
        inputs: {
          command: executable,
          args,
          commandProfile: op.commandProfile,
          toolClass: op.toolClass || "command",
        },
      };
    }

    const toolClassFromOp = op.toolClass || "compute";
    const lowerName = op.name.toLowerCase();

    // File read / edit
    if (toolClassFromOp === "file_read" || toolClassFromOp === "file_edit" || (toolClassFromOp as string) === "filesystem" || (toolClassFromOp as string) === "fs") {
      const isWrite = toolClassFromOp === "file_edit" || lowerName.includes("edit") || lowerName.includes("write") || lowerName.includes("file_edit");
      if (isWrite) {
        // Prefer variableInputs for path/content
        const pathVar = variableInputs.find((v) => v.name === "path") ? "${input.path}" : "./data.txt";
        const contentVar = variableInputs.find((v) => v.name === "content") ? "${input.content}" : "${input.input}";
        inputs.path = pathVar;
        inputs.content = contentVar;
        inputs.toolClass = "filesystem";
        return { toolClass: "filesystem", action: "fs.writeFile", service: "fs", inputs };
      } else {
        const pathVar = variableInputs.find((v) => v.name === "path") ? "${input.path}" : "./data.txt";
        inputs.path = pathVar;
        inputs.toolClass = "filesystem";
        return { toolClass: "filesystem", action: "fs.readFile", service: "fs", inputs };
      }
    }

    if (toolClassFromOp === "search") {
      inputs.query = variableInputs.find((v) => v.name === "query") ? "${input.query}" : "${input.input}";
      return { toolClass: "search", action: "search.query", service: "compute", inputs };
    }

    if (toolClassFromOp === "test_runner") {
      return { toolClass: "test_runner", action: "cmd.exec", service: "cmd", inputs: { command: "pnpm", args: ["test"], toolClass: "test_runner" } };
    }

    if (toolClassFromOp === "build_tool") {
      return { toolClass: "build_tool", action: "cmd.exec", service: "cmd", inputs: { command: "pnpm", args: ["build"], toolClass: "build_tool" } };
    }

    if (toolClassFromOp === "vcs") {
      // Fallback vcs without profile -> git status
      return { toolClass: "vcs", action: "cmd.exec", service: "cmd", inputs: { command: "git", args: ["status"], toolClass: "vcs" } };
    }

    if (toolClassFromOp === "network" || (toolClassFromOp as string) === "http" || (toolClassFromOp as string) === "api") {
      inputs.url = variableInputs.find((v) => v.name === "url") ? "${input.url}" : "https://api.example.com";
      inputs.toolClass = "network";
      return { toolClass: "network", action: "net.fetch", service: "net", inputs };
    }

    if (toolClassFromOp === "shell_exec" || (toolClassFromOp as string) === "command") {
      return { toolClass: "command", action: "cmd.exec", service: "cmd", inputs: { command: "echo", args: ["hello"], toolClass: "command" } };
    }

    // Fallback based on operation name
    if (lowerName.includes("read") || lowerName.includes("fs.read")) {
      inputs.path = "${input.path}";
      return { toolClass: "filesystem", action: "fs.readFile", service: "fs", inputs };
    }
    if (lowerName.includes("edit") || lowerName.includes("write") || lowerName.includes("file_edit")) {
      inputs.path = "${input.path}";
      inputs.content = "${input.content}";
      return { toolClass: "filesystem", action: "fs.writeFile", service: "fs", inputs };
    }
    if (lowerName.includes("search")) {
      inputs.query = "${input.query}";
      return { toolClass: "search", action: "search.query", service: "compute", inputs };
    }
    if (lowerName.includes("test")) {
      return { toolClass: "test_runner", action: "cmd.exec", service: "cmd", inputs: { command: "pnpm", args: ["test"] } };
    }
    if (lowerName.includes("build")) {
      return { toolClass: "build_tool", action: "cmd.exec", service: "cmd", inputs: { command: "pnpm", args: ["build"] } };
    }
    if (lowerName.includes("git") || lowerName.includes("command") || lowerName.startsWith("cmd:") || lowerName.startsWith("command:")) {
      const cmd = op.name.replace(/^(cmd|command|tool):/, "").trim() || "git status";
      const [exe, ...a] = cmd.split(/\s+/);
      return { toolClass: "command", action: "cmd.exec", service: "cmd", inputs: { command: exe || "git", args: a, commandProfile: cmd } };
    }
    if (lowerName.includes("net") || lowerName.includes("fetch") || lowerName.includes("http")) {
      inputs.url = "${input.url}";
      return { toolClass: "network", action: "net.fetch", service: "net", inputs };
    }

    // Generic compute fallback
    return { toolClass: toolClassFromOp, action: "compute.transform", service: "compute", inputs: { data: "${input.input}" } };
  }

  private unionContractOutputs(outputSchema: ToolOutputSchema, contract: WorkflowContract): ToolOutputSchema {
    const originalProps = (outputSchema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const baseProps: Record<string, Record<string, unknown>> = { ...originalProps };
    // Determine data envelope target for strict contract shape {success, data, error}
    let dataTarget: Record<string, Record<string, unknown>> | undefined;
    const dataPropRaw = baseProps.data as unknown as Record<string, unknown> | undefined;
    if (dataPropRaw && typeof dataPropRaw === "object" && dataPropRaw !== null) {
      const dp = dataPropRaw as Record<string, unknown>;
      if (dp.properties && typeof dp.properties === "object" && dp.properties !== null) {
        dataTarget = dp.properties as Record<string, Record<string, unknown>>;
      } else {
        dataTarget = {};
        dp.properties = dataTarget as unknown as Record<string, unknown>;
        if (!dp.type) dp.type = "object";
        if (!dp.description) dp.description = "Result data payload";
      }
    } else if (originalProps.success && originalProps.error) {
      // Envelope expected but data missing — create it lazily
      dataTarget = {};
      baseProps.data = { type: "object", description: "Result data payload", properties: dataTarget } as unknown as Record<string, unknown>;
    }
    for (const req of contract.outputRequirements) {
      const entry = {
        type: req.type,
        description: req.description || `Output ${req.name} from ${req.sourceOperationId}`,
      };
      // Top-level union for legacy planner tests (properties[req.name])
      if (!(req.name in baseProps)) {
        baseProps[req.name] = { ...entry };
      } else {
        const existing = baseProps[req.name] as Record<string, unknown>;
        if (existing.type !== req.type) {
          existing.type = req.type;
        }
        if (!existing.description && req.description) {
          existing.description = req.description;
        }
      }
      // Data envelope union — required for strict coverage path `properties.data.properties.<name>`
      if (dataTarget) {
        if (!(req.name in dataTarget)) {
          dataTarget[req.name] = { ...entry };
        } else {
          const existingData = dataTarget[req.name] as Record<string, unknown>;
          if (existingData.type !== req.type) {
            existingData.type = req.type;
          }
          if (!existingData.description && req.description) {
            existingData.description = req.description;
          }
        }
      } else {
        // No envelope yet — ensure data envelope exists and place entry there as well
        if (!baseProps.data) {
          const newDataProps: Record<string, Record<string, unknown>> = { [req.name]: { ...entry } };
          baseProps.data = { type: "object", description: "Result data payload", properties: newDataProps } as unknown as Record<string, unknown>;
          dataTarget = newDataProps;
        }
      }
    }
    // Also ensure schema passthrough reflects union if present
    let schemaField: Record<string, unknown> | undefined;
    if (outputSchema.schema && typeof outputSchema.schema === "object") {
      schemaField = { ...(outputSchema.schema as Record<string, unknown>) };
      const schemaProps = schemaField.properties as Record<string, Record<string, unknown>> | undefined;
      if (schemaProps) {
        for (const req of contract.outputRequirements) {
          if (!(req.name in schemaProps)) {
            schemaProps[req.name] = { type: req.type, description: req.description } as Record<string, unknown>;
          }
          const sData = (schemaProps as unknown as Record<string, unknown>).data as Record<string, unknown> | undefined;
          if (sData && typeof sData === "object") {
            const sDataRecord = sData as Record<string, unknown>;
            if (sDataRecord.properties && typeof sDataRecord.properties === "object") {
              const sDataProps = sDataRecord.properties as Record<string, Record<string, unknown>>;
              if (!(req.name in sDataProps)) {
                sDataProps[req.name] = { type: req.type, description: req.description } as Record<string, unknown>;
              }
            }
          }
        }
      } else {
        const newProps: Record<string, Record<string, unknown>> = {};
        for (const req of contract.outputRequirements) {
          newProps[req.name] = { type: req.type, description: req.description } as Record<string, unknown>;
        }
        schemaField.properties = newProps as unknown as Record<string, unknown>;
      }
    }
    const result: ToolOutputSchema = {
      ...outputSchema,
      properties: baseProps,
    };
    if (schemaField) {
      result.schema = schemaField;
    }
    return result;
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
