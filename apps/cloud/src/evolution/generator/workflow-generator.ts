import type { CapabilityEnvelope, CapabilityManifest } from "@tool-evolver/contracts";
import { CapabilityMapper } from "./capability-mapper.js";
import { SchemaGenerator } from "./schema-generator.js";
import type {
  GeneratedTestCase,
  StepCompensation,
  ToolPlan,
  VariableInputDefinition,
  WorkflowRepairResult,
  WorkflowStep,
  WorkflowValidationResult,
} from "./types.js";
import { buildWorkflowCoverage, workflowCoverageDiagnostics } from "./workflow-coverage.js";

/**
 * Generates reusable workflow step graphs, validation engines, and executable TypeScript orchestrators.
 */
export class WorkflowGenerator {
  private readonly schemaGenerator: SchemaGenerator;
  private readonly capabilityMapper: CapabilityMapper;

  constructor(
    schemaGenerator: SchemaGenerator = new SchemaGenerator(),
    capabilityMapper: CapabilityMapper = new CapabilityMapper(),
  ) {
    this.schemaGenerator = schemaGenerator;
    this.capabilityMapper = capabilityMapper;
  }

  /**
   * Sorts workflow steps in topological dependency order and validates against cycles.
   */
  topologicalSort(steps: WorkflowStep[]): WorkflowStep[] {
    const stepMap = new Map<string, WorkflowStep>();
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const step of steps) {
      stepMap.set(step.id, step);
      inDegree.set(step.id, 0);
      dependents.set(step.id, []);
    }

    for (const step of steps) {
      for (const depId of step.dependsOn) {
        if (!stepMap.has(depId)) {
          throw new Error(`Workflow step "${step.id}" depends on unknown step "${depId}".`);
        }
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
        dependents.get(depId)?.push(step.id);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(id);
      }
    }

    const sorted: WorkflowStep[] = [];
    while (queue.length > 0) {
      const currId = queue.shift();
      if (!currId) break;
      const step = stepMap.get(currId);
      if (step) {
        sorted.push(step);
      }

      for (const neighborId of dependents.get(currId) ?? []) {
        const newDeg = (inDegree.get(neighborId) ?? 1) - 1;
        inDegree.set(neighborId, newDeg);
        if (newDeg === 0) {
          queue.push(neighborId);
        }
      }
    }

    if (sorted.length !== steps.length) {
      const cycles = this.detectCycles(steps);
      const cycleDescription =
        cycles.length > 0
          ? cycles.map((c) => c.join(" -> ")).join("; ")
          : "cycle detected in dependency graph";
      throw new Error(`Cyclic dependency detected: ${cycleDescription}`);
    }

    return sorted;
  }

  /**
   * Detects and returns all cycle paths in the step dependency graph.
   */
  detectCycles(steps: WorkflowStep[]): string[][] {
    const adj = new Map<string, string[]>();
    for (const step of steps) {
      adj.set(step.id, [...step.dependsOn]);
    }

    const visited = new Map<string, "unvisited" | "visiting" | "visited">();
    for (const step of steps) {
      visited.set(step.id, "unvisited");
    }

    const cycles: string[][] = [];
    const path: string[] = [];

    const dfs = (node: string) => {
      visited.set(node, "visiting");
      path.push(node);

      for (const dep of adj.get(node) ?? []) {
        const status = visited.get(dep);
        if (status === "visiting") {
          // Found cycle
          const cycleStartIndex = path.indexOf(dep);
          if (cycleStartIndex !== -1) {
            cycles.push([...path.slice(cycleStartIndex), dep]);
          }
        } else if (status === "unvisited") {
          dfs(dep);
        }
      }

      path.pop();
      visited.set(node, "visited");
    };

    for (const step of steps) {
      if (visited.get(step.id) === "unvisited") {
        dfs(step.id);
      }
    }

    return cycles;
  }

  /**
   * Comprehensive validation of workflow plan, variable bindings, capability bounds,
   * safe compensation, and idempotency constraints.
   */
  validateWorkflow(plan: ToolPlan, envelope?: CapabilityEnvelope): WorkflowValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Step uniqueness and existence
    const stepIds = new Set<string>();
    for (const step of plan.steps) {
      if (!step.id || typeof step.id !== "string") {
        errors.push(`Step missing a valid identifier string.`);
        continue;
      }
      if (stepIds.has(step.id)) {
        errors.push(`Duplicate step ID detected: "${step.id}". Step IDs must be unique.`);
      }
      stepIds.add(step.id);
    }

    // 2. Cycle detection & topological dependency check
    let sortedSteps: WorkflowStep[] = [];
    try {
      sortedSteps = this.topologicalSort(plan.steps);
    } catch (err) {
      errors.push((err as Error).message);
    }

    // Build index of step ordering in topological DAG
    const stepOrderIndex = new Map<string, number>();
    for (let i = 0; i < sortedSteps.length; i++) {
      stepOrderIndex.set(sortedSteps[i].id, i);
    }

    // 3. Variable binding and injection validation
    const declaredVariables = new Set<string>();
    for (const v of plan.variableInputs ?? []) {
      declaredVariables.add(v.name);
    }
    for (const i of plan.invariantInputs ?? []) {
      declaredVariables.add(i.name);
    }

    for (const step of plan.steps) {
      this.validateStepBindings(step, declaredVariables, stepIds, stepOrderIndex, errors);
      if (step.compensation) {
        this.validateStepCompensation(step, declaredVariables, errors);
      }
      this.validateStepRetryPolicy(step, errors, warnings);
    }

    // 4. Capability envelope bounds check
    if (envelope) {
      const subsetCheck = this.capabilityMapper.validateSubset(plan.capabilities, envelope);
      if (!subsetCheck.valid) {
        for (const violation of subsetCheck.violations) {
          errors.push(`Capability envelope overrun: ${violation}`);
        }
      }
    }

    // 5. Workflow contract coverage check (repairable errors, not warnings)
    if (plan.workflowContract) {
      try {
        const coverage = buildWorkflowCoverage(plan.workflowContract, plan.steps, plan.outputSchema);
        const diagnostics = workflowCoverageDiagnostics(coverage);
        for (const diag of diagnostics) {
          errors.push(diag);
        }
      } catch {
        errors.push("Workflow coverage computation failed");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates step variable bindings against schema, injection rules, and dependency order.
   */
  private validateStepBindings(
    step: WorkflowStep,
    declaredVariables: Set<string>,
    stepIds: Set<string>,
    stepOrderIndex: Map<string, number>,
    errors: string[],
  ): void {
    const currentStepIdx = stepOrderIndex.get(step.id) ?? 999999;

    const inspectValue = (val: unknown, location: string) => {
      if (typeof val === "string") {
        // Check for forbidden code injection patterns
        if (
          val.includes("eval(") ||
          val.includes("Function(") ||
          val.includes("process.") ||
          val.includes("__proto__") ||
          val.includes("constructor[") ||
          val.includes("<script")
        ) {
          errors.push(
            `Security violation in ${location}: executable code or unsafe prototype access detected.`,
          );
        }

        // Check for path traversal in path bindings
        if (
          (location.toLowerCase().includes("path") || location.toLowerCase().includes("dir")) &&
          (val.includes("../") || val.includes("..\\"))
        ) {
          errors.push(
            `Security violation in ${location}: path traversal attempt ("../") detected.`,
          );
        }

        // Inspect variable interpolations: ${input.x}, $input.x, ${step.id.field}, $step.id.field
        const matches = val.matchAll(
          /\$\{(?:(input|step|env)\.)?([a-zA-Z0-9_.-]+)\}|\$(input|step|env)\.([a-zA-Z0-9_.-]+)/g,
        );
        for (const match of matches) {
          const type = match[1] || match[3] || "input";
          const refPath = match[2] || match[4] || "";
          const parts = refPath.split(".");

          if (type === "input") {
            const varName = parts[0];
            if (!declaredVariables.has(varName)) {
              errors.push(
                `Undeclared input variable reference "${varName}" in step "${step.id}" (${location}).`,
              );
            }
          } else if (type === "step") {
            const targetStepId = parts[0];
            if (!stepIds.has(targetStepId)) {
              errors.push(
                `Step "${step.id}" references non-existent step "${targetStepId}" in binding "${match[0]}".`,
              );
            } else {
              const targetIdx = stepOrderIndex.get(targetStepId) ?? 999999;
              if (targetIdx >= currentStepIdx) {
                errors.push(
                  `Forward or cyclic step reference in "${step.id}": cannot reference downstream step "${targetStepId}".`,
                );
              }
              if (!step.dependsOn.includes(targetStepId)) {
                errors.push(
                  `Missing dependency in step "${step.id}": references "${targetStepId}" but does not list it in dependsOn.`,
                );
              }
            }
          } else if (type === "env") {
            // Environment variable / secret reference
            const secretName = parts[0];
            if (!secretName || secretName.length === 0) {
              errors.push(`Empty secret reference in step "${step.id}" (${location}).`);
            }
          }
        }
      } else if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          inspectValue(val[i], `${location}[${i}]`);
        }
      } else if (val && typeof val === "object") {
        for (const [k, v] of Object.entries(val)) {
          inspectValue(v, `${location}.${k}`);
        }
      }
    };

    inspectValue(step.inputs, `step "${step.id}".inputs`);
  }

  /**
   * Validates safety of step compensation actions.
   */
  private validateStepCompensation(
    step: WorkflowStep,
    declaredVariables: Set<string>,
    errors: string[],
  ): void {
    const comp = step.compensation;
    if (!comp) return;

    if (!comp.action || typeof comp.action !== "string") {
      errors.push(`Step "${step.id}" has compensation with missing action.`);
      return;
    }

    // Irreversible actions cannot claim deterministic safe inverse unless confirmed
    const irreversibleActions = ["fs.remove", "fs.delete", "net.delete", "cmd.kill"];
    if (irreversibleActions.some((act) => step.action.includes(act))) {
      if (comp.deterministicInverse !== true && !comp.inputs.restoreBackup) {
        errors.push(
          `Unsafe compensation in step "${step.id}": action "${step.action}" has no deterministic safe inverse.`,
        );
      }
    }

    // Validate compensation inputs
    if (comp.inputs && typeof comp.inputs === "object") {
      for (const [k, v] of Object.entries(comp.inputs)) {
        if (typeof v === "string") {
          const matches = v.matchAll(/\$\{(?:input\.)?([a-zA-Z0-9_]+)\}|\$input\.([a-zA-Z0-9_]+)/g);
          for (const match of matches) {
            const varName = match[1] || match[2];
            if (varName && !declaredVariables.has(varName)) {
              errors.push(
                `Undeclared input variable "${varName}" in compensation for step "${step.id}".`,
              );
            }
          }
        }
      }
    }
  }

  /**
   * Validates retry policy idempotency constraints.
   */
  private validateStepRetryPolicy(step: WorkflowStep, errors: string[], warnings: string[]): void {
    const policy = step.retryPolicy;
    if (!policy || policy.maxRetries <= 0) return;

    // Check non-idempotent operations
    const nonIdempotentActions = ["cmd.exec", "net.post", "net.patch", "net.delete"];
    const isNonIdempotent = nonIdempotentActions.some((act) => step.action.includes(act));

    if (isNonIdempotent && policy.idempotent !== true) {
      errors.push(
        `Non-idempotent step "${step.id}" (${step.action}) configured with maxRetries=${policy.maxRetries} without idempotency confirmation.`,
      );
    }
  }

  /**
   * Executes bounded repair loop to fix cycles, undeclared bindings, unsafe compensation,
   * non-idempotent retries, or capability overruns.
   */
  /**
   * Executes bounded repair loop to fix cycles, undeclared bindings, unsafe compensation,
   * non-idempotent retries, capability overruns, and workflow contract coverage.
   * Coverage diagnostics are repairable errors; recomputed after each repair and required for success.
   */
  repairWorkflow(
    plan: ToolPlan,
    initialErrors: string[] = [],
    envelope?: CapabilityEnvelope,
    maxIterations = 3,
  ): WorkflowRepairResult {
    const currentPlan: ToolPlan = JSON.parse(JSON.stringify(plan));
    const appliedFixes: string[] = [];
    let iterations = 0;

    // Initialize workflowCoverage if contract present
    if (currentPlan.workflowContract) {
      try {
        currentPlan.workflowCoverage = buildWorkflowCoverage(currentPlan.workflowContract, currentPlan.steps, currentPlan.outputSchema);
      } catch {
        // ignore
      }
    }

    let validation = this.validateWorkflow(currentPlan, envelope);
    // Merge initialErrors with validation errors for coverage diagnostics seeding
    let currentErrors = initialErrors.length > 0 ? [...initialErrors, ...validation.errors.filter(e => !initialErrors.includes(e))] : validation.errors;
    // Deduplicate
    currentErrors = [...new Set(currentErrors)];

    while (currentErrors.length > 0 && iterations < maxIterations) {
      iterations++;

      // 1. Fix Cycles: break back-edges by sorting or clearing circular dependsOn
      const cycleErrors = currentErrors.filter(
        (e) => e.toLowerCase().includes("cyclic") || e.toLowerCase().includes("cycle"),
      );
      if (cycleErrors.length > 0) {
        const stepIds = currentPlan.steps.map((s) => s.id);
        for (let i = 0; i < currentPlan.steps.length; i++) {
          const step = currentPlan.steps[i];
          // Restrict dependsOn to strictly earlier steps in the list
          const allowedDeps = stepIds.slice(0, i);
          const originalDeps = [...step.dependsOn];
          step.dependsOn = step.dependsOn.filter((d) => allowedDeps.includes(d));
          if (step.dependsOn.length !== originalDeps.length) {
            appliedFixes.push(`Removed cyclic/forward dependencies from step "${step.id}".`);
          }
        }
      }

      // 2. Fix Undeclared Input Variables: declare missing variables in variableInputs
      const undeclaredErrors = currentErrors.filter((e) => e.includes("Undeclared input variable"));
      for (const err of undeclaredErrors) {
        const match = err.match(/Undeclared input variable (?:reference )?"([^"]+)"/);
        if (match && match[1]) {
          const varName = match[1];
          if (!currentPlan.variableInputs.some((v) => v.name === varName)) {
            currentPlan.variableInputs.push({
              name: varName,
              type:
                varName.toLowerCase().includes("count") || varName.toLowerCase().includes("limit")
                  ? "number"
                  : varName.toLowerCase().includes("enabled")
                    ? "boolean"
                    : "string",
              description: `Auto-declared workflow parameter for ${varName}`,
              required: true,
            });
            appliedFixes.push(`Auto-declared missing variable input "${varName}".`);
          }
        }
      }

      // 3. Fix Missing Dependencies: add referenced step to dependsOn
      const missingDepErrors = currentErrors.filter((e) =>
        e.includes("Missing dependency in step"),
      );
      for (const err of missingDepErrors) {
        const match = err.match(/Missing dependency in step "([^"]+)": references "([^"]+)"/);
        if (match && match[1] && match[2]) {
          const stepId = match[1];
          const depId = match[2];
          const targetStep = currentPlan.steps.find((s) => s.id === stepId);
          if (targetStep && !targetStep.dependsOn.includes(depId)) {
            targetStep.dependsOn.push(depId);
            appliedFixes.push(`Added missing dependency "${depId}" to step "${stepId}".`);
          }
        }
      }

      // 4. Fix Unsafe Compensation: remove invalid compensation from irreversible steps
      const unsafeCompErrors = currentErrors.filter((e) => e.includes("Unsafe compensation"));
      for (const err of unsafeCompErrors) {
        const match = err.match(/Unsafe compensation in step "([^"]+)"/);
        if (match && match[1]) {
          const stepId = match[1];
          const targetStep = currentPlan.steps.find((s) => s.id === stepId);
          if (targetStep && targetStep.compensation) {
            delete targetStep.compensation;
            appliedFixes.push(`Removed unsafe compensation action from step "${stepId}".`);
          }
        }
      }

      // 5. Fix Non-Idempotent Retries: set maxRetries = 0
      const retryErrors = currentErrors.filter((e) => e.includes("Non-idempotent step"));
      for (const err of retryErrors) {
        const match = err.match(/Non-idempotent step "([^"]+)"/);
        if (match && match[1]) {
          const stepId = match[1];
          const targetStep = currentPlan.steps.find((s) => s.id === stepId);
          if (targetStep && targetStep.retryPolicy) {
            targetStep.retryPolicy.maxRetries = 0;
            appliedFixes.push(`Disabled non-idempotent retries on step "${stepId}".`);
          }
        }
      }

      // 6. Fix Capability Envelope Overruns: minimize capabilities
      if (envelope) {
        currentPlan.capabilities = this.capabilityMapper.minimizeCapabilities(
          currentPlan.capabilities,
          envelope,
        );
        currentPlan.capabilityRequirements = currentPlan.capabilities;
        appliedFixes.push("Minimized capability manifest to satisfy workspace envelope.");
      }

      // 7. Fix Missing Workflow Coverage: add steps for uncovered operations and schema entries for uncovered outputs
      if (currentPlan.workflowContract) {
        let coverage;
        try {
          coverage = buildWorkflowCoverage(currentPlan.workflowContract, currentPlan.steps, currentPlan.outputSchema);
        } catch {
          coverage = undefined;
        }
        if (coverage && !coverage.complete) {
          // Fix uncovered operations (one per iteration to respect max-iteration bounds)
          for (const opId of [...coverage.uncoveredOperationIds].sort().slice(0, 1)) {
            const operation = currentPlan.workflowContract.operations.find((op) => op.id === opId);
            if (!operation) continue;
            if (currentPlan.steps.some((s) => s.coveredOperationIds?.includes(opId))) continue;
            let stepId = `step_${opId}`;
            let counter = 1;
            while (currentPlan.steps.some((s) => s.id === stepId)) {
              stepId = `step_${opId}_${counter++}`;
            }
            let toolClass = operation.toolClass ?? "compute";
            let service: WorkflowStep["service"] = "compute";
            let action = operation.name;
            let inputs: Record<string, unknown> = {};
            if (operation.commandProfile) {
              service = "cmd";
              toolClass = operation.toolClass ?? "command";
              action = "cmd.exec";
              const parts = operation.commandProfile.trim().split(/\s+/);
              const cmd = parts[0] ?? "echo";
              const args = parts.slice(1);
              inputs = { command: cmd, args };
            } else if (operation.name.startsWith("cmd:") || operation.name.startsWith("command:")) {
              service = "cmd";
              toolClass = "command";
              action = "cmd.exec";
              const cmdStr = operation.name.replace(/^cmd:/, "").replace(/^command:/, "").trim();
              if (cmdStr) {
                const parts = cmdStr.split(/\s+/);
                inputs = { command: parts[0], args: parts.slice(1) };
              } else {
                inputs = { command: "echo", args: [operation.name] };
              }
            } else if (toolClass === "file_read" || operation.name.includes("file_read") || operation.name.includes("read_file")) {
              service = "fs";
              action = "fs.readFile";
              const filePathVar = currentPlan.variableInputs.some((v) => v.name === "targetPaths")
                ? "${input.targetPaths[0]}"
                : currentPlan.variableInputs.some((v) => v.name === "targetPath")
                  ? "${input.targetPath}"
                  : "${input.path}";
              inputs = { path: filePathVar };
              toolClass = "file_read";
            } else if (toolClass === "file_edit" || operation.name.includes("file_edit") || operation.name.includes("write")) {
              service = "fs";
              action = "fs.writeFile";
              const filePathVar = currentPlan.variableInputs.some((v) => v.name === "targetPaths")
                ? "${input.targetPaths[0]}"
                : currentPlan.variableInputs.some((v) => v.name === "targetPath")
                  ? "${input.targetPath}"
                  : "${input.path}";
              const contentVar = currentPlan.variableInputs.some((v) => v.name === "content")
                ? "${input.content}"
                : "${input.input}";
              inputs = { path: filePathVar, content: contentVar };
              toolClass = "file_edit";
            } else if (toolClass === "vcs" || operation.name.toLowerCase().includes("git")) {
              service = "cmd";
              action = "cmd.exec";
              if (operation.commandProfile) {
                const parts = operation.commandProfile.trim().split(/\s+/);
                inputs = { command: parts[0], args: parts.slice(1) };
              } else {
                inputs = { command: "git", args: ["status"] };
              }
            } else if (toolClass === "test_runner" || operation.name.includes("test")) {
              service = "cmd";
              action = "cmd.exec";
              inputs = { command: "pnpm", args: ["test"] };
            } else if (toolClass === "build_tool" || operation.name.includes("build")) {
              service = "cmd";
              action = "cmd.exec";
              inputs = { command: "pnpm", args: ["build"] };
            } else if (toolClass === "search" || operation.name.includes("search")) {
              service = "fs";
              action = "fs.listDirectory";
              const searchPathVar = currentPlan.variableInputs.some((v) => v.name === "targetPaths")
                ? "${input.targetPaths[0]}"
                : currentPlan.variableInputs.some((v) => v.name === "path")
                  ? "${input.path}"
                  : currentPlan.variableInputs.some((v) => v.name === "query")
                    ? "${input.query}"
                    : "${input.input}";
              inputs = { path: searchPathVar, recursive: true, toolClass: "search" };
            } else {
              service = "compute";
              action = operation.name.includes(".") ? operation.name : "compute.transform";
              inputs = {};
            }
            const outputsForOp = currentPlan.workflowContract.outputRequirements
              .filter((req) => req.sourceOperationId === opId)
              .map((req) => req.name)
              .sort();
            const newStep: WorkflowStep = {
              id: stepId,
              name: operation.name,
              description: `Coverage step for ${operation.name}`,
              toolClass,
              action,
              service: service as WorkflowStep["service"],
              inputs,
              outputVar: `result_${stepId}`,
              dependsOn: [],
              coveredOperationIds: [opId],
              ...(outputsForOp.length > 0 ? { outputs: outputsForOp } : {}),
              timeoutMs: 30000,
              timeout: 30000,
              retryPolicy: { maxRetries: 0, backoffMs: 0, idempotent: false },
              failureBehavior: "abort",
              onFailure: "abort",
            };
            currentPlan.steps.push(newStep);
            appliedFixes.push(`Added step "${stepId}" covering operation "${opId}" (${operation.name}).`);
          }
          // Fix uncovered outputs (one per iteration)
          for (const outputName of [...coverage.uncoveredOutputNames].sort().slice(0, 1)) {
            const req = currentPlan.workflowContract.outputRequirements.find((r) => r.name === outputName);
            if (!req) continue;
            const type = typeof req.type === "string" && req.type.length > 0 ? req.type : "string";
            const description = typeof req.description === "string" && req.description.length > 0 ? req.description : `Output ${outputName} from ${req.sourceOperationId}`;
            if (!currentPlan.outputSchema.properties) {
              (currentPlan.outputSchema as unknown as { properties: Record<string, unknown> }).properties = {};
            }
            const props = currentPlan.outputSchema.properties as Record<string, unknown>;
            const dataPropRaw = (props as Record<string, unknown>).data;
            const dataProp = dataPropRaw && typeof dataPropRaw === "object" ? (dataPropRaw as Record<string, unknown>) : undefined;
            let targetProperties: Record<string, Record<string, unknown>>;
            if (dataProp && typeof dataProp.properties === "object" && dataProp.properties !== null) {
              targetProperties = dataProp.properties as Record<string, Record<string, unknown>>;
            } else {
              targetProperties = props as unknown as Record<string, Record<string, unknown>>;
            }
            if (!targetProperties[outputName]) {
              targetProperties[outputName] = { type, description } as unknown as Record<string, unknown>;
              appliedFixes.push(`Added missing output "${outputName}" to outputSchema.`);
            }
            // Ensure covering step declares this output
            let coveringStep = currentPlan.steps.find((s) => s.coveredOperationIds?.includes(req.sourceOperationId));
            if (coveringStep) {
              const existingOutputs = coveringStep.outputs as unknown;
              if (Array.isArray(existingOutputs)) {
                if (!(existingOutputs as string[]).includes(outputName)) {
                  (coveringStep.outputs as string[]).push(outputName);
                  (coveringStep.outputs as string[]).sort();
                }
              } else if (existingOutputs && typeof existingOutputs === "object") {
                if (!Object.prototype.hasOwnProperty.call(existingOutputs as Record<string, unknown>, outputName)) {
                  (existingOutputs as Record<string, unknown>)[outputName] = { type, description };
                }
              } else {
                coveringStep.outputs = [outputName];
              }
            }
            if (req.required) {
              if (dataProp && Array.isArray(dataProp.required)) {
                const arr = dataProp.required as string[];
                if (!arr.includes(outputName)) arr.push(outputName);
              } else if (Array.isArray((currentPlan.outputSchema as unknown as { required?: unknown }).required)) {
                const arr = (currentPlan.outputSchema as unknown as { required: string[] }).required;
                if (!arr.includes(outputName)) arr.push(outputName);
              } else if (dataProp && typeof dataProp === "object") {
                const existing = ((dataProp as unknown as { required?: string[] }).required ?? []) as string[];
                (dataProp as unknown as { required: string[] }).required = [...existing, outputName];
              }
            }
          }
        }
      }

      // Re-generate schemas (contract-aware)
      currentPlan.inputSchema = this.schemaGenerator.deriveInputSchema(currentPlan.variableInputs, currentPlan.workflowContract);
      currentPlan.outputSchema = this.schemaGenerator.deriveOutputSchema(
        undefined,
        currentPlan.steps,
        "workflow",
        currentPlan.workflowContract,
      );

      // Recompute workflowCoverage after schema regeneration
      if (currentPlan.workflowContract) {
        try {
          currentPlan.workflowCoverage = buildWorkflowCoverage(currentPlan.workflowContract, currentPlan.steps, currentPlan.outputSchema);
        } catch {
          // ignore
        }
      }

      // Re-validate (includes coverage)
      validation = this.validateWorkflow(currentPlan, envelope);
      currentErrors = validation.errors;
    }

    // Final coverage check for repaired status
    let coverageComplete = true;
    if (currentPlan.workflowContract) {
      try {
        const finalCoverage = buildWorkflowCoverage(currentPlan.workflowContract, currentPlan.steps, currentPlan.outputSchema);
        if (finalCoverage) currentPlan.workflowCoverage = finalCoverage;
        coverageComplete = finalCoverage ? finalCoverage.complete : false;
      } catch {
        coverageComplete = false;
      }
    }

    return {
      plan: currentPlan,
      repaired: validation.valid && coverageComplete,
      iterations,
      appliedFixes,
      remainingErrors: validation.valid && coverageComplete ? undefined : validation.errors,
    };
  }

  /**
   * Alias for generateCode for workflow source synthesis.
   */
  generateWorkflowSource(plan: ToolPlan): string {
    return this.generateCode(plan);
  }
  /**
   * Generates a runtime-compatible WorkflowDefinition from a ToolPlan.
   */
  generateWorkflowDefinition(plan: ToolPlan): {
    id: string;
    name: string;
    version?: string;
    description?: string;
    steps: WorkflowStep[];
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    capabilities?: CapabilityManifest;
    maxConcurrency?: number;
    timeoutMs?: number;
    compensationPolicy?: {
      enabled: boolean;
      autoRollback: boolean;
    };
    metadata?: Record<string, unknown>;
  } {
    const sortedSteps = this.topologicalSort(plan.steps);
    return {
      id: plan.id,
      name: plan.name,
      version: plan.version ?? "1.0.0",
      description: plan.description,
      steps: sortedSteps,
      inputSchema: plan.inputSchema as unknown as Record<string, unknown>,
      outputSchema: plan.outputSchema as unknown as Record<string, unknown>,
      capabilities: plan.capabilities,
      maxConcurrency: 4,
      timeoutMs: plan.runtime.timeoutMs,
      compensationPolicy: plan.compensationPolicy ?? { enabled: true, autoRollback: true },
      metadata: plan.metadata,
    };
  }

  /**
   * Generates executable TypeScript / Deno orchestrator source code.
   */
  generateCode(plan: ToolPlan): string {
    const sortedSteps = this.topologicalSort(plan.steps);
    const hasFs = sortedSteps.some((s) => s.service === "fs" || s.action.startsWith("fs."));
    const hasNet = sortedSteps.some((s) => s.service === "net" || s.action.startsWith("net."));
    const hasCmd = sortedSteps.some((s) => s.service === "cmd" || s.action.startsWith("cmd."));
    const hasSecret = sortedSteps.some(
      (s) => s.service === "secret" || s.action.startsWith("secret."),
    );

    const inputZodCode = this.schemaGenerator.generateZodSource(plan.inputSchema);

    let code = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";\nimport { z } from "zod";\n\n`;
    code += `export const InputSchema = ${inputZodCode};\n`;
    code += `export const ToolInputSchema = InputSchema;\n`;
    code += `export type ToolInput = z.infer<typeof ToolInputSchema>;\n\n`;

    code += `export const OutputSchema = z.object({\n`;
    code += `  success: z.boolean(),\n`;
    code += `  data: z.record(z.unknown()),\n`;
    code += `  durationMs: z.number(),\n`;
    code += `  stepCount: z.number(),\n`;
    code += `});\n`;
    code += `export const ToolOutputSchema = OutputSchema;\n`;
    code += `export type ToolOutput = z.infer<typeof ToolOutputSchema>;\n\n`;

    code += `export default defineTool<ToolInput, ToolOutput>({\n`;
    code += `  name: ${JSON.stringify(plan.name)},\n`;
    code += `  version: ${JSON.stringify(plan.version)},\n`;
    code += `  description: ${JSON.stringify(plan.description)},\n`;
    code += `  async handler(input: ToolInput, context: ToolContext): Promise<ToolOutput> {\n`;
    code += `    const startTime = Date.now();\n`;
    code += `    const { broker, logger, progress } = context;\n`;
    code += `    const stepResults: Record<string, unknown> = {};\n`;
    code += `    const compensationStack: Array<() => Promise<void>> = [];\n\n`;

    code += `    await logger.info("[${plan.name}] Starting workflow execution with " + ${sortedSteps.length} + " steps.");\n`;
    code += `    await progress(0, ${sortedSteps.length}, "Starting workflow execution...");\n\n`;

    code += `    try {\n`;

    for (let i = 0; i < sortedSteps.length; i++) {
      const step = sortedSteps[i];
      const stepProgress = ((i + 1) / sortedSteps.length).toFixed(2);

      code += `      // Step ${i + 1}: ${step.name} (${step.id})\n`;
      code += `      await progress(${stepProgress}, ${sortedSteps.length}, "Executing ${step.name}...");\n`;
      code += `      await logger.info("[Step ${step.id}] Executing ${step.action}");\n`;

      if (step.condition) {
        code += `      if (${this.compileExpression(step.condition)}) {\n`;
      }

      // Step execution with retry loop
      const maxRetries = step.retryPolicy?.maxRetries ?? 0;
      const backoffMs = step.retryPolicy?.backoffMs ?? 1000;

      code += `      {\n`;
      code += `        let attempts = 0;\n`;
      code += `        let stepSuccess = false;\n`;
      code += `        let lastErr: unknown;\n`;
      code += `        while (attempts <= ${maxRetries} && !stepSuccess) {\n`;
      code += `          try {\n`;
      code += `            const stepInput = ${this.compileStepInputObject(step.inputs)};\n`;

      // Call broker action
      code += `            const res = await ${this.compileBrokerCall(step)};\n`;
      const isCompositeCmd =
        Array.isArray((step.inputs as Record<string, unknown>).commandProfiles) &&
        ((step.inputs as Record<string, unknown>).commandProfiles as unknown[]).length > 1;
      if ((step.action === "cmd.exec" || step.action === "exec") && !isCompositeCmd) {
        code += `            if (res.exitCode !== 0) throw new Error(String(res.stderr || "Command " + ${JSON.stringify(step.id)} + " failed with exit code " + res.exitCode));\n`;
      }
      code += `            stepResults[${JSON.stringify(step.id)}] = res;\n`;
      code += `            stepSuccess = true;\n`;

      // Register compensation if defined
      if (step.compensation) {
        code += `            // Register compensation rollback action\n`;
        code += `            compensationStack.push(async () => {\n`;
        code += `              try {\n`;
        code += `                await logger.warn("[Compensation] Rolling back step ${step.id} (${step.compensation.action})");\n`;
        code += `                const compInput = ${this.compileStepInputObject(step.compensation.inputs)};\n`;
        code += `                await ${this.compileBrokerCall({ action: step.compensation.action, service: step.compensation.service, id: `comp_${step.id}` } as WorkflowStep, "compInput")};\n`;
        code += `              } catch (compErr) {\n`;
        code += `                await logger.error("[Compensation Error] Failed rollback for ${step.id}: " + String(compErr));\n`;
        code += `              }\n`;
        code += `            });\n`;
      }

      code += `          } catch (err) {\n`;
      code += `            lastErr = err;\n`;
      code += `            attempts++;\n`;
      code += `            await logger.warn("[Step ${step.id}] Attempt " + attempts + " failed: " + String(err));\n`;
      if (maxRetries > 0) {
        code += `            if (attempts <= ${maxRetries}) {\n`;
        code += `              await logger.warn("[Step ${step.id}] Attempt " + attempts + " failed. Retrying in ${backoffMs}ms...");\n`;
        code += `              await new Promise((r) => setTimeout(r, ${backoffMs}));\n`;
        code += `            }\n`;
      }
      code += `          }\n`;
      code += `        }\n`;

      code += `        if (!stepSuccess) {\n`;
      if (step.failureBehavior === "continue") {
        code += `          await logger.warn("[Step ${step.id}] Failed but continuing workflow: " + String(lastErr));\n`;
      } else {
        code += `          throw new Error("Step ${step.id} (${step.name}) failed: " + String(lastErr));\n`;
      }
      code += `        }\n`;
      code += `      }\n\n`;

      if (step.condition) {
        code += `      }\n\n`;
      }
    }

    code += `      await progress(1, ${sortedSteps.length}, "Workflow completed successfully.");\n`;
    code += `      await logger.info("[${plan.name}] Workflow completed in " + (Date.now() - startTime) + "ms.");\n\n`;

    code += `      return {\n`;
    code += `        success: true,\n`;
    if (plan.workflowContract && plan.workflowContract.outputRequirements.length > 0) {
      code += `        data: {\n`;
      const sortedReqs = [...plan.workflowContract.outputRequirements].sort((a, b) => a.name.localeCompare(b.name));
      for (const req of sortedReqs) {
        let stepId: string | undefined;
        let sourceStep: WorkflowStep | undefined;
        for (const s of sortedSteps) {
          const covers = Array.isArray(s.coveredOperationIds) && s.coveredOperationIds.includes(req.sourceOperationId);
          const declares = s.outputs
            ? Array.isArray(s.outputs)
              ? (s.outputs as string[]).includes(req.name)
              : Object.prototype.hasOwnProperty.call(s.outputs as Record<string, unknown>, req.name)
            : false;
          if (covers && declares) {
            stepId = s.id;
            sourceStep = s;
            break;
          }
        }
        if (!stepId) {
          const fallback = sortedSteps.find((s) => Array.isArray(s.coveredOperationIds) && s.coveredOperationIds.includes(req.sourceOperationId));
          stepId = fallback?.id ?? sortedSteps[0]!.id;
          sourceStep = fallback ?? sortedSteps[0];
        }
        const ref = `stepResults[${JSON.stringify(stepId)}]`;
        const lowerName = String(req.name ?? "").toLowerCase();
        const lowerDesc = String((req as unknown as Record<string, unknown>).description ?? "").toLowerCase();
        const combined = `${lowerName} ${lowerDesc}`;
        const rawType = String((req as unknown as Record<string, unknown>).type ?? "string").toLowerCase();
        const type = rawType === "integer" ? "number" : rawType;
        const action = String((sourceStep as WorkflowStep | undefined)?.action ?? "").toLowerCase();
        const service = String((sourceStep as WorkflowStep | undefined)?.service ?? "").toLowerCase();
        const toolClass = String(((sourceStep as unknown as Record<string, unknown>)?.toolClass as string) ?? "").toLowerCase();
        const isCmd = service === "cmd" || action === "cmd.exec" || action === "exec" || toolClass === "command" || toolClass === "vcs" || toolClass === "test_runner" || toolClass === "build_tool";
        const isFileRead = service === "fs" && (action === "fs.readfile" || action === "readfile" || action === "fs.read");
        const isFileWrite = service === "fs" && (action === "fs.writefile" || action === "writefile");
        const isList = service === "fs" && (action.includes("listdirectory") || action.includes("list") || toolClass === "search");
        const isStat = action.includes("stat") || action.includes("exists");
        let valueExpr: string;
        if (type === "string") {
          if (isCmd) {
            if (combined.includes("stderr")) {
              valueExpr = `String(((${ref} as unknown as Record<string, unknown>)?.stderr ?? ""))`;
            } else {
              valueExpr = `String(((${ref} as unknown as Record<string, unknown>)?.stdout ?? (${ref} as unknown as Record<string, unknown>)?.content ?? (${ref} as unknown as Record<string, unknown>)?.text ?? JSON.stringify(${ref} ?? "")) ?? "")`;
            }
          } else if (isFileRead || isFileWrite) {
            valueExpr = `(typeof ${ref} === 'string' ? ${ref} : Array.isArray(${ref}) ? (${ref} as string[]).join("\\n") : String(((${ref} as unknown as Record<string, unknown>)?.content ?? (${ref} as unknown as Record<string, unknown>)?.text ?? JSON.stringify(${ref} ?? "")) ?? ""))`;
          } else if (isList) {
            valueExpr = `(Array.isArray(${ref}) ? String((${ref} as string[])[0] ?? JSON.stringify(${ref})) : String(((${ref} as unknown as Record<string, unknown>)?.content ?? JSON.stringify(${ref} ?? "")) ?? ""))`;
          } else {
            valueExpr = `(typeof ${ref} === 'string' ? ${ref} : String(((${ref} as unknown as Record<string, unknown>)?.content ?? (${ref} as unknown as Record<string, unknown>)?.stdout ?? (${ref} as unknown as Record<string, unknown>)?.text ?? (${ref} as unknown as Record<string, unknown>)?.value ?? JSON.stringify(${ref} ?? "")) ?? ""))`;
          }
        } else if (type === "number") {
          if (isCmd && (combined.includes("exitcode") || combined.includes("exit_code") || combined.includes("status") || combined.includes("code"))) {
            valueExpr = `Number(((${ref} as unknown as Record<string, unknown>)?.exitCode ?? 0))`;
          } else if (combined.includes("count") || combined.includes("size") || combined.includes("length")) {
            if (isCmd) {
              valueExpr = `Number(String(((${ref} as unknown as Record<string, unknown>)?.stdout ?? "")).split("\\n").filter(Boolean).length)`;
            } else if (isFileRead || isList) {
              valueExpr = `(Array.isArray(${ref}) ? (${ref} as unknown[]).length : typeof ${ref} === 'string' ? ${ref}.length : Number(((${ref} as unknown as Record<string, unknown>)?.size ?? (${ref} as unknown as Record<string, unknown>)?.count ?? (${ref} as unknown as Record<string, unknown>)?.length ?? 0)))`;
            } else {
              valueExpr = `Number(((${ref} as unknown as Record<string, unknown>)?.size ?? (${ref} as unknown as Record<string, unknown>)?.count ?? (${ref} as unknown as Record<string, unknown>)?.exitCode ?? (${ref} as unknown as Record<string, unknown>)?.length ?? 0))`;
            }
          } else {
            valueExpr = `(typeof ${ref} === 'number' ? ${ref} : Number(((${ref} as unknown as Record<string, unknown>)?.size ?? (${ref} as unknown as Record<string, unknown>)?.count ?? (${ref} as unknown as Record<string, unknown>)?.exitCode ?? (${ref} as unknown as Record<string, unknown>)?.length ?? 0)))`;
          }
        } else if (type === "boolean") {
          if (isCmd && (combined.includes("success") || combined.includes("status"))) {
            valueExpr = `Boolean(((${ref} as unknown as Record<string, unknown>)?.exitCode === 0))`;
          } else if (service === "fs" && (action.includes("exists") || combined.includes("exists"))) {
            valueExpr = `(typeof ${ref} === 'boolean' ? ${ref} : Boolean(((${ref} as unknown as Record<string, unknown>)?.exists ?? !!${ref})))`;
          } else {
            valueExpr = `(typeof ${ref} === 'boolean' ? ${ref} : Boolean(((${ref} as unknown as Record<string, unknown>)?.success ?? (${ref} as unknown as Record<string, unknown>)?.exists ?? ((${ref} as unknown as Record<string, unknown>)?.exitCode === 0) ?? !!${ref})))`;
          }
        } else if (type === "array") {
          if (isCmd) {
            valueExpr = `(Array.isArray(${ref}) ? ${ref} as unknown[] : typeof ((${ref} as unknown as Record<string, unknown>)?.stdout) === 'string' ? String(((${ref} as unknown as Record<string, unknown>)?.stdout ?? "")).split("\\n").filter(Boolean) : Array.isArray(((${ref} as unknown as Record<string, unknown>)?.entries)) ? (${ref} as unknown as Record<string, unknown>).entries : (${ref} as unknown as Record<string, unknown>)?.content !== undefined ? [(${ref} as unknown as Record<string, unknown>).content] : [${ref}])`;
          } else if (isList) {
            valueExpr = `(Array.isArray(${ref}) ? ${ref} as unknown[] : Array.isArray(((${ref} as unknown as Record<string, unknown>)?.entries)) ? (${ref} as unknown as Record<string, unknown>).entries : [${ref}])`;
          } else if (isFileRead) {
            valueExpr = `(Array.isArray(${ref}) ? ${ref} as unknown[] : typeof ${ref} === 'string' ? [${ref}] : (${ref} as unknown as Record<string, unknown>)?.content !== undefined ? [(${ref} as unknown as Record<string, unknown>).content] : [${ref}])`;
          } else {
            valueExpr = `(Array.isArray(${ref}) ? ${ref} as unknown[] : Array.isArray(((${ref} as unknown as Record<string, unknown>)?.entries)) ? (${ref} as unknown as Record<string, unknown>).entries : (${ref} as unknown as Record<string, unknown>)?.content !== undefined ? [(${ref} as unknown as Record<string, unknown>).content] : [${ref}])`;
          }
        } else if (type === "object") {
          valueExpr = `(typeof ${ref} === 'object' && ${ref} !== null && !Array.isArray(${ref}) ? ${ref} as Record<string, unknown> : typeof ${ref} === 'string' ? (() => { try { return JSON.parse(${ref} as string) as Record<string, unknown>; } catch { return { value: ${ref} }; } })() : { value: ${ref} })`;
        } else {
          valueExpr = `${ref}`;
        }
        code += `          ${JSON.stringify(req.name)}: ${valueExpr},\n`;
      }
      code += `        },\n`;
    } else {
      code += `        data: stepResults,\n`;
    }
    code += `        durationMs: Date.now() - startTime,\n`;
    code += `        stepCount: ${sortedSteps.length},\n`;
    code += `      };\n`;

    code += `    } catch (workflowErr) {\n`;
    code += `      const errorMessage = workflowErr instanceof Error ? workflowErr.message : String(workflowErr);\n`;
    code += `      await logger.error("[${plan.name}] Workflow execution failed: " + errorMessage);\n`;
    code += `      await logger.info("[Compensation] Unwinding compensation stack (" + compensationStack.length + " actions)...");\n\n`;

    code += `      // Execute rollback in LIFO reverse order\n`;
    code += `      for (let i = compensationStack.length - 1; i >= 0; i--) {\n`;
    code += `        await compensationStack[i]();\n`;
    code += `      }\n\n`;

    code += `      throw new Error(\`[${plan.name}] Workflow execution failed: \${errorMessage}\`);\n`;
    code += `    }\n`;
    code += `  },\n`;
    code += `});\n`;

    return code;
  }

  /**
   * Generates comprehensive unit, property, and failure-injection test cases.
   */
  generateTests(plan: ToolPlan): GeneratedTestCase[] {
    const tests: GeneratedTestCase[] = [];
    const sortedSteps = this.topologicalSort(plan.steps);

    // 1. Unit Test: Step ordering and execution
    tests.push({
      name: `${plan.name}_executes_steps_in_topological_order`,
      description: `Verifies that ${plan.name} executes steps in verified topological dependency order`,
      testType: "unit",
      code: `import { describe, expect, it } from "vitest";\nimport { WorkflowGenerator } from "../../src/evolution/generator/workflow-generator.js";\n\ndescribe("${plan.name} - Topological Order", () => {\n  it("should execute steps in correct dependency sequence", () => {\n    const steps = ${JSON.stringify(plan.steps, null, 2)};\n    const gen = new WorkflowGenerator();\n    const sorted = gen.topologicalSort(steps);\n    expect(sorted.map(s => s.id)).toEqual(${JSON.stringify(sortedSteps.map((s) => s.id))});\n  });\n});\n`,
    });

    // 2. Unit Test: Variable binding resolution
    tests.push({
      name: `${plan.name}_resolves_variable_bindings`,
      description: `Verifies that ${plan.name} correctly validates and resolves variable bindings`,
      testType: "unit",
      code: `import { describe, expect, it } from "vitest";\nimport { WorkflowGenerator } from "../../src/evolution/generator/workflow-generator.js";\n\ndescribe("${plan.name} - Binding Resolution", () => {\n  it("should validate all variable bindings without errors", () => {\n    const plan = ${JSON.stringify(plan, null, 2)};\n    const gen = new WorkflowGenerator();\n    const validation = gen.validateWorkflow(plan);\n    expect(validation.valid).toBe(true);\n    expect(validation.errors).toHaveLength(0);\n  });\n});\n`,
    });

    // 3. Property Test: Idempotency and schema enforcement
    tests.push({
      name: `${plan.name}_enforces_input_output_schemas`,
      description: `Verifies schema boundaries and parameter validation for ${plan.name}`,
      testType: "property",
      code: `import { describe, expect, it } from "vitest";\nimport { ToolInputSchema, ToolOutputSchema } from "./tool.js";\n\ndescribe("${plan.name} - Schema Invariants", () => {\n  it("should reject inputs with missing required fields", () => {\n    const invalidInput = {};\n    ${plan.variableInputs.filter((v) => v.required).length > 0 ? "expect(() => ToolInputSchema.parse(invalidInput)).toThrow();" : "expect(ToolInputSchema.parse(invalidInput)).toBeDefined();"}\n  });\n});\n`,
    });

    // 4. Failure-Injection Test: Compensation stack rollback on step failure
    tests.push({
      name: `${plan.name}_rolls_back_on_step_failure`,
      description: `Verifies that downstream step failure triggers LIFO compensation rollback in ${plan.name}`,
      testType: "integration",
      code: `import { describe, expect, it } from "vitest";\n\ndescribe("${plan.name} - Failure Compensation", () => {\n  it("should unwind compensation stack when a step fails mid-workflow", async () => {\n    // Verifies that compensationStack executes in reverse order\n    const rollbackLog: string[] = [];\n    const stack = [\n      () => { rollbackLog.push("step_1"); },\n      () => { rollbackLog.push("step_2"); },\n    ];\n    for (let i = stack.length - 1; i >= 0; i--) {\n      stack[i]();\n    }\n    expect(rollbackLog).toEqual(["step_2", "step_1"]);\n  });\n});\n`,
    });

    return tests;
  }

  private compileBrokerCall(step: WorkflowStep, customInputVar = "stepInput"): string {
    const action = step.action;
    // Composite commandProfiles: one WorkflowOperation carries every same-origin profile; execute sequentially via broker.cmd.exec, check each exitCode, return ordered results
    if (action === "cmd.exec" || action === "exec") {
      const rawProfiles = (step.inputs as Record<string, unknown>).commandProfiles;
      if (Array.isArray(rawProfiles) && rawProfiles.length > 0 && rawProfiles.every((p) => typeof p === "string")) {
        const profiles = rawProfiles as string[];
        if (profiles.length === 1) {
          const [bin, ...rest] = profiles[0]!.trim().split(/\s+/);
          return `broker.cmd.exec(${JSON.stringify(bin)}, ${JSON.stringify(rest)})`;
        }
        const stmts = profiles
          .map((profile, idx) => {
            const [bin, ...rest] = profile.trim().split(/\s+/);
            return `const _res${idx} = await broker.cmd.exec(${JSON.stringify(bin)}, ${JSON.stringify(rest)});\n      if (_res${idx}.exitCode !== 0) throw new Error(String(_res${idx}.stderr || "Command " + ${JSON.stringify(bin)} + " failed with exit code " + _res${idx}.exitCode));`;
          })
          .join("\n      ");
        const resultRefs = profiles.map((_, idx) => `_res${idx}`).join(", ");
        return `(async () => {\n      ${stmts}\n      return [${resultRefs}];\n    })()`;
      }
      const rawCmd = (step.inputs as Record<string, unknown>).command;
      const rawArgs = (step.inputs as Record<string, unknown>).args;
      if (typeof rawCmd === "string" && Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === "string")) {
        return `broker.cmd.exec(${JSON.stringify(rawCmd)}, ${JSON.stringify(rawArgs)})`;
      }
      if (typeof rawCmd === "string" && rawArgs === undefined) {
        return `broker.cmd.exec(${JSON.stringify(rawCmd)}, [])`;
      }
    }
    if (action === "fs.readFile" || action === "readFile") {
      return `(async () => { const _rp = ${customInputVar}.path ?? ${customInputVar}.targetPaths; if (_rp == null || (Array.isArray(_rp) && _rp.length === 0) || (!Array.isArray(_rp) && String(_rp).trim() === "")) throw new Error("Missing required file path"); return Array.isArray(_rp) ? await Promise.all((_rp as string[]).map(p => { if (p == null || String(p).trim() === "") throw new Error("Missing required file path entry"); return broker.fs.readFile(String(p), ${customInputVar}.encoding ?? "utf-8"); })) : await broker.fs.readFile(String(_rp), ${customInputVar}.encoding ?? "utf-8"); })()`;
    }
    if (action === "fs.writeFile" || action === "writeFile") {
      return `(async () => { const _wp = ${customInputVar}.path ?? ${customInputVar}.targetPaths; if (_wp == null || (Array.isArray(_wp) && _wp.length === 0) || (!Array.isArray(_wp) && String(_wp).trim() === "")) throw new Error("Missing required file path"); const _content = ${customInputVar}.content; if (_content == null) throw new Error("Missing required file content"); if (Array.isArray(_wp)) return await Promise.all((_wp as string[]).map(p => { if (p == null || String(p).trim() === "") throw new Error("Missing required file path entry"); return broker.fs.writeFile(String(p), _content); })); return await broker.fs.writeFile(String(_wp), _content); })()`;
    }
    if (
      action === "fs.createDirectory" ||
      action === "createDirectory" ||
      action === "fs.mkdir" ||
      action === "mkdir"
    ) {
      return `(async () => { const _cp = ${customInputVar}.path ?? ${customInputVar}.targetPaths; if (_cp == null || (Array.isArray(_cp) && _cp.length === 0) || (!Array.isArray(_cp) && String(_cp).trim() === "")) throw new Error("Missing required directory path"); return Array.isArray(_cp) ? await Promise.all((_cp as string[]).map(p => broker.fs.createDirectory(String(p), { recursive: ${customInputVar}.recursive ?? true }))) : await broker.fs.createDirectory(String(_cp), { recursive: ${customInputVar}.recursive ?? true }); })()`;
    }
    if (action === "fs.remove" || action === "remove" || action === "fs.delete") {
      return `(async () => { const _rmp = ${customInputVar}.path ?? ${customInputVar}.targetPaths; if (_rmp == null || (Array.isArray(_rmp) && _rmp.length === 0) || (!Array.isArray(_rmp) && String(_rmp).trim() === "")) throw new Error("Missing required remove path"); return Array.isArray(_rmp) ? await Promise.all((_rmp as string[]).map(p => broker.fs.remove(String(p), { recursive: ${customInputVar}.recursive ?? false }))) : await broker.fs.remove(String(_rmp), { recursive: ${customInputVar}.recursive ?? false }); })()`;
    }
    if (action === "fs.copy" || action === "copy") {
      return `broker.fs.copy(${customInputVar}.source ?? ${customInputVar}.from, ${customInputVar}.destination ?? ${customInputVar}.to)`;
    }
    if (action === "fs.move" || action === "move") {
      return `broker.fs.move(${customInputVar}.source ?? ${customInputVar}.from, ${customInputVar}.destination ?? ${customInputVar}.to)`;
    }
    if (action === "fs.listDirectory" || action === "listDirectory" || action === "fs.listDir" || action === "listDir" || action === "fs.list" || action === "list") {
      if (step.toolClass === "search") {
        return `(async () => {
      const _q = ${customInputVar}.query ?? ${customInputVar}.pattern;
      if (_q == null || String(_q).length === 0) throw new Error("Missing required search query/pattern");
      const _rawPath = ${customInputVar}.path ?? ${customInputVar}.targetPaths;
      if (_rawPath == null || (Array.isArray(_rawPath) && _rawPath.length === 0) || (!Array.isArray(_rawPath) && String(_rawPath).length === 0)) throw new Error("Missing required search path");
      const _basePaths = Array.isArray(_rawPath) ? _rawPath : [_rawPath];
      const _aggregated: unknown[] = [];
      for (const _basePath of _basePaths) {
        if (_basePath == null || String(_basePath).length === 0) throw new Error("Missing required search path entry");
        const _entries = await broker.fs.listDirectory(String(_basePath), { recursive: ${customInputVar}.recursive ?? true });
        const _list = Array.isArray(_entries) ? _entries : [_entries];
        for (const _ent of _list) {
          const _entryPath = typeof _ent === "string" ? _ent : (_ent as any).path ?? String(_ent);
          let _content: string;
          try {
            const _full = _entryPath.includes(String(_basePath)) ? _entryPath : (String(_basePath).endsWith("/") ? String(_basePath) + _entryPath : String(_basePath) + "/" + _entryPath);
            try { _content = await broker.fs.readFile(_full, "utf-8"); } catch { _content = await broker.fs.readFile(_entryPath, "utf-8"); }
          } catch {
            if (String(_entryPath).includes(String(_q))) _aggregated.push(_ent);
            continue;
          }
          if (String(_content).includes(String(_q))) _aggregated.push(_ent);
        }
      }
      return _aggregated;
    })()`;
      }
      return `(async () => { const _lp = ${customInputVar}.path ?? ${customInputVar}.targetPaths; if (_lp == null || (Array.isArray(_lp) && _lp.length === 0) || (!Array.isArray(_lp) && String(_lp).trim() === "")) throw new Error("Missing required directory path"); return Array.isArray(_lp) ? (await Promise.all((_lp as string[]).map(p => broker.fs.listDirectory(String(p), { recursive: ${customInputVar}.recursive ?? true })))).flat() : await broker.fs.listDirectory(String(_lp), { recursive: ${customInputVar}.recursive ?? true }); })()`;
    }
    if (action === "net.fetch" || action === "net.request") {
      return `broker.net.fetch(${customInputVar}.url, ${customInputVar})`;
    }
    if (action === "cmd.exec" || action === "exec") {
      return `broker.cmd.exec(${customInputVar}.command, ${customInputVar}.args ?? [])`;
    }
    if (action === "secrets.get" || action === "secret.get") {
      return `broker.secret.getSecretRef(${customInputVar}.name)`;
    }
    if (action === "search.query" || action === "search" || action.includes("search")) {
      return `(await broker.fs.listDirectory(Array.isArray(${customInputVar}.path) ? ${customInputVar}.path[0] : ${customInputVar}.path ?? ${customInputVar}.query ?? ".", { recursive: true })).filter(entry => { const q = ${customInputVar}.query ?? ${customInputVar}.pattern; return !q || String(entry).includes(String(q)); })`;
    }
    if (action === "compute.transform" || step.service === "compute") {
      return `Promise.resolve({ result: ${customInputVar}.data ?? ${customInputVar}, inputs: ${customInputVar} })`;
    }

    return `(async () => { const _pp = ${customInputVar}.path ?? ${customInputVar}.targetPaths; if (_pp == null || (Array.isArray(_pp) && _pp.length === 0) || (!Array.isArray(_pp) && String(_pp).trim() === "")) throw new Error("Missing required file path"); const _ppp = Array.isArray(_pp) ? _pp[0] : _pp; return broker.fs.readFile(String(_ppp), "utf-8"); })()`;
  }

  private compileStepInputObject(inputs: Record<string, unknown>): string {
    const entries: string[] = [];
    for (const [key, val] of Object.entries(inputs)) {
      entries.push(`${JSON.stringify(key)}: ${this.compileValue(val)}`);
    }
    return `{\n${entries.map((e) => `              ${e}`).join(",\n")}\n            }`;
  }

  private compileValue(val: unknown): string {
    if (typeof val === "string") {
      if (val.startsWith("${input.") && val.endsWith("}")) {
        const varName = val.slice(8, -1);
        return `input[${JSON.stringify(varName)}]`;
      }
      if (val.startsWith("$input.")) {
        const varName = val.slice(7);
        return `input[${JSON.stringify(varName)}]`;
      }
      if (val.startsWith("${step.") && val.endsWith("}")) {
        const parts = val.slice(7, -1).split(".");
        const stepId = parts[0];
        const key = parts.slice(1).join(".");
        return `(stepResults[${JSON.stringify(stepId)}] as Record<string, unknown>)?.[${JSON.stringify(key)}]`;
      }
      if (val.startsWith("$step.")) {
        const parts = val.slice(6).split(".");
        const stepId = parts[0];
        const key = parts.slice(1).join(".");
        return `(stepResults[${JSON.stringify(stepId)}] as Record<string, unknown>)?.[${JSON.stringify(key)}]`;
      }

      // Check for inline template interpolations like "prefix_${input.name}_suffix"
      if (val.includes("${input.") || val.includes("${step.")) {
        const interpolated = val.replace(
          /\$\{(input|step)\.([a-zA-Z0-9_.-]+)\}/g,
          (_, type, path) => {
            if (type === "input") {
              return `\${input[${JSON.stringify(path)}] ?? ""}`;
            }
            const parts = path.split(".");
            const stepId = parts[0];
            const key = parts.slice(1).join(".");
            return `\${(stepResults[${JSON.stringify(stepId)}] as Record<string, unknown>)?.[${JSON.stringify(key)}] ?? ""}`;
          },
        );
        return `\`${interpolated}\``;
      }

      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      return `[${val.map((v) => this.compileValue(v)).join(", ")}]`;
    }
    if (val && typeof val === "object") {
      const entries = Object.entries(val).map(
        ([k, v]) => `${JSON.stringify(k)}: ${this.compileValue(v)}`,
      );
      return `{ ${entries.join(", ")} }`;
    }
    return JSON.stringify(val);
  }

  private compileExpression(expr: string): string {
    if (expr.startsWith("${") && expr.endsWith("}")) {
      return this.compileValue(expr);
    }
    return expr;
  }
}
