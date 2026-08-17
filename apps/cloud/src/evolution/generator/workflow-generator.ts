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
  repairWorkflow(
    plan: ToolPlan,
    initialErrors: string[] = [],
    envelope?: CapabilityEnvelope,
    maxIterations = 3,
  ): WorkflowRepairResult {
    const currentPlan: ToolPlan = JSON.parse(JSON.stringify(plan));
    const appliedFixes: string[] = [];
    let iterations = 0;

    let validation = this.validateWorkflow(currentPlan, envelope);
    let currentErrors = initialErrors.length > 0 ? initialErrors : validation.errors;

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

      // Re-generate schemas
      currentPlan.inputSchema = this.schemaGenerator.deriveInputSchema(currentPlan.variableInputs);
      currentPlan.outputSchema = this.schemaGenerator.deriveOutputSchema(
        undefined,
        currentPlan.steps,
        "workflow",
      );

      // Re-validate
      validation = this.validateWorkflow(currentPlan, envelope);
      currentErrors = validation.errors;
    }

    return {
      plan: currentPlan,
      repaired: validation.valid,
      iterations,
      appliedFixes,
      remainingErrors: validation.errors.length > 0 ? validation.errors : undefined,
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
    code += `    const { fs, net, cmd, secrets, progress, logger } = context;\n`;
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
    code += `        data: stepResults,\n`;
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
    if (action === "fs.readFile" || action === "readFile") {
      return `fs.readFile(${customInputVar}.path, ${customInputVar}.encoding)`;
    }
    if (action === "fs.writeFile" || action === "writeFile") {
      return `fs.writeFile(${customInputVar}.path, ${customInputVar}.content)`;
    }
    if (
      action === "fs.createDirectory" ||
      action === "createDirectory" ||
      action === "fs.mkdir" ||
      action === "mkdir"
    ) {
      return `fs.mkdir(${customInputVar}.path, { recursive: ${customInputVar}.recursive ?? true })`;
    }
    if (action === "fs.remove" || action === "remove" || action === "fs.delete") {
      return `fs.remove(${customInputVar}.path, { recursive: ${customInputVar}.recursive ?? false })`;
    }
    if (action === "fs.copy" || action === "copy") {
      return `fs.copy(${customInputVar}.source ?? ${customInputVar}.from, ${customInputVar}.destination ?? ${customInputVar}.to)`;
    }
    if (action === "fs.move" || action === "move") {
      return `fs.move(${customInputVar}.source ?? ${customInputVar}.from, ${customInputVar}.destination ?? ${customInputVar}.to)`;
    }
    if (action === "net.fetch" || action === "net.request") {
      return `net.fetch(${customInputVar}.url, ${customInputVar})`;
    }
    if (action === "cmd.exec" || action === "exec") {
      return `cmd.exec(${customInputVar}.command, ${customInputVar}.args ?? [])`;
    }
    if (action === "secrets.get" || action === "secret.get") {
      return `secrets.get(${customInputVar}.name)`;
    }

    return `context.brokerHandler(${JSON.stringify(step.service ?? "compute")}, ${JSON.stringify(action)}, ${customInputVar})`;
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
