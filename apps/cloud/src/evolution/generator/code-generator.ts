import { SchemaGenerator } from "./schema-generator.js";
import { ToolPlan } from "./types.js";
import { WorkflowGenerator } from "./workflow-generator.js";

/**
 * Generates TypeScript source code for single tools and workflow tools targeting @tool-evolver/runtime SDK.
 */
export class CodeGenerator {
  private readonly schemaGenerator: SchemaGenerator;
  private readonly workflowGenerator: WorkflowGenerator;

  constructor(
    schemaGenerator?: SchemaGenerator,
    workflowGenerator?: WorkflowGenerator
  ) {
    this.schemaGenerator = schemaGenerator ?? new SchemaGenerator();
    this.workflowGenerator = workflowGenerator ?? new WorkflowGenerator(this.schemaGenerator);
  }

  /**
   * Generates TypeScript source code for a ToolPlan.
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
    const filePath = (input as Record<string, unknown>).path as string ?? (input as Record<string, unknown>).filePath as string ?? ".";
    const content = (input as Record<string, unknown>).content as string ?? "";
    await logger.debug("Writing file via filesystem broker", { filePath, length: content.length });
    await broker.fs.writeFile(filePath, content);
    resultData = {
      path: filePath,
      written: true,
      bytesWritten: Buffer.byteLength(content, "utf-8"),
    };`;
    } else if (action === "cmd.exec" || toolClass === "command" || toolClass === "test_runner" || toolClass === "build_tool" || toolClass === "vcs") {
      executionBody = `
    const command = (input as Record<string, unknown>).command as string ?? (input as Record<string, unknown>).cmd as string ?? ${JSON.stringify(step?.inputs.command ?? "echo 'done'")};
    const args = ((input as Record<string, unknown>).args as string[]) ?? [];
    await logger.debug("Executing command via command broker", { command, args });
    const cmdResult = await broker.cmd.exec(command, args);
    resultData = {
      command,
      exitCode: cmdResult.exitCode,
      stdout: cmdResult.stdout,
      stderr: cmdResult.stderr,
    };`;
    } else if (action === "net.fetch" || toolClass === "network") {
      executionBody = `
    const url = (input as Record<string, unknown>).url as string ?? ${JSON.stringify(step?.inputs.url ?? "https://api.example.com")};
    await logger.debug("Fetching external resource via network broker", { url });
    const response = await broker.net.fetch(url);
    const jsonPayload = await response.json();
    resultData = {
      url,
      status: response.status,
      statusText: response.statusText,
      payload: jsonPayload,
    };`;
    } else if (action === "secret.getSecret" || toolClass === "secrets") {
      executionBody = `
    const secretName = (input as Record<string, unknown>).name as string ?? (input as Record<string, unknown>).secretName as string ?? "SECRET";
    await logger.debug("Resolving secret via secrets broker", { secretName });
    const secretValue = await broker.secret.getSecret(secretName);
    resultData = {
      secretName,
      found: secretValue !== null,
      value: secretValue,
    };`;
    } else {
      // Pure compute / transformation
      executionBody = `
    await logger.debug("Executing pure transformation tool", { toolName: ${JSON.stringify(plan.name)}, input });
    const inputEntries = Object.entries(input as Record<string, unknown>);
    resultData = {
      computed: true,
      inputCount: inputEntries.length,
      processed: input,
    };`;
    }

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
 * Tool handler: ${plan.name}
 * Intent: ${plan.intent}
 * Description: ${plan.description}
 */
export default defineTool<ToolInput, ToolOutput>(async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
  const { input, logger, broker, progress } = context;

  await progress(0, "Initializing tool execution...", "init");
  await logger.info("Executing tool: ${plan.name}", { input });

  try {
    let resultData: Record<string, unknown> = {};
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
  }
}
