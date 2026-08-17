import {
  type ToolSynthesisOutput,
  ToolSynthesisOutputSchema,
} from "../../models/prompt-registry.js";
import type { InferenceService } from "../../models/service.js";
import type { InferenceProvenance, ModelUsage } from "../../models/types.js";
import { SchemaGenerator } from "./schema-generator.js";
import type { ToolPlan } from "./types.js";
import { WorkflowGenerator } from "./workflow-generator.js";

/**
 * Result of asynchronous code generation.
 */
export interface GeneratedSourceResult {
  sourceCode: string;
  provenance?: InferenceProvenance;
  usage?: ModelUsage;
}

/**
 * Generates TypeScript source code for single tools and workflow tools targeting @tool-evolver/runtime SDK.
 */
export class CodeGenerator {
  private readonly schemaGenerator: SchemaGenerator;
  private readonly workflowGenerator: WorkflowGenerator;
  private readonly inferenceService?: InferenceService;

  constructor(
    schemaGenerator?: SchemaGenerator,
    workflowGenerator?: WorkflowGenerator,
    inferenceService?: InferenceService,
  ) {
    this.schemaGenerator = schemaGenerator ?? new SchemaGenerator();
    this.workflowGenerator = workflowGenerator ?? new WorkflowGenerator(this.schemaGenerator);
    this.inferenceService = inferenceService;
  }

  /**
   * Generates TypeScript source code asynchronously using structured model synthesis when available.
   */
  async generateSourceAsync(
    plan: ToolPlan,
    options: {
      tenantId?: string;
      inferenceService?: InferenceService;
      workflowEvidence?: string;
    } = {},
  ): Promise<GeneratedSourceResult> {
    if (plan.targetType === "workflow") {
      return {
        sourceCode: this.workflowGenerator.generateWorkflowSource(plan),
      };
    }

    const inferService = options.inferenceService ?? this.inferenceService;
    if (!inferService) {
      return {
        sourceCode: this.generateSingleToolSource(plan),
      };
    }

    try {
      const promptInput = {
        planId: plan.id,
        specification: `Tool Name: ${plan.name}\nDescription: ${plan.description}\nIntent: ${plan.intent}\nInput Schema: ${JSON.stringify(plan.inputSchema)}\nOutput Schema: ${JSON.stringify(plan.outputSchema)}`,
        existingCode: "",
        toolName: plan.name,
        workflowEvidence: options.workflowEvidence ?? plan.intent,
      };

      const response = await inferService.infer<Record<string, unknown>, ToolSynthesisOutput>({
        tenantId: options.tenantId ?? plan.workspaceId,
        taskClass: "tool_synthesis",
        promptTemplateId: "tool_synthesis",
        inputs: promptInput,
      });

      const parsed = ToolSynthesisOutputSchema.parse(response.output);

      // If the model produced a full valid tool module with defineTool and imports
      if (
        parsed.code &&
        parsed.code.includes("defineTool") &&
        parsed.code.includes("export default defineTool")
      ) {
        return {
          sourceCode: parsed.code,
          provenance: response.provenance,
          usage: response.provenance.usage,
        };
      }

      // If the model produced transformation logic or helper code, embed into standard SDK structure
      const inputZodSource = this.schemaGenerator.generateZodSource(plan.inputSchema);
      const outputZodSource = this.schemaGenerator.generateOutputZodSource(plan.outputSchema);

      const customLogic = parsed.transformationLogic || parsed.executionBody || parsed.code;
      const helperCode = parsed.helperFunctions || "";

      let executionBody = "";
      if (customLogic && !customLogic.includes("defineTool")) {
        executionBody = `
    ${customLogic}
    if (typeof resultData === "undefined") {
      resultData = {
        computed: true,
        tool: ${JSON.stringify(plan.name)},
        data: input,
      };
    }`;
      } else {
        executionBody = this.deriveTransformationBody(plan);
      }

      const sourceCode = `/**
 * Synthesized Tool: ${plan.name}
 * Description: ${plan.description}
 * Intent: ${plan.intent}
 */

import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

/**
 * Input validation schema.
 */
export const InputSchema = ${inputZodSource};

/**
 * Output validation schema.
 */
export const OutputSchema = ${outputZodSource};

export type ToolInput = z.infer<typeof InputSchema>;
export type ToolOutput = z.infer<typeof OutputSchema>;

${helperCode}

/**
 * Tool execution handler.
 */
export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;
  await progress(0, "Starting execution", "running");

  try {
    let resultData: Record<string, unknown> | unknown[];
${executionBody}

    await progress(100, "Execution finished successfully", "complete");
    await logger.info("Tool finished successfully", { toolName: ${JSON.stringify(plan.name)} });

    return {
      success: true,
      data: resultData,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logger.error("Tool execution failed", { error: errorMessage });
    throw new Error(\`[\${${JSON.stringify(plan.name)}}] Execution error: \${errorMessage}\`);
  }
});
`;

      return {
        sourceCode,
        provenance: response.provenance,
        usage: response.provenance.usage,
      };
    } catch {
      return {
        sourceCode: this.generateSingleToolSource(plan),
      };
    }
  }

  /**
   * Generates TypeScript source for a single tool handler or workflow.
   */
  generateSource(plan: ToolPlan): string {
    if (plan.targetType === "workflow") {
      return this.workflowGenerator.generateWorkflowSource(plan);
    }

    return this.generateSingleToolSource(plan);
  }

  /**
   * Generates TypeScript source for a single tool handler.
   */
  private generateSingleToolSource(plan: ToolPlan): string {
    const inputZodSource = this.schemaGenerator.generateZodSource(plan.inputSchema);
    const outputZodSource = this.schemaGenerator.generateOutputZodSource(plan.outputSchema);

    const step = plan.steps[0];
    const action = step?.action ?? "compute";
    const toolClass = step?.toolClass ?? "compute";

    let executionBody = "";

    if (action === "fs.readFile" || toolClass === "file_read") {
      executionBody = `
    const filePath = (input as Record<string, unknown>).path as string ?? (input as Record<string, unknown>).filePath as string ?? ".";
    await logger.debug("Reading file from filesystem broker", { filePath });
    const content = await broker.fs.readFile(filePath, "utf-8");
    resultData = {
      path: filePath,
      content,
      size: typeof content === "string" ? content.length : 0,
    };`;
    } else if (action === "fs.writeFile" || toolClass === "file_edit") {
      executionBody = `
    const filePath = (input as Record<string, unknown>).path as string ?? (input as Record<string, unknown>).filePath as string ?? "./output.txt";
    const content = (input as Record<string, unknown>).content as string ?? "";
    await logger.debug("Writing file to filesystem broker", { filePath, byteLength: content.length });
    await broker.fs.writeFile(filePath, content);
    resultData = {
      path: filePath,
      written: true,
      bytes: content.length,
    };`;
    } else if (
      action === "cmd.exec" ||
      toolClass === "command" ||
      toolClass === "test_runner" ||
      toolClass === "build_tool" ||
      toolClass === "vcs"
    ) {
      executionBody = `
    const command = (input as Record<string, unknown>).command as string ?? (input as Record<string, unknown>).cmd as string ?? ${JSON.stringify(step?.inputs.command ?? "echo 'done'")};
    const args = ((input as Record<string, unknown>).args as string[]) ?? [];
    await logger.debug("Executing command via command broker", { command, args });
    const res = await broker.cmd.exec(command, args);
    resultData = {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
    };`;
    } else if (action === "net.fetch" || toolClass === "network") {
      executionBody = `
    const url = (input as Record<string, unknown>).url as string ?? ${JSON.stringify(step?.inputs.url ?? "https://api.example.com")};
    await logger.debug("Fetching network resource", { url });
    const response = await broker.net.fetch(url);
    const json = await response.json();
    resultData = {
      status: response.status,
      data: json,
    };`;
    } else {
      executionBody = this.deriveTransformationBody(plan);
    }

    return `/**
 * Synthesized Tool: ${plan.name}
 * Description: ${plan.description}
 * Intent: ${plan.intent}
 */

import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

/**
 * Input validation schema.
 */
export const InputSchema = ${inputZodSource};

/**
 * Output validation schema.
 */
export const OutputSchema = ${outputZodSource};

export type ToolInput = z.infer<typeof InputSchema>;
export type ToolOutput = z.infer<typeof OutputSchema>;

/**
 * Tool execution handler.
 */
export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;
  await logger.info("Executing tool", { toolName: ${JSON.stringify(plan.name)} });
  await progress(0, "Starting execution", "running");

  try {
    let resultData: Record<string, unknown> | unknown[];
${executionBody}

    await progress(100, "Execution finished successfully", "complete");
    await logger.info("Tool finished successfully", { toolName: ${JSON.stringify(plan.name)} });

    return {
      success: true,
      data: resultData as Record<string, unknown>,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logger.error("Tool execution failed", { error: errorMessage });
    throw new Error(\`[\${${JSON.stringify(plan.name)}}] Execution error: \${errorMessage}\`);
  }
});
`;
  }

  /**
   * Derives workflow-specific pure transformation logic from plan variables and properties.
   */
  private deriveTransformationBody(plan: ToolPlan): string {
    const properties = plan.inputSchema.properties ?? {};
    const propNames = Object.keys(properties);

    // Case 1: Array of numbers (e.g. statistical distribution or metric calculation)
    const arrayNumProp = propNames.find((k) => properties[k]?.type === "array");
    if (
      arrayNumProp ||
      plan.name.includes("stat") ||
      plan.name.includes("distribution") ||
      plan.name.includes("metric")
    ) {
      const key = arrayNumProp ?? "values";
      return `
    await logger.debug("Executing pure mathematical transformation", { toolName: ${JSON.stringify(plan.name)} });
    const rawArr = (input as Record<string, unknown>)[${JSON.stringify(key)}];
    const nums: number[] = Array.isArray(rawArr)
      ? rawArr.map((v) => Number(v)).filter((n) => !Number.isNaN(n))
      : [];

    const count = nums.length;
    const sum = nums.reduce((acc, val) => acc + val, 0);
    const mean = count > 0 ? sum / count : 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const min = count > 0 ? sorted[0] : 0;
    const max = count > 0 ? sorted[count - 1] : 0;
    const median = count > 0 ? (count % 2 === 0 ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2 : sorted[Math.floor(count / 2)]) : 0;
    const variance = count > 0 ? nums.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / count : 0;
    const stdDev = Math.sqrt(variance);

    resultData = {
      count,
      sum,
      mean,
      min,
      max,
      median,
      variance,
      stdDev,
      transformed: nums.map((n) => ({ original: n, normalized: stdDev > 0 ? (n - mean) / stdDev : 0 })),
    };`;
    }

    // Case 2: Array of objects or records (e.g. data filtering, transformation, mapping)
    if (
      plan.name.includes("filter") ||
      plan.name.includes("transform") ||
      plan.name.includes("map") ||
      plan.name.includes("json")
    ) {
      return `
    await logger.debug("Executing pure data transformation", { toolName: ${JSON.stringify(plan.name)} });
    const inputRecord = input as Record<string, unknown>;
    const rawItems = inputRecord.items ?? inputRecord.records ?? inputRecord.data;
    const items = Array.isArray(rawItems) ? rawItems : Object.entries(inputRecord);

    const filterMode = String(inputRecord.filterMode ?? "all");
    const transformed = items.map((item, idx) => {
      if (typeof item === "object" && item !== null) {
        return { ...item, _index: idx };
      }
      return { value: item, _index: idx };
    });

    resultData = {
      count: transformed.length,
      mode: filterMode,
      transformed,
      summary: \`Processed \${transformed.length} items with mode \${filterMode}\`,
    };`;
    }

    // Case 3: Default pure transformation preserving inputs and producing structured result
    return `
    await logger.debug("Executing pure transformation tool", { toolName: ${JSON.stringify(plan.name)}, input });
    const inputEntries = Object.entries(input as Record<string, unknown>);
    const processedMap: Record<string, unknown> = {};
    for (const [key, value] of inputEntries) {
      if (typeof value === "string") {
        processedMap[key] = value.trim();
      } else if (Array.isArray(value)) {
        processedMap[key] = value.slice();
      } else {
        processedMap[key] = value;
      }
    }

    resultData = {
      computed: true,
      inputCount: inputEntries.length,
      processed: processedMap,
      processedCount: inputEntries.length,
    };`;
  }
}
