import type { ToolOutputSchema, ToolParameterSchema } from "@tool-evolver/contracts";
import {
  type SchemaGenerationOutput,
  SchemaGenerationOutputSchema,
} from "../../models/prompt-registry.js";
import type { InferenceService } from "../../models/service.js";
import type { InferenceProvenance } from "../../models/types.js";
import type { WorkflowContract } from "../opportunity/types.js";
import type { VariableInputDefinition, WorkflowStep } from "./types.js";

/**
 * Context for contract-aware schema generation.
 * Extends prior deriveSchemasAsync options with optional WorkflowContract.
 */
export interface SchemaGenerationContext {
  toolName: string;
  description: string;
  variableInputs: VariableInputDefinition[];
  steps?: WorkflowStep[];
  workflowEvidence?: string;
  tenantId?: string;
  inferenceService?: InferenceService;
  workflowContract?: WorkflowContract;
}

/**
 * Deterministically merges contract requiredInputs into existing input properties.
 * - Starts from base properties/required derived from observed variables / inference.
 * - Adds every requiredInputs entry not present.
 * - Contract requiredness wins; preserves conservative existing schema on conflict,
 *   fallback to {type:'string'} if contract type lacks precision.
 */
export function mergeContractInputs(
  baseProperties: Record<string, Record<string, unknown>>,
  baseRequired: string[],
  contract?: WorkflowContract,
): { properties: Record<string, Record<string, unknown>>; required: string[] } {
  if (!contract || !contract.requiredInputs || contract.requiredInputs.length === 0) {
    return { properties: baseProperties, required: baseRequired };
  }
  const properties = { ...baseProperties };
  const required = [...baseRequired];
  for (const inp of contract.requiredInputs) {
    const name = String(inp.name);
    const existing = properties[name];
    if (!existing) {
      const type = typeof inp.type === "string" && inp.type.length > 0 ? inp.type : "string";
      properties[name] = {
        type,
        description: String(inp.description || name),
        ...(inp.default !== undefined ? { default: inp.default } : {}),
      };
      if (inp.required && !required.includes(name)) required.push(name);
    } else {
      // Preserve existing schema conservatively; ensure requiredness from contract
      if (inp.required && !required.includes(name)) required.push(name);
      // If existing missing type, fill from contract
      if (!existing.type && inp.type) existing.type = inp.type;
      if (!existing.description && inp.description) existing.description = inp.description;
    }
  }
  return { properties, required };
}

/**
 * Deterministically merges contract outputRequirements into inferred output properties.
 * Required coverage is represented by property presence (not a `required` array).
 * - Forces every outputRequirements entry into properties.
 * - Preserves compatible inferred field schema on conflict; contract requiredness wins by ensuring presence.
 * - Conservative conflict handling: keep existing type/description if present, only fill missing.
 * - Deterministic: processes sorted by name.
 */
export function mergeContractOutputs(
  baseProperties: Record<string, Record<string, unknown>>,
  contract?: WorkflowContract,
): { properties: Record<string, Record<string, unknown>> };
export function mergeContractOutputs(
  baseProperties: Record<string, Record<string, unknown>>,
  baseRequired: string[],
  contract?: WorkflowContract,
): { properties: Record<string, Record<string, unknown>>; required: string[] };
export function mergeContractOutputs(
  baseProperties: Record<string, Record<string, unknown>>,
  baseRequiredOrContract?: string[] | WorkflowContract,
  contract?: WorkflowContract,
): { properties: Record<string, Record<string, unknown>>; required?: string[] } {
  let actualContract: WorkflowContract | undefined;
  if (Array.isArray(baseRequiredOrContract)) {
    actualContract = contract;
  } else {
    actualContract = baseRequiredOrContract as WorkflowContract | undefined;
  }
  if (!actualContract || !actualContract.outputRequirements || actualContract.outputRequirements.length === 0) {
    // Maintain backward-compatible shape when called with 3 args: return required as empty for callers that destructure it but don't use for ToolOutputSchema
    if (Array.isArray(baseRequiredOrContract)) {
      return { properties: baseProperties, required: baseRequiredOrContract as string[] };
    }
    return { properties: baseProperties };
  }
  const properties: Record<string, Record<string, unknown>> = { ...baseProperties };
  // Deterministic order
  const sorted = [...actualContract.outputRequirements].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const req of sorted) {
    const name = String(req.name);
    const existing = properties[name];
    const contractType = typeof req.type === "string" && req.type.length > 0 ? req.type : "string";
    const contractDesc = typeof req.description === "string" && req.description.length > 0 ? req.description : `Output of ${req.sourceOperationId}`;
    if (!existing) {
      properties[name] = {
        type: contractType,
        description: contractDesc,
      };
    } else {
      // Conservative: preserve existing compatible schema; do not overwrite type/description with less precise contract
      // Only fill missing fields
      if (!existing.type) existing.type = contractType;
      if (!existing.description) existing.description = contractDesc;
      // Keep existing.type even if differs from contractType — conservative preservation
    }
  }
  if (Array.isArray(baseRequiredOrContract)) {
    // For 3-arg legacy callers, return required passthrough without adding contract required (coverage via presence)
    return { properties, required: baseRequiredOrContract as string[] };
  }
  return { properties };
}

/**
 * Derives Zod and JSON Schemas for inputs and outputs from observed variables and workflow steps.
 * Contract-aware: ensures WorkflowContract required inputs/outputs are never dropped by inference.
 */
export class SchemaGenerator {
  /**
   * Derives input and output schemas asynchronously using structured inference when available.
   * When workflowContract is provided, its full required inputs/outputs are included in inference prompt inputs,
   * and the inferred schema is deterministically merged with all required contract output fields so inference cannot overwrite/drop them.
   */
  async deriveSchemasAsync(options: SchemaGenerationContext): Promise<{
    inputSchema: ToolParameterSchema;
    outputSchema: ToolOutputSchema;
    provenance?: InferenceProvenance;
  }> {
    if (!options.inferenceService) {
      return {
        inputSchema: this.deriveInputSchema(options.variableInputs, options.workflowContract),
        outputSchema: this.deriveOutputSchema(undefined, options.steps, undefined, options.workflowContract),
      };
    }

    try {
      const workflowContract = options.workflowContract;
      const workflowOperations = workflowContract?.operations ?? [];
      const workflowOutputs = workflowContract?.outputRequirements ?? [];
      const workflowInputs = workflowContract?.requiredInputs ?? [];
      const response = await options.inferenceService.infer<
        Record<string, unknown>,
        SchemaGenerationOutput
      >({
        tenantId: options.tenantId ?? "system",
        taskClass: "candidate_planning",
        promptTemplateId: "schema_generation",
        inputs: {
          toolName: options.toolName,
          description: options.description,
          workflowEvidence: options.workflowEvidence ?? options.description,
          observedVariables: JSON.stringify(options.variableInputs),
          workflowContract: workflowContract ? JSON.stringify(workflowContract) : JSON.stringify(null),
          workflowOperations: JSON.stringify(workflowOperations),
          workflowOutputs: JSON.stringify(workflowOutputs),
          workflowInputs: JSON.stringify(workflowInputs),
        },
      });

      const parsed = SchemaGenerationOutputSchema.parse(response.output);
      // Build base input properties from observed + inferred descriptions
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];
      const inferredByName = new Map(parsed.parameters.map((param) => [param.name, param]));

      for (const observed of options.variableInputs) {
        const inferred = inferredByName.get(observed.name);
        properties[observed.name] = {
          type: observed.type,
          description: inferred?.description || observed.description,
          ...(observed.defaultValue !== undefined ? { default: observed.defaultValue } : {}),
          ...((observed as unknown as { enumValues?: unknown[] }).enumValues ? { enum: (observed as unknown as { enumValues?: unknown[] }).enumValues } : {}),
        };
        if (observed.required) required.push(observed.name);
      }

      // Deterministically merge requiredInputs from contract
      const mergedInputs = mergeContractInputs(properties, required, workflowContract);

      const inputSchema: ToolParameterSchema = {
        type: "object",
        properties: mergedInputs.properties,
        required: mergedInputs.required,
        additionalProperties: false,
      };

      // Inferred output properties (top-level)
      const inferredProps =
        (parsed.outputSchema.properties as Record<string, Record<string, unknown>>) ?? {};

      // Merge contract outputRequirements into top-level properties (property presence, not required array)
      const mergedOutputs = mergeContractOutputs({ ...inferredProps }, workflowContract);

      const outProps: Record<string, Record<string, unknown>> = {
        success: { type: "boolean", description: "Whether execution succeeded" },
        data: {
          type: "object",
          description: parsed.outputSchema.description ?? "Result data payload",
          properties: { ...mergedOutputs.properties },
        },
        error: { type: "string", description: "Error message if execution failed" },
      };

      const outputSchema: ToolOutputSchema = {
        type: "object",
        properties: outProps,
        description: parsed.outputSchema.description ?? "Result data payload",
      };

      return {
        inputSchema,
        outputSchema,
        provenance: response.provenance,
      };
    } catch {
      return {
        inputSchema: this.deriveInputSchema(options.variableInputs, options.workflowContract),
        outputSchema: this.deriveOutputSchema(undefined, options.steps, undefined, options.workflowContract),
      };
    }
  }

  /**
   * Derives a canonical ToolParameterSchema from a list of variable input definitions.
   * When workflowContract is provided, its requiredInputs are unioned in.
   */
  deriveInputSchema(
    variableInputs: VariableInputDefinition[],
    workflowContract?: WorkflowContract,
  ): ToolParameterSchema {
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

      if ((input as unknown as { enumValues?: unknown[] }).enumValues) {
        propDef.enum = (input as unknown as { enumValues?: unknown[] }).enumValues;
      }

      properties[input.name] = propDef;

      if (input.required) {
        required.push(input.name);
      }
    }

    const merged = mergeContractInputs(properties, required, workflowContract);
    return {
      type: "object",
      properties: merged.properties,
      required: merged.required,
      additionalProperties: false,
    };
  }

  /**
   * Derives a canonical ToolOutputSchema from candidate output schema or workflow steps.
   * When workflowContract is provided, its outputRequirements are forcibly merged into properties.
   */
  deriveOutputSchema(
    candidateOutputSchema?: Record<string, unknown>,
    steps?: WorkflowStep[],
    targetType?: "single_tool" | "workflow",
    workflowContract?: WorkflowContract,
  ): ToolOutputSchema {
    if (candidateOutputSchema && typeof candidateOutputSchema === "object") {
      const schemaProps =
        (candidateOutputSchema.properties as Record<string, Record<string, unknown>>) ?? {};
      const schemaDesc = (candidateOutputSchema.description as string) ?? "Execution output";
      // If contract present, merge into data.properties envelope (property presence, never required)
      if (workflowContract) {
        const isEnvelope =
          typeof (schemaProps as Record<string, unknown>).data === "object" &&
          (schemaProps as Record<string, unknown>).data !== null;
        let baseDataProps: Record<string, Record<string, unknown>>;
        if (isEnvelope) {
          const dataObj = (schemaProps as Record<string, unknown>).data as Record<string, unknown>;
          baseDataProps = ((dataObj.properties as Record<string, Record<string, unknown>> | undefined) ?? {}) as Record<string, Record<string, unknown>>;
          // Include any legacy top-level non-envelope outputs as base as well
          const envelopeKeys = new Set(["success", "data", "error", "stepResults"]);
          for (const [k, v] of Object.entries(schemaProps)) {
            if (!envelopeKeys.has(k) && !(k in baseDataProps)) {
              baseDataProps[k] = v as Record<string, unknown>;
            }
          }
        } else {
          baseDataProps = { ...schemaProps };
        }
        const merged = mergeContractOutputs({ ...baseDataProps }, workflowContract);
        const finalProperties: Record<string, Record<string, unknown>> = isEnvelope
          ? {
              ...schemaProps,
              data: {
                ...((schemaProps as Record<string, unknown>).data as Record<string, unknown>),
                type: ((schemaProps as Record<string, unknown>).data as Record<string, unknown>).type ?? "object",
                description:
                  ((schemaProps as Record<string, unknown>).data as Record<string, unknown>).description ?? schemaDesc,
                properties: merged.properties,
              } as Record<string, unknown>,
            }
          : {
              success: { type: "boolean", description: "Whether execution succeeded" },
              data: { type: "object", description: schemaDesc, properties: merged.properties },
              error: { type: "string", description: "Error message if execution failed" },
            };
        return {
          type: (candidateOutputSchema.type as string) ?? "object",
          properties: finalProperties,
          description: schemaDesc,
          schema: {
            ...candidateOutputSchema,
            properties: finalProperties,
          },
        };
      }
      return {
        type: (candidateOutputSchema.type as string) ?? "object",
        properties: schemaProps,
        description: schemaDesc,
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
      const stepResults: Record<string, Record<string, unknown>> = {};
      for (const step of steps) {
        stepResults[step.id] = {
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

    // If workflowContract present, merge its outputRequirements into data.properties envelope
    if (workflowContract && workflowContract.outputRequirements.length > 0) {
      const dataSection = properties.data as Record<string, unknown> | undefined;
      const existingDataProps =
        (dataSection?.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
      const merged = mergeContractOutputs({ ...existingDataProps }, workflowContract);
      if (dataSection) {
        (properties.data as Record<string, unknown>).properties = merged.properties;
      } else {
        properties.data = { type: "object", description: "Execution payload or structured result", properties: merged.properties };
      }
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
        case "array": {
          const items = prop.items as { type?: string } | undefined;
          const itemType = items?.type;
          const isNumeric =
            itemType === "number" ||
            key === "values" ||
            key === "numbers" ||
            desc?.toLowerCase().includes("number") ||
            desc?.toLowerCase().includes("float");
          if (isNumeric) {
            zodType = "z.array(z.number())";
          } else if (itemType === "object") {
            zodType = "z.array(z.record(z.unknown()))";
          } else if (itemType === "boolean") {
            zodType = "z.array(z.boolean())";
          } else {
            zodType = "z.array(z.unknown())";
          }
          break;
        }
        case "object":
          zodType = "z.record(z.unknown())";
          break;
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
