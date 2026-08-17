import type { z } from "zod";

/**
 * Error thrown when structured output validation fails after all repair attempts are exhausted.
 */
export class SchemaValidationExhaustedError extends Error {
  public readonly validationErrors: Array<{ path: string; message: string }>;
  public readonly rawOutput: string;
  public readonly attempts: number;

  constructor(
    message: string,
    validationErrors: Array<{ path: string; message: string }>,
    rawOutput: string,
    attempts: number,
  ) {
    super(`${message} (exhausted after ${attempts} attempts)`);
    this.name = "SchemaValidationExhaustedError";
    this.validationErrors = validationErrors;
    this.rawOutput = rawOutput;
    this.attempts = attempts;
  }
}

/**
 * Direct validation result.
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; issues: Array<{ path: string; message: string }> };

/**
 * Parameters for validateWithRepair.
 */
export interface ValidateWithRepairParams<T> {
  rawText: string;
  schema: z.ZodType<T>;
  jsonSchema?: Record<string, unknown>;
  repairExecutor: (repairPrompt: string) => Promise<string>;
  maxRepairAttempts?: number;
}

/**
 * Extracts and cleans JSON from raw LLM text, stripping markdown code fences if present.
 */
export function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();

  // Strip ```json ... ``` or ``` ... ``` code blocks
  const codeBlockMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Find first { and last } or first [ and last ]
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");

  if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  if (firstBracket !== -1 && lastBracket !== -1) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }

  return trimmed;
}

/**
 * Formats Zod validation issues into structured path/message pairs.
 */
export function formatZodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "root",
    message: `${issue.message} (code: ${issue.code})`,
  }));
}

/**
 * Strict structured-output validator with bounded self-repair.
 */
export class StructuredOutputValidator {
  /**
   * Validates raw text against a Zod schema without repair.
   */
  validate<T>(rawText: string, schema: z.ZodType<T>): ValidationResult<T> {
    const jsonText = extractJsonText(rawText);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `JSON syntax error: ${message}`,
        issues: [{ path: "syntax", message }],
      };
    }

    const parseResult = schema.safeParse(parsed);
    if (parseResult.success) {
      return { success: true, data: parseResult.data };
    }

    const issues = formatZodIssues(parseResult.error);
    return {
      success: false,
      error: `Schema validation failed with ${issues.length} issue(s)`,
      issues,
    };
  }

  /**
   * Validates structured output with bounded self-repair (default max 2 repair attempts).
   */
  async validateWithRepair<T>(
    params: ValidateWithRepairParams<T>,
  ): Promise<{ output: T; repairAttempts: number; rawOutput: string }> {
    const maxAttempts = params.maxRepairAttempts ?? 2;
    let currentRaw = params.rawText;
    let repairAttempts = 0;

    while (true) {
      const result = this.validate(currentRaw, params.schema);
      if (result.success) {
        return {
          output: result.data,
          repairAttempts,
          rawOutput: currentRaw,
        };
      }

      if (repairAttempts >= maxAttempts) {
        throw new SchemaValidationExhaustedError(
          result.error,
          result.issues,
          currentRaw,
          repairAttempts + 1,
        );
      }

      // Generate repair prompt
      const repairPrompt = this.buildRepairPrompt({
        invalidOutput: currentRaw,
        errorMessage: result.error,
        issues: result.issues,
        jsonSchema: params.jsonSchema,
      });

      // Execute repair attempt
      repairAttempts++;
      currentRaw = await params.repairExecutor(repairPrompt);
    }
  }

  /**
   * Constructs an actionable repair prompt for the model.
   */
  private buildRepairPrompt(params: {
    invalidOutput: string;
    errorMessage: string;
    issues: Array<{ path: string; message: string }>;
    jsonSchema?: Record<string, unknown>;
  }): string {
    const issuesList = params.issues
      .map((issue) => `- Field "${issue.path}": ${issue.message}`)
      .join("\n");

    let prompt = `The previous response failed schema validation:\n${params.errorMessage}\n\nValidation Issues:\n${issuesList}\n\n`;

    if (params.jsonSchema) {
      prompt += `Expected JSON Schema:\n${JSON.stringify(params.jsonSchema, null, 2)}\n\n`;
    }

    prompt += `Invalid Output Received:\n${params.invalidOutput}\n\n`;
    prompt += `Please fix the errors above and return ONLY the valid JSON object strictly matching the required schema without explanation or markdown fences.`;

    return prompt;
  }
}
