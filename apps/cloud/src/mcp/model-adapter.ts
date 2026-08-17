/**
 * @tool-evolver/cloud - Model-Backed Cloud Tool Handler Adapter
 */

import type { z } from "zod";
import type { InferenceService } from "../models/service.js";
import type {
  InferenceRequest,
  InferenceResponse,
  ModelTaskClass,
  PrivacyLevel,
} from "../models/types.js";
import { McpInvocationError } from "./middleware.js";
import type { CallToolResult, CloudMcpInvocationContext, CloudMcpToolDefinition } from "./types.js";
import { MCP_ERROR_CODES } from "./types.js";

/**
 * Known prompt injection and jailbreak patterns to defend against.
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /override\s+(system|safety|guardrail)\s+(prompts?|instructions?|rules?)/i,
  /(you\s+are\s+now\s+(in\s+)?|enable\s+|enter\s+)?\b(developer\s+mode|dan\s+mode|unrestricted\s+mode)\b/i,
  /\bjailbreak\b/i,
  /system\s*:\s*you\s+are/i,
  /<system(-reminder|-directive)?>/i,
  /```\s*system/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\/?(?:system|instruction|system-instruction)>/i,
];

/**
 * Scans a value recursively for prompt injection patterns.
 */
export function detectPromptInjection(value: unknown): string | null {
  if (typeof value === "string") {
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        return `Potential prompt injection pattern detected: ${pattern.source}`;
      }
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const detected = detectPromptInjection(item);
      if (detected) return detected;
    }
    return null;
  }

  if (typeof value === "object" && value !== null) {
    for (const [key, val] of Object.entries(value)) {
      const keyDetected = detectPromptInjection(key);
      if (keyDetected) return keyDetected;
      const valDetected = detectPromptInjection(val);
      if (valDetected) return valDetected;
    }
  }

  return null;
}

/**
 * Sanitizes parameters by wrapping them in isolated structural data tags.
 */
export function frameUserParameters(params: Record<string, unknown>): string {
  const serialized = JSON.stringify(params, null, 2);
  return `<user_data_payload>\n${serialized}\n</user_data_payload>`;
}

/**
 * Options for creating an inference-backed tool.
 */
export interface ModelToolOptions<TOutput = unknown> {
  name: string;
  description: string;
  taskClass: ModelTaskClass;
  inputSchema: Record<string, unknown>;
  outputSchema: z.ZodType<TOutput>;
  inferenceService: InferenceService;
  promptTemplate: string | ((params: Record<string, unknown>) => string);
  systemPrompt?: string;
  privacyLevel?: PrivacyLevel;
  promptInjectionDefense?: boolean;
  timeoutMs?: number;
  rateLimit?: {
    maxRequestsPerMinute?: number;
    burst?: number;
  };
}

/**
 * Creates a CloudMcpToolDefinition backed by the cloud InferenceService.
 */
export function createInferenceModelTool<TOutput = unknown>(
  options: ModelToolOptions<TOutput>,
): CloudMcpToolDefinition {
  const {
    name,
    description,
    taskClass,
    inputSchema,
    outputSchema,
    inferenceService,
    promptTemplate,
    systemPrompt,
    privacyLevel = "direct",
    promptInjectionDefense = true,
    timeoutMs = 60000,
    rateLimit,
  } = options;

  return {
    name,
    description,
    inputSchema,
    source: "model",
    classification: "idempotent",
    privacyLevel,
    timeoutMs,
    rateLimit,
    handler: async (
      params: Record<string, unknown>,
      context: CloudMcpInvocationContext,
    ): Promise<CallToolResult> => {
      // 1. Prompt Injection Defense
      if (promptInjectionDefense) {
        const injectionReason = detectPromptInjection(params);
        if (injectionReason) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "SECURITY_VIOLATION",
                    message: `Prompt injection defense triggered: ${injectionReason}`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      // 2. Build Prompt
      let userPrompt: string;
      if (typeof promptTemplate === "function") {
        userPrompt = promptTemplate(params);
      } else {
        userPrompt = `${promptTemplate}\n\n${frameUserParameters(params)}`;
      }

      // 3. Assemble Inference Request
      const inferenceRequest: InferenceRequest<Record<string, unknown>, TOutput> = {
        tenantId: context.tenant.accountId,
        taskClass,
        promptTemplateId: name,
        inputs: {
          ...params,
          prompt: userPrompt,
        },
        schema: outputSchema,
        metadata: {
          workspaceId: context.tenant.workspaceId,
          toolName: name,
          traceId: context.traceId,
          spanId: context.spanId,
        },
      };
      // 4. Execute Model Inference
      try {
        const response: InferenceResponse<TOutput> = await inferenceService.infer<
          Record<string, unknown>,
          TOutput
        >(inferenceRequest);

        const structuredOutput = response.output;
        const serializedText =
          typeof structuredOutput === "string"
            ? structuredOutput
            : JSON.stringify(structuredOutput, null, 2);

        return {
          content: [
            {
              type: "text",
              text: serializedText,
            },
          ],
          isError: false,
          structuredData: structuredOutput,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "INFERENCE_FAILED",
                  message: `Model execution failed for tool '${name}': ${message}`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  };
}
