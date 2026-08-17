import { SchemaGenerator } from "./schema-generator.js";
import type { ToolPlan, WorkflowStep } from "./types.js";

/**
 * Generates reusable workflow step graphs and executable TypeScript orchestrator source.
 */
export class WorkflowGenerator {
  private readonly schemaGenerator: SchemaGenerator;

  constructor(schemaGenerator?: SchemaGenerator) {
    this.schemaGenerator = schemaGenerator ?? new SchemaGenerator();
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
          throw new Error(`Step '${step.id}' depends on non-existent step '${depId}'`);
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
      const currId = queue.shift()!;
      const step = stepMap.get(currId)!;
      sorted.push(step);

      for (const nextId of dependents.get(currId) ?? []) {
        const newDeg = (inDegree.get(nextId) ?? 1) - 1;
        inDegree.set(nextId, newDeg);
        if (newDeg === 0) {
          queue.push(nextId);
        }
      }
    }

    if (sorted.length !== steps.length) {
      throw new Error("Cyclic dependency detected in workflow steps");
    }

    return sorted;
  }

  /**
   * Generates a reusable workflow definition object.
   */
  generateWorkflowDefinition(plan: ToolPlan): Record<string, unknown> {
    const sortedSteps = this.topologicalSort(plan.steps);
    return {
      id: plan.id,
      name: plan.name,
      intent: plan.intent,
      description: plan.description,
      version: "1.0.0",
      inputs: plan.inputSchema,
      outputs: plan.outputSchema,
      steps: sortedSteps.map((s) => ({
        id: s.id,
        name: s.name,
        action: s.action,
        toolClass: s.toolClass,
        inputs: s.inputs,
        dependsOn: s.dependsOn,
        outputVar: s.outputVar ?? s.id,
        compensation: s.compensation,
        retryPolicy: s.retryPolicy,
        condition: s.condition,
      })),
    };
  }

  /**
   * Generates orchestrating TypeScript source code for multi-step workflow execution.
   */
  generateWorkflowSource(plan: ToolPlan): string {
    const sortedSteps = this.topologicalSort(plan.steps);
    const inputZodSource = this.schemaGenerator.generateZodSource(plan.inputSchema);
    const outputZodSource = this.schemaGenerator.generateOutputZodSource(plan.outputSchema);

    const stepCodeBlocks: string[] = [];
    const stepCount = sortedSteps.length;

    sortedSteps.forEach((step, index) => {
      const progressStart = Math.floor((index / stepCount) * 100);
      const progressEnd = Math.floor(((index + 1) / stepCount) * 100);
      const outVar = step.outputVar ?? step.id.replace(/[^a-zA-Z0-9_]/g, "_");

      let actionCall = "";
      if (step.action === "fs.readFile") {
        const filePathExpr = this.resolveInputExpression(
          step.inputs.path ?? step.inputs.filePath ?? "filePath",
        );
        actionCall = `const ${outVar} = await broker.fs.readFile(${filePathExpr});`;
      } else if (step.action === "fs.writeFile") {
        const filePathExpr = this.resolveInputExpression(
          step.inputs.path ?? step.inputs.filePath ?? "filePath",
        );
        const contentExpr = this.resolveInputExpression(step.inputs.content ?? "content");
        actionCall = `await broker.fs.writeFile(${filePathExpr}, ${contentExpr});\n      const ${outVar} = { path: ${filePathExpr}, written: true };`;
      } else if (step.action === "cmd.exec") {
        const cmdExpr = this.resolveInputExpression(
          step.inputs.command ?? step.inputs.cmd ?? "cmd",
        );
        actionCall = `const ${outVar} = await broker.cmd.exec(${cmdExpr});`;
      } else if (step.action === "net.fetch") {
        const urlExpr = this.resolveInputExpression(step.inputs.url ?? "url");
        actionCall = `const res = await broker.net.fetch(${urlExpr});\n      const ${outVar} = await res.json();`;
      } else if (step.action === "secret.createReference" || step.action === "secret.getSecret") {
        const keyExpr = this.resolveInputExpression(
          step.inputs.name ?? step.inputs.key ?? "secretName",
        );
        actionCall = `const ${outVar} = broker.secret.createReference(${keyExpr});`;
      } else {
        // Generic / compute action
        actionCall = `const ${outVar} = { executed: true, step: ${JSON.stringify(step.name)}, inputs: input };`;
      }

      let compensationCode = "";
      if (step.compensation) {
        if (step.compensation.action === "fs.removeFile") {
          const compPathExpr = this.resolveInputExpression(
            step.compensation.inputs.path ?? step.compensation.inputs.filePath ?? "filePath",
          );
          compensationCode = `
      compensationStack.push(async () => {
        await logger.warn("Executing rollback compensation: removeFile", { path: ${compPathExpr} });
        await broker.fs.removeFile(${compPathExpr});
      });`;
        } else {
          compensationCode = `
      compensationStack.push(async () => {
        await logger.warn("Executing rollback compensation for step", { step: ${JSON.stringify(step.id)} });
      });`;
        }
      }

      stepCodeBlocks.push(`
      // --- Step ${index + 1}: ${step.name} (${step.id}) ---
      await progress(${progressStart}, "Executing step: ${step.name}", "${step.id}");
      await logger.info("Workflow step start", { stepId: ${JSON.stringify(step.id)}, action: ${JSON.stringify(step.action)} });
      ${actionCall}
      stepResults[${JSON.stringify(step.id)}] = ${outVar};${compensationCode}
      await progress(${progressEnd}, "Step complete: ${step.name}", "${step.id}");
`);
    });

    return `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

/**
 * Input validation schema.
 */
export const InputSchema = ${inputZodSource};
export type ToolInput = z.infer<typeof InputSchema>;

/**
 * Output validation schema.
 */
export const OutputSchema = ${outputZodSource};
export type ToolOutput = z.infer<typeof OutputSchema>;

/**
 * Orchestrating workflow tool: ${plan.name}
 * Intent: ${plan.intent}
 */
export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;
  const stepResults: Record<string, unknown> = {};
  const compensationStack: Array<() => Promise<void>> = [];

  await progress(0, "Starting workflow execution...", "init");
  await logger.info("Starting workflow execution", { toolName: ${JSON.stringify(plan.name)}, input });

  try {${stepCodeBlocks.join("")}
    await progress(100, "Workflow execution finished successfully", "complete");
    await logger.info("Workflow completed successfully", { toolName: ${JSON.stringify(plan.name)} });

    return {
      success: true,
      data: stepResults,
      stepResults,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logger.error("Workflow failed, executing compensations in reverse order", { error: errorMessage });

    for (let i = compensationStack.length - 1; i >= 0; i--) {
      try {
        await compensationStack[i]();
      } catch (compError) {
        await logger.warn("Step compensation failed", {
          index: i,
          compensationError: compError instanceof Error ? compError.message : String(compError),
        });
      }
    }

    throw new Error(\`[\${${JSON.stringify(plan.name)}}] Workflow execution failed: \${errorMessage}\`);
  }
});
`;
  }

  private resolveInputExpression(val: unknown): string {
    if (typeof val === "string") {
      if (val.startsWith("$input.")) {
        return `input.${val.substring(7)}`;
      }
      if (val.startsWith("$steps.")) {
        const parts = val.split(".");
        const stepId = parts[1];
        const key = parts.slice(2).join(".");
        return `(stepResults[${JSON.stringify(stepId)}] as Record<string, unknown>)?.[${JSON.stringify(key)}]`;
      }
      return JSON.stringify(val);
    }
    return JSON.stringify(val);
  }
}
