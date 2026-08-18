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
  toolName?: string;
  provenance?: InferenceProvenance;
  usage?: ModelUsage;
}

/**
 * Generates production-ready, sandboxed TypeScript tool code adhering to Deno runtime contracts.
 */
export class CodeGenerator {
  private readonly schemaGenerator: SchemaGenerator;
  private readonly workflowGenerator: WorkflowGenerator;

  constructor(
    schemaGenerator: SchemaGenerator = new SchemaGenerator(),
    workflowGenerator: WorkflowGenerator = new WorkflowGenerator(),
  ) {
    this.schemaGenerator = schemaGenerator;
    this.workflowGenerator = workflowGenerator;
  }

  /**
   * Generates TypeScript tool code asynchronously using structured inference when available.
   */
  async generateSourceAsync(
    plan: ToolPlan,
    options: {
      tenantId?: string;
      inferenceService?: InferenceService;
      workflowEvidence?: string;
      allowDeterministicFallback?: boolean;
    } = {},
  ): Promise<GeneratedSourceResult> {
    if (plan.targetType === "workflow") {
      const sourceCode = this.workflowGenerator.generateWorkflowSource(plan);
      return { sourceCode };
    }

    // 1. Structured Inference with prompt template
    if (options.inferenceService) {
      try {
        const response = await options.inferenceService.infer<Record<string, unknown>, unknown>({
          promptTemplateId: "tool_synthesis",
          tenantId: options.tenantId || "system",
          taskClass: "tool_synthesis",
          inputs: {
            planId: plan.planId || plan.id,
            specification: JSON.stringify({
              name: plan.name,
              description: plan.description,
              inputSchema: plan.inputSchema,
              outputSchema: plan.outputSchema,
              variableInputs: plan.variableInputs,
              invariantInputs: plan.invariantInputs,
              steps: plan.steps,
              evidence: options.workflowEvidence,
            }),
            existingCode: "",
            requiredCapabilities: JSON.stringify(plan.capabilities),
          },
        });

        if (response.output) {
          const parsed = ToolSynthesisOutputSchema.parse(response.output);
          const needsBroker =
            plan.capabilities.fs.readPaths.length > 0 ||
            plan.capabilities.fs.writePaths.length > 0 ||
            plan.capabilities.net.allowOutbound ||
            plan.capabilities.command.allowedCommands.length > 0;

          const hasBrokerInCode =
            parsed.code &&
            (parsed.code.includes("broker.") ||
              parsed.code.includes("context.fs") ||
              parsed.code.includes("context.net") ||
              parsed.code.includes("context.cmd"));

          if (
            parsed.code &&
            parsed.code.includes("defineTool") &&
            parsed.code.includes("export default defineTool") &&
            (!needsBroker || hasBrokerInCode)
          ) {
            return {
              sourceCode: parsed.code,
              toolName: parsed.name,
              provenance: response.provenance,
              usage: response.provenance?.usage,
            };
          }

          const customLogic = parsed.executionBody || parsed.transformationLogic || parsed.code;
          if (customLogic && !customLogic.includes("defineTool")) {
            const zodInputSchemaSource = this.schemaGenerator.generateZodSource(plan.inputSchema);
            const zodOutputSchemaSource = this.schemaGenerator.generateOutputZodSource(
              plan.outputSchema,
            );
            const sourceCode = `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = ${zodInputSchemaSource};

export const OutputSchema = ${zodOutputSchemaSource};

export type ToolInput = z.infer<typeof InputSchema>;
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(
  async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
    const input = context.input;
    const { broker, logger, progress } = context;
    await progress(0, "Starting execution");
    await logger.info("Executing tool", { toolName: ${JSON.stringify(plan.name)} });
    let resultData: unknown;

    try {
${customLogic}
      await progress(100, "Execution finished successfully", "complete");
      await logger.info("Tool finished successfully", { toolName: ${JSON.stringify(plan.name)} });

      return {
        success: true,
        data: resultData as Record<string, unknown>,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await logger.error("Tool execution failed", { error: errorMessage });
      throw new Error(\`[${plan.name}] Execution error: \${errorMessage}\`);
    }
  },
);
`;
            return {
              sourceCode,
              toolName: parsed.name,
              provenance: response.provenance,
              usage: response.provenance?.usage,
            };
          }
        }
      } catch (error) {
        const allowFallback = options.allowDeterministicFallback ?? false;
        if (!allowFallback) {
          throw error;
        }
      }
    } else if (options.allowDeterministicFallback === false) {
      throw new Error("Structured inference is required for candidate synthesis");
    }

    // 2. Deterministic Code Synthesis
    const sourceCode = this.generateSource(plan);
    return { sourceCode };
  }

  /**
   * Deterministically synthesizes TypeScript tool code.
   */
  generateSource(plan: ToolPlan): string {
    if (plan.targetType === "workflow") {
      return this.workflowGenerator.generateWorkflowSource(plan);
    }

    const zodInputSchemaSource = this.schemaGenerator.generateZodSource(plan.inputSchema);
    const zodOutputSchemaSource = this.schemaGenerator.generateOutputZodSource(plan.outputSchema);
    const executionBody = this.deriveExecutionBody(plan);

    return `import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = ${zodInputSchemaSource};

export const OutputSchema = ${zodOutputSchemaSource};

export type ToolInput = z.infer<typeof InputSchema>;
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(
  async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
    const input = context.input;
    const { broker, logger, progress } = context;
    await progress(0, "Starting execution");
    await logger.info("Executing tool", { toolName: ${JSON.stringify(plan.name)} });
    let resultData: unknown;

    try {
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
      throw new Error(\`[${plan.name}] Execution error: \${errorMessage}\`);
    }
  },
);
`;
  }

  /**
   * Derives execution logic.
   */
  private deriveExecutionBody(plan: ToolPlan): string {
    const step = plan.steps[0];
    const action = step?.action?.toLowerCase() ?? "compute.transform";
    const service = step?.service?.toLowerCase() ?? "";
    const toolClass = (step?.toolClass ?? "").toLowerCase();
    const name = plan.name.toLowerCase();
    const desc = plan.description.toLowerCase();

    // 1. Filesystem tools
    if (
      service === "fs" ||
      action.startsWith("fs.") ||
      toolClass === "filesystem" ||
      toolClass === "file_read" ||
      toolClass === "file_edit" ||
      name.includes("file") ||
      name.includes("read") ||
      name.includes("write") ||
      desc.includes("file")
    ) {
      if (
        action.includes("write") ||
        name.includes("write") ||
        name.includes("save") ||
        toolClass === "file_edit"
      ) {
        return `      const filePath = (input as Record<string, unknown>).filePath as string ?? (input as Record<string, unknown>).path as string ?? "./output.txt";
      const content = (input as Record<string, unknown>).content as string ?? "";
      await logger.debug("Writing file via filesystem broker", { filePath, size: content.length });
      await broker.fs.writeFile(filePath, content);
      resultData = {
        filePath,
        written: true,
        bytes: content.length,
      };`;
      }

      if (action.includes("list") || name.includes("list") || name.includes("dir")) {
        return `      const filePath = (input as Record<string, unknown>).filePath as string ?? (input as Record<string, unknown>).path as string ?? ".";
      await logger.debug("Listing directory via filesystem broker", { filePath });
      const entries = await broker.fs.listDir(filePath);
      resultData = {
        filePath,
        entries,
        count: entries.length,
      };`;
      }

      return `      const filePath = (input as Record<string, unknown>).filePath as string ?? (input as Record<string, unknown>).path as string ?? "./data.txt";
      await logger.debug("Reading file via filesystem broker", { filePath });
      const content = await broker.fs.readFile(filePath, "utf-8");
      resultData = {
        filePath,
        content,
        bytes: content.length,
      };`;
    }

    // 2. Outbound HTTP / Network tools
    if (
      service === "net" ||
      action.startsWith("net.") ||
      action.startsWith("http.") ||
      toolClass === "network" ||
      toolClass === "http" ||
      toolClass === "api" ||
      name.includes("fetch") ||
      name.includes("http") ||
      name.includes("api") ||
      desc.includes("api")
    ) {
      const secretName =
        plan.capabilities.secrets.allowedSecretNames[0] ||
        (plan.invariantInputs.find((i) => i.name === "authSecretName")?.value as
          | string
          | undefined);

      const defaultHost =
        plan.capabilities.net.allowedHosts[0] || plan.capabilities.net.allowedDomains[0];
      const defaultUrl = defaultHost
        ? `https://${defaultHost}/data`
        : "https://api.example.com/data";

      if (secretName) {
        return `      const url = (input as Record<string, unknown>).url as string ?? (input as Record<string, unknown>).endpoint as string ?? ${JSON.stringify(defaultUrl)};
      await logger.debug("Fetching authenticated network resource", { url });
      const authRef = broker.secret.createReference(${JSON.stringify(secretName)}, { modes: ["bearer_token", "header_template"] });
      const response = await broker.net.fetch(url, {
        method: "GET",
        headers: {
          Authorization: authRef,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
      }
      const json = await response.json();
      resultData = {
        status: response.status,
        data: json,
      };`;
      }

      return `      const url = (input as Record<string, unknown>).url as string ?? (input as Record<string, unknown>).endpoint as string ?? ${JSON.stringify(defaultUrl)};
      await logger.debug("Fetching network resource", { url });
      const response = await broker.net.fetch(url);
      const json = await response.json();
      resultData = {
        status: response.status,
        data: json,
      };`;
    }

    // 3. Command execution tools
    if (
      service === "cmd" ||
      action.startsWith("cmd.") ||
      toolClass === "command" ||
      toolClass === "test_runner" ||
      toolClass === "build_tool" ||
      toolClass === "vcs" ||
      name.includes("cmd") ||
      name.includes("exec") ||
      name.includes("command")
    ) {
      const commandName =
        plan.capabilities.command.allowedCommands[0] ||
        (step?.inputs.command as string | undefined) ||
        "echo 'done'";

      const secretName = plan.capabilities.secrets.allowedSecretNames[0];

      if (secretName) {
        return `      const command = (input as Record<string, unknown>).command as string ?? (input as Record<string, unknown>).cmd as string ?? ${JSON.stringify(commandName)};
      const args = ((input as Record<string, unknown>).args as string[]) ?? [];
      await logger.debug("Executing command with secret env via cmd broker", { command, args });
      const secretEnv = broker.secret.createReference(${JSON.stringify(secretName)}, { modes: ["command_env"] });
      const res = await broker.cmd.exec(command, args, {
        env: { AUTH_TOKEN: secretEnv },
      });
      if (res.exitCode !== 0) {
        throw new Error(\`Command '\${command}' failed with exit code \${res.exitCode}: \${res.stderr}\`);
      }
      resultData = {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
      };`;
      }

      return `      const command = (input as Record<string, unknown>).command as string ?? (input as Record<string, unknown>).cmd as string ?? ${JSON.stringify(commandName)};
      const args = ((input as Record<string, unknown>).args as string[]) ?? [];
      await logger.debug("Executing command via command broker", { command, args });
      const res = await broker.cmd.exec(command, args);
      resultData = {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
      };`;
    }

    // 4. Pure Compute / Transformation tools
    return this.deriveTransformationBody(plan);
  }

  /**
   * Derives pure compute transformation logic.
   */
  private deriveTransformationBody(plan: ToolPlan): string {
    const properties = plan.inputSchema.properties ?? {};
    const propNames = Object.keys(properties);

    const arrayNumProp = propNames.find((k) => properties[k]?.type === "array");
    if (
      arrayNumProp ||
      plan.name.includes("stat") ||
      plan.name.includes("distribution") ||
      plan.name.includes("metric") ||
      plan.name.includes("calc")
    ) {
      const key = arrayNumProp ?? "values";
      return `      const rawArr = (input as Record<string, unknown>)[${JSON.stringify(key)}];
      const nums: number[] = Array.isArray(rawArr)
        ? rawArr.map((v) => Number(v)).filter((n) => !Number.isNaN(n))
        : [];
      const count = nums.length;
      const sum = nums.reduce((acc, val) => acc + val, 0);
      const mean = count > 0 ? sum / count : 0;
      const sorted = [...nums].sort((a, b) => a - b);
      const min = sorted.length > 0 ? sorted[0] : 0;
      const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
      const median =
        sorted.length === 0
          ? 0
          : sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
            : sorted[Math.floor(sorted.length / 2)]!;
      const variance = count > 0 ? nums.reduce((acc, v) => acc + (v - mean) ** 2, 0) / count : 0;
      const standardDeviation = Math.sqrt(variance);

      resultData = {
        count,
        sum,
        mean,
        min,
        max,
        median,
        variance,
        standardDeviation,
      };`;
    }

    return `      const inputEntries = Object.entries(input as Record<string, unknown>);
      const processedMap: Record<string, unknown> = {};
      for (const [k, v] of inputEntries) {
        processedMap[k] = typeof v === "string" ? v.trim() : v;
      }
      resultData = {
        computed: true,
        inputCount: inputEntries.length,
        processed: processedMap,
      };`;
  }
}
