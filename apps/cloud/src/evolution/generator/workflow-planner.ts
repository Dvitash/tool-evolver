import { randomUUID } from "node:crypto";
import type {
  CapabilityEnvelope,
  CapabilityManifest,
  ToolRuntimeRequirement,
} from "@tool-evolver/contracts";
import {
  type WorkflowPlanningOutput,
  WorkflowPlanningOutputSchema,
} from "../../models/prompt-registry.js";
import type { InferenceService } from "../../models/service.js";
import type { InferenceProvenance } from "../../models/types.js";
import type { OpportunityDetection, WorkflowCluster } from "../opportunity/types.js";
import { CapabilityMapper } from "./capability-mapper.js";
import { SchemaGenerator } from "./schema-generator.js";
import type {
  CandidatePlanningOptions,
  InvariantInputDefinition,
  StepCompensation,
  StepRetryPolicy,
  ToolPlan,
  ToolRuntimeRequirementItem,
  VariableInputDefinition,
  WorkflowStep,
} from "./types.js";
import { WorkflowGenerator } from "./workflow-generator.js";

/**
 * Plans multi-step workflow candidate tools with variable bindings, minimal capability unions,
 * and deterministic safe compensation.
 */
export class WorkflowPlanner {
  private readonly capabilityMapper: CapabilityMapper;
  private readonly schemaGenerator: SchemaGenerator;
  private readonly workflowGenerator: WorkflowGenerator;

  constructor(
    capabilityMapper: CapabilityMapper = new CapabilityMapper(),
    schemaGenerator: SchemaGenerator = new SchemaGenerator(),
    workflowGenerator: WorkflowGenerator = new WorkflowGenerator(),
  ) {
    this.capabilityMapper = capabilityMapper;
    this.schemaGenerator = schemaGenerator;
    this.workflowGenerator = workflowGenerator;
  }

  /**
   * Plans a multi-step workflow candidate tool from opportunity evidence.
   */
  async planWorkflow(
    opportunity: OpportunityDetection,
    options: CandidatePlanningOptions = {},
  ): Promise<ToolPlan> {
    if (options.inferenceService) {
      try {
        return await this.planWithInference(opportunity, options.inferenceService, options);
      } catch (err) {
        // Fall back to deterministic planning if inference fails
      }
    }

    return this.planDeterministic(opportunity, options);
  }

  /**
   * Plans workflow using production inference gateway with versioned prompt.
   */
  private async planWithInference(
    opportunity: OpportunityDetection,
    inferenceService: InferenceService,
    options: CandidatePlanningOptions,
  ): Promise<ToolPlan> {
    const classification = opportunity.classification;
    const episodes = (opportunity as unknown as { episodes?: unknown[] }).episodes ?? [];

    const promptInputs = {
      title: classification.title,
      description: classification.description,
      episodes: JSON.stringify(episodes, null, 2),
      capabilityEnvelope: JSON.stringify(options.envelope ?? {}, null, 2),
    };

    const result = await inferenceService.infer<Record<string, unknown>, WorkflowPlanningOutput>({
      promptTemplateId: "workflow_planning",
      promptTemplateVersion: "1.0.0",
      taskClass: "candidate_planning",
      inputs: promptInputs,
      tenantId: options.tenantId || "system",
    });

    const parsed = WorkflowPlanningOutputSchema.parse(result.output);

    const steps: WorkflowStep[] = parsed.steps.map((s, idx) => ({
      id: s.id || `step_${idx + 1}`,
      name: s.name,
      description: s.description,
      toolClass: s.toolClass,
      action: s.action,
      service: s.service as "fs" | "net" | "cmd" | "secret" | "compute" | undefined,
      inputs: s.inputs ?? {},
      outputs: s.outputs,
      outputVar: s.outputVar ?? `result_${s.id || idx + 1}`,
      dependsOn: s.dependsOn ?? (idx > 0 ? [`step_${idx}`] : []),
      timeoutMs: s.timeoutMs ?? 30000,
      timeout: s.timeoutMs ?? 30000,
      retryPolicy: s.retryPolicy
        ? {
            maxRetries: s.retryPolicy.maxRetries ?? 0,
            backoffMs: s.retryPolicy.backoffMs ?? 1000,
            idempotent: s.retryPolicy.idempotent ?? false,
          }
        : undefined,
      failureBehavior: s.failureBehavior ?? "abort",
      onFailure: s.failureBehavior ?? "abort",
      compensation: s.compensation
        ? {
            action: s.compensation.action,
            inputs: s.compensation.inputs ?? {},
            service: s.compensation.service,
            description: s.compensation.description,
            deterministicInverse: s.compensation.deterministicInverse ?? true,
          }
        : undefined,
      condition: s.condition,
    }));

    let capabilities = this.capabilityMapper.mapRequiredCapabilities(steps, options.envelope);
    if (options.envelope) {
      capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, options.envelope);
    }

    const variableInputs: VariableInputDefinition[] = (parsed.variableInputs ?? []).map((v) => ({
      name: v.name,
      type: v.type,
      description: v.description,
      required: v.required ?? true,
      defaultValue: v.defaultValue,
      examples: v.examples,
    }));

    const invariantInputs: InvariantInputDefinition[] = (parsed.invariantInputs ?? []).map((i) => ({
      name: i.name,
      value: i.value,
      description: i.description,
    }));

    const inputSchema = this.schemaGenerator.deriveInputSchema(variableInputs);
    const outputSchema = this.schemaGenerator.deriveOutputSchema(undefined, steps, "workflow");
    const runtimeRequirements = this.buildRuntimeRequirements(capabilities);

    const plan: ToolPlan = {
      id: `plan_${randomUUID()}`,
      planId: parsed.planId || `plan_${randomUUID().slice(0, 8)}`,
      opportunityId: opportunity.id,
      workspaceId: opportunity.workspaceId,
      name: this.sanitizeIdentifier(parsed.targetToolName),
      version: "1.0.0",
      description: parsed.description,
      targetType: "workflow",
      action: "create",
      workflowPattern: parsed.workflowPattern ?? "sequential_pipeline",
      variableInputs,
      invariantInputs,
      inputSchema,
      outputSchema,
      steps,
      capabilities,
      capabilityRequirements: capabilities,
      runtime: {
        runtime: "deno",
        minRuntimeVersion: "1.40.0",
        memoryLimitMb: 128,
        timeoutMs: steps.reduce((sum, s) => sum + (s.timeoutMs ?? 30000), 10000),
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 10485760,
      },
      runtimeRequirements,
      compensationPolicy: parsed.compensationPolicy ?? { enabled: true, autoRollback: true },
      metadata: {
        plannedBy: "inference_gateway",
        inferenceProvenance: result.provenance,
        taskClass: classification.taskClass,
      },
      createdAt: new Date().toISOString(),
    };

    return plan;
  }

  /**
   * Plans workflow deterministically from opportunity clusters and episode action sequences.
   */
  planDeterministic(
    opportunity: OpportunityDetection,
    options: CandidatePlanningOptions = {},
  ): ToolPlan {
    const classification = opportunity.classification;
    const episodes = (opportunity as unknown as { episodes?: unknown[] }).episodes ?? [];
    const name = this.sanitizeIdentifier(classification.suggestedToolName || classification.title);

    // Synthesize steps from opportunity episodes / clusters
    const rawSteps = this.synthesizeStepsFromEpisodes(opportunity);
    const steps = this.workflowGenerator.topologicalSort(rawSteps);
    // Derive variable & invariant inputs
    const { variableInputs, invariantInputs } = this.deriveInputs(steps, episodes);

    // Compute minimal capability manifest
    let capabilities = this.capabilityMapper.mapRequiredCapabilities(steps, options.envelope);
    if (options.envelope) {
      capabilities = this.capabilityMapper.minimizeCapabilities(capabilities, options.envelope);
    }

    const inputSchema = this.schemaGenerator.deriveInputSchema(variableInputs);
    const outputSchema = this.schemaGenerator.deriveOutputSchema(undefined, steps, "workflow");
    const runtimeRequirements = this.buildRuntimeRequirements(capabilities);

    const plan: ToolPlan = {
      id: `plan_${randomUUID()}`,
      planId: `plan_${randomUUID().slice(0, 8)}`,
      opportunityId: opportunity.id,
      workspaceId: opportunity.workspaceId,
      name,
      version: "1.0.0",
      description:
        classification.description || `Automated multi-step workflow for ${classification.title}`,
      targetType: "workflow",
      action: "create",
      workflowPattern: "sequential_pipeline",
      variableInputs,
      invariantInputs,
      inputSchema,
      outputSchema,
      steps,
      capabilities,
      capabilityRequirements: capabilities,
      runtime: {
        runtime: "deno",
        minRuntimeVersion: "1.40.0",
        memoryLimitMb: 128,
        timeoutMs: steps.reduce((sum, s) => sum + (s.timeoutMs ?? 30000), 10000),
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 10485760,
      },
      runtimeRequirements,
      compensationPolicy: { enabled: true, autoRollback: true },
      metadata: {
        plannedBy: "deterministic_workflow_planner",
        taskClass: classification.taskClass,
        triggerReason: opportunity.triggerReason,
      },
      createdAt: new Date().toISOString(),
    };

    return plan;
  }

  /**
   * Synthesizes workflow steps from opportunity episodes and action sequences.
   */
  private synthesizeStepsFromEpisodes(opportunity: OpportunityDetection): WorkflowStep[] {
    const episodes = (opportunity as unknown as { episodes?: unknown[] }).episodes ?? [];
    const steps: WorkflowStep[] = [];

    // Collect all action calls across episodes
    const actions: Array<{
      action: string;
      toolClass: string;
      service?: "fs" | "net" | "cmd" | "secret" | "compute";
      inputs: Record<string, unknown>;
    }> = [];

    for (const episode of episodes) {
      if (
        episode &&
        typeof episode === "object" &&
        "actions" in episode &&
        Array.isArray(episode.actions)
      ) {
        for (const act of episode.actions) {
          if (act && typeof act === "object" && "action" in act) {
            const actRec = act as Record<string, unknown>;
            const actionStr = String(actRec.action);
            const toolClassStr =
              typeof actRec.toolClass === "string"
                ? actRec.toolClass
                : this.inferToolClass(actionStr);
            const serviceStr =
              (actRec.service as "fs" | "net" | "cmd" | "secret" | "compute") ??
              this.inferService(actionStr);
            const inputsObj =
              actRec.inputs && typeof actRec.inputs === "object"
                ? (actRec.inputs as Record<string, unknown>)
                : {};
            actions.push({
              action: actionStr,
              toolClass: toolClassStr,
              service: serviceStr,
              inputs: inputsObj,
            });
          }
        }
      }
    }

    // If no explicit actions in episodes, build default workflow from pattern
    if (actions.length === 0) {
      return this.buildDefaultSteps(opportunity);
    }

    // Build steps with dependencies, safe compensation, timeouts, and idempotency
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      const stepId = `step_${i + 1}`;
      const dependsOn = i > 0 ? [`step_${i}`] : [];
      const compensation = this.generateSafeCompensation(act.action, act.inputs, act.service);
      const isIdempotent = this.isActionIdempotent(act.action);

      steps.push({
        id: stepId,
        name: `Execute ${act.action}`,
        description: `Step ${i + 1}: ${act.action}`,
        toolClass: act.toolClass,
        action: act.action,
        service: act.service,
        inputs: act.inputs,
        outputVar: `result_${stepId}`,
        dependsOn,
        timeoutMs: 30000,
        timeout: 30000,
        retryPolicy: isIdempotent
          ? { maxRetries: 2, backoffMs: 1000, idempotent: true }
          : { maxRetries: 0, backoffMs: 0, idempotent: false },
        failureBehavior: "abort",
        onFailure: "abort",
        compensation,
      });
    }

    return steps;
  }

  /**
   * Builds default workflow steps for pattern-based opportunities when raw actions are omitted.
   */
  private buildDefaultSteps(opportunity: OpportunityDetection): WorkflowStep[] {
    const classification = opportunity.classification;
    const taskClass = classification.taskClass.toLowerCase();

    if (taskClass.includes("test") || classification.pattern.includes("test")) {
      return [
        {
          id: "step_1",
          name: "Read Test File",
          description: "Read target test file for analysis",
          toolClass: "file_read",
          action: "fs.readFile",
          service: "fs",
          inputs: { path: "${input.filePath}" },
          outputVar: "result_step_1",
          dependsOn: [],
          timeoutMs: 10000,
          timeout: 10000,
          retryPolicy: { maxRetries: 2, backoffMs: 1000, idempotent: true },
          failureBehavior: "abort",
          onFailure: "abort",
        },
        {
          id: "step_2",
          name: "Execute Tests",
          description: "Run test suite against target file",
          toolClass: "test_runner",
          action: "cmd.exec",
          service: "cmd",
          inputs: {
            command: "pnpm test",
            args: ["${input.filePath}"],
          },
          outputVar: "result_step_2",
          dependsOn: ["step_1"],
          timeoutMs: 60000,
          timeout: 60000,
          retryPolicy: { maxRetries: 0, backoffMs: 0, idempotent: false },
          failureBehavior: "abort",
          onFailure: "abort",
        },
      ];
    }

    if (taskClass.includes("build") || classification.pattern.includes("build")) {
      return [
        {
          id: "step_1",
          name: "Clean Build Directory",
          description: "Prepare scratch/build directory",
          toolClass: "file_write",
          action: "fs.createDirectory",
          service: "fs",
          inputs: { path: "${input.buildDir}", recursive: true },
          outputVar: "result_step_1",
          dependsOn: [],
          timeoutMs: 10000,
          timeout: 10000,
          retryPolicy: { maxRetries: 2, backoffMs: 1000, idempotent: true },
          failureBehavior: "abort",
          onFailure: "abort",
          compensation: {
            action: "fs.remove",
            service: "fs",
            inputs: { path: "${input.buildDir}", recursive: true },
            description: "Rollback build directory creation",
            deterministicInverse: true,
          },
        },
        {
          id: "step_2",
          name: "Compile Assets",
          description: "Execute compiler/builder",
          toolClass: "build_tool",
          action: "cmd.exec",
          service: "cmd",
          inputs: {
            command: "pnpm build",
            args: ["--outDir", "${input.buildDir}"],
          },
          outputVar: "result_step_2",
          dependsOn: ["step_1"],
          timeoutMs: 120000,
          timeout: 120000,
          retryPolicy: { maxRetries: 0, backoffMs: 0, idempotent: false },
          failureBehavior: "abort",
          onFailure: "abort",
        },
      ];
    }

    // General file transform workflow
    return [
      {
        id: "step_1",
        name: "Read Source File",
        description: "Read input file",
        toolClass: "file_read",
        action: "fs.readFile",
        service: "fs",
        inputs: { path: "${input.sourcePath}" },
        outputVar: "result_step_1",
        dependsOn: [],
        timeoutMs: 10000,
        timeout: 10000,
        retryPolicy: { maxRetries: 2, backoffMs: 1000, idempotent: true },
        failureBehavior: "abort",
        onFailure: "abort",
      },
      {
        id: "step_2",
        name: "Write Destination File",
        description: "Write transformed content",
        toolClass: "file_write",
        action: "fs.writeFile",
        service: "fs",
        inputs: {
          path: "${input.destPath}",
          content: "${step.step_1.content}",
        },
        outputVar: "result_step_2",
        dependsOn: ["step_1"],
        timeoutMs: 15000,
        timeout: 15000,
        retryPolicy: { maxRetries: 1, backoffMs: 1000, idempotent: true },
        failureBehavior: "abort",
        onFailure: "abort",
        compensation: {
          action: "fs.remove",
          service: "fs",
          inputs: { path: "${input.destPath}" },
          description: "Remove written file on downstream failure",
          deterministicInverse: true,
        },
      },
    ];
  }

  /**
   * Determines deterministic safe compensation action for supported operations.
   */
  generateSafeCompensation(
    action: string,
    inputs: Record<string, unknown>,
    service?: string,
  ): StepCompensation | undefined {
    // 1. Filesystem write/creation -> safe remove inverse
    if (action === "fs.writeFile" || action === "writeFile") {
      const filePath = inputs.path ?? "${input.filePath}";
      return {
        action: "fs.remove",
        service: "fs",
        inputs: { path: filePath },
        description: `Delete created/modified file ${filePath}`,
        deterministicInverse: true,
      };
    }

    if (
      action === "fs.createDirectory" ||
      action === "createDirectory" ||
      action === "fs.mkdir" ||
      action === "mkdir"
    ) {
      const dirPath = inputs.path ?? "${input.dirPath}";
      return {
        action: "fs.remove",
        service: "fs",
        inputs: { path: dirPath, recursive: true },
        description: `Delete created directory ${dirPath}`,
        deterministicInverse: true,
      };
    }

    if (action === "fs.copy" || action === "copy") {
      const destPath = inputs.destination ?? inputs.dest ?? inputs.to ?? "${input.destPath}";
      return {
        action: "fs.remove",
        service: "fs",
        inputs: { path: destPath },
        description: `Remove copied destination ${destPath}`,
        deterministicInverse: true,
      };
    }

    if (action === "fs.move" || action === "move") {
      const source = inputs.source ?? inputs.src ?? inputs.from;
      const destination = inputs.destination ?? inputs.dest ?? inputs.to;
      if (source && destination) {
        return {
          action: "fs.move",
          service: "fs",
          inputs: { source: destination, destination: source },
          description: `Move back from ${destination} to ${source}`,
          deterministicInverse: true,
        };
      }
    }

    // 2. Reversible commands with explicit rollback
    if (inputs.rollbackCommand && typeof inputs.rollbackCommand === "string") {
      return {
        action: "cmd.exec",
        service: "cmd",
        inputs: {
          command: inputs.rollbackCommand,
          args: (inputs.rollbackArgs as unknown[]) ?? [],
        },
        description: `Rollback command: ${inputs.rollbackCommand}`,
        deterministicInverse: true,
      };
    }

    // Irreversible operations (destructive deletion, unvalidated HTTP POST/DELETE) MUST NOT have fake compensation
    return undefined;
  }

  /**
   * Checks if an action is idempotent by nature.
   */
  private isActionIdempotent(action: string): boolean {
    const normalized = action.toLowerCase();
    if (
      normalized.includes("read") ||
      normalized.includes("stat") ||
      normalized.includes("exists") ||
      normalized.includes("list") ||
      normalized.includes("get") ||
      normalized.includes("head") ||
      normalized.includes("search") ||
      normalized.includes("query") ||
      normalized.includes("writefile") ||
      normalized.includes("remove")
    ) {
      return true;
    }
    return false;
  }

  /**
   * Derives variable and invariant inputs from workflow step parameters.
   */
  private deriveInputs(
    steps: WorkflowStep[],
    episodes: unknown[],
  ): {
    variableInputs: VariableInputDefinition[];
    invariantInputs: InvariantInputDefinition[];
  } {
    const varMap = new Map<string, VariableInputDefinition>();
    const invMap = new Map<string, InvariantInputDefinition>();

    // Scan for ${input.varName} and $input.varName references in step inputs
    for (const step of steps) {
      this.scanForInputVariables(step.inputs, varMap);
      if (step.compensation?.inputs) {
        this.scanForInputVariables(step.compensation.inputs, varMap);
      }
    }

    // If no variables detected, synthesize standard inputs from common parameters
    if (varMap.size === 0) {
      for (const step of steps) {
        for (const [key, val] of Object.entries(step.inputs)) {
          if (
            typeof val === "string" &&
            (key.includes("path") || key.includes("file") || key.includes("name"))
          ) {
            varMap.set(key, {
              name: key,
              type: "string",
              description: `Input parameter for ${key}`,
              required: true,
              defaultValue: val,
            });
            step.inputs[key] = `\${input.${key}}`;
          } else if (val !== undefined) {
            invMap.set(`${step.id}_${key}`, {
              name: `${step.id}_${key}`,
              value: val,
              description: `Fixed configuration for ${step.name} (${key})`,
            });
          }
        }
      }
    }

    return {
      variableInputs: Array.from(varMap.values()),
      invariantInputs: Array.from(invMap.values()),
    };
  }

  private scanForInputVariables(obj: unknown, varMap: Map<string, VariableInputDefinition>): void {
    if (typeof obj === "string") {
      const matches = obj.matchAll(/\$\{(?:input\.)?([a-zA-Z0-9_]+)\}|\$input\.([a-zA-Z0-9_]+)/g);
      for (const match of matches) {
        const varName = match[1] || match[2];
        if (varName && !varMap.has(varName)) {
          varMap.set(varName, {
            name: varName,
            type:
              varName.toLowerCase().includes("count") || varName.toLowerCase().includes("limit")
                ? "number"
                : varName.toLowerCase().includes("enabled") ||
                    varName.toLowerCase().includes("flag")
                  ? "boolean"
                  : "string",
            description: `Dynamic workflow input ${varName}`,
            required: true,
          });
        }
      }
    } else if (Array.isArray(obj)) {
      for (const item of obj) {
        this.scanForInputVariables(item, varMap);
      }
    } else if (obj && typeof obj === "object") {
      for (const val of Object.values(obj)) {
        this.scanForInputVariables(val, varMap);
      }
    }
  }

  private inferToolClass(action: string): string {
    if (action.startsWith("fs.read") || action.startsWith("readFile")) return "file_read";
    if (
      action.startsWith("fs.write") ||
      action.startsWith("writeFile") ||
      action.startsWith("fs.create")
    )
      return "file_write";
    if (action.startsWith("net.")) return "api_client";
    if (action.startsWith("cmd.")) return "command_runner";
    return "custom";
  }

  private inferService(action: string): "fs" | "net" | "cmd" | "secret" | "compute" {
    if (action.startsWith("fs.")) return "fs";
    if (action.startsWith("net.")) return "net";
    if (action.startsWith("cmd.")) return "cmd";
    if (action.startsWith("secret.")) return "secret";
    return "compute";
  }

  private buildRuntimeRequirements(capabilities: CapabilityManifest): ToolRuntimeRequirementItem[] {
    const reqs: ToolRuntimeRequirementItem[] = [];
    if (
      (capabilities.fs?.readPaths && capabilities.fs.readPaths.length > 0) ||
      (capabilities.fs?.writePaths && capabilities.fs.writePaths.length > 0)
    ) {
      reqs.push({
        type: "permission",
        name: "fs",
        specifier: "deno:fs",
        required: true,
        reason: "Filesystem operations required by workflow steps",
      });
    }
    if (
      capabilities.net?.allowOutbound ||
      (capabilities.net?.allowedHosts && capabilities.net.allowedHosts.length > 0)
    ) {
      reqs.push({
        type: "permission",
        name: "net",
        specifier: "deno:net",
        required: true,
        reason: "Network requests required by workflow steps",
      });
    }
    if (
      capabilities.command?.allowShellExecution ||
      (capabilities.command?.allowedCommands && capabilities.command.allowedCommands.length > 0)
    ) {
      reqs.push({
        type: "permission",
        name: "run",
        specifier: "deno:run",
        required: true,
        reason: "Command execution required by workflow steps",
      });
    }
    return reqs;
  }

  private sanitizeIdentifier(name: string): string {
    const cleaned = name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_");
    return cleaned.length > 0 ? cleaned : "workflow_tool";
  }
}
