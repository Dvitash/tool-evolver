import { ToolOutputSchema, ToolParameterSchema } from "@tool-evolver/contracts";
import { VariableInputDefinition, WorkflowStep } from "./types.js";

/**
 * Derives Zod and JSON Schemas for inputs and outputs from observed variables and workflow steps.
 */
export class SchemaGenerator {
  /**
   * Derives a canonical ToolParameterSchema from a list of variable input definitions.
   */
  deriveInputSchema(variableInputs: VariableInputDefinition[]): ToolParameterSchema {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    for (const input of variableInputs) {
      const propDef: Record<string, unknown> = {
        type: input.type,
        description: input.description,
      };

      if (input.defaultValue !== undefined) {
        propDef.default = input.defaultValue;
      }

      if (input.type === "array") {
        propDef.items = { type: "string" };
      }

      if (input.examples && input.examples.length > 0) {
        propDef.examples = input.examples;
      }

      properties[input.name] = propDef;

      if (input.required) {
        required.push(input.name);
      }
    }

    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }

  /**
   * Derives a canonical ToolOutputSchema from candidate output schema or workflow steps.
   */
  deriveOutputSchema(
    candidateOutputSchema?: Record<string, unknown>,
    steps?: WorkflowStep[],
    targetType?: "single_tool" | "workflow"
  ): ToolOutputSchema {
    if (candidateOutputSchema && typeof candidateOutputSchema === "object") {
      const schemaProps = (candidateOutputSchema.properties as Record<string, Record<string, unknown>>) ?? {};
      return {
        type: (candidateOutputSchema.type as string) ?? "object",
        properties: schemaProps,
        description: (candidateOutputSchema.description as string) ?? "Execution output",
        schema: candidateOutputSchema,
      };
    }

    const properties: Record<string, Record<string, unknown>> = {
      success: {
        type: "boolean",
        description: "Indicates if execution succeeded",
      },
      data: {
        type: "object",
        description: "Execution payload or structured result",
      },
      error: {
        type: "string",
        description: "Error message if execution failed",
      },
    };

    if (targetType === "workflow" && steps && steps.length > 0) {
      const stepResults: Record<string, unknown> = {};
      for (const step of steps) {
        stepResults[step.outputVar ?? step.id] = {
          type: "object",
          description: `Result from step ${step.name}`,
        };
      }
      properties.stepResults = {
        type: "object",
        description: "Intermediate step results",
        properties: stepResults,
      };
    }

    return {
      type: "object",
      properties,
      description: "Structured execution output conforming to runtime specifications",
    };
  }

  /**
   * Generates TypeScript Zod schema code string from ToolParameterSchema.
   */
  generateZodSource(paramSchema: ToolParameterSchema): string {
    const propLines: string[] = [];

    for (const [key, prop] of Object.entries(paramSchema.properties)) {
      const type = (prop.type as string) ?? "string";
      const desc = prop.description as string | undefined;
      const isRequired = paramSchema.required.includes(key);

      let zodType = "z.string()";
      switch (type) {
        case "number":
          zodType = "z.number()";
          break;
        case "boolean":
          zodType = "z.boolean()";
          break;
        case "array":
          zodType = "z.array(z.string())";
          break;
        case "object":
          zodType = "z.record(z.unknown())";
          break;
        case "string":
        default:
          zodType = "z.string()";
          break;
      }

      if (desc) {
        zodType += `.describe(${JSON.stringify(desc)})`;
      }

      if (!isRequired) {
        if (prop.default !== undefined) {
          zodType += `.default(${JSON.stringify(prop.default)})`;
        } else {
          zodType += ".optional()";
        }
      }

      propLines.push(`  ${JSON.stringify(key)}: ${zodType},`);
    }

    if (propLines.length === 0) {
      return "z.object({}).strict()";
    }

    return `z.object({\n${propLines.join("\n")}\n}).strict()`;
  }

  /**
   * Generates TypeScript Zod schema code string from ToolOutputSchema.
   */
  generateOutputZodSource(outputSchema: ToolOutputSchema): string {
    const propLines: string[] = [];
    const props = outputSchema.properties ?? {};

    for (const [key, prop] of Object.entries(props)) {
      const type = (prop.type as string) ?? "string";
      const desc = prop.description as string | undefined;

      let zodType = "z.unknown()";
      switch (type) {
        case "boolean":
          zodType = "z.boolean()";
          break;
        case "number":
          zodType = "z.number()";
          break;
        case "string":
          zodType = "z.string()";
          break;
        case "array":
          zodType = "z.array(z.unknown())";
          break;
        case "object":
          zodType = "z.record(z.unknown())";
          break;
      }

      if (desc) {
        zodType += `.describe(${JSON.stringify(desc)})`;
      }
      zodType += ".optional()";

      propLines.push(`  ${JSON.stringify(key)}: ${zodType},`);
    }

    if (propLines.length === 0) {
      return "z.object({\n  success: z.boolean(),\n  data: z.record(z.unknown()).optional(),\n  error: z.string().optional(),\n}).strict()";
    }

    return `z.object({\n${propLines.join("\n")}\n}).strict()`;
  }
}
