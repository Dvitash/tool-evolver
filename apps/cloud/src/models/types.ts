import { z } from "zod";

/**
 * Supported model task classes for Tool Evolver cloud service.
 */
export const ModelTaskClassSchema = z.enum([
  "opportunity_detection",
  "candidate_planning",
  "tool_synthesis",
  "test_generation",
  "candidate_scoring",
]);
export type ModelTaskClass = z.infer<typeof ModelTaskClassSchema>;

/**
 * Privacy levels for model execution.
 */
export const PrivacyLevelSchema = z.enum([
  "airgapped",
  "local",
  "cloud_sanitized",
  "cloud_private",
]);
export type PrivacyLevel = z.infer<typeof PrivacyLevelSchema>;

/**
 * Model capability definition.
 */
export const ModelCapabilitySchema = z.object({
  name: z.string(),
  supportedTaskClasses: z.array(ModelTaskClassSchema),
  maxContextTokens: z.number().int().positive().default(128000),
  maxOutputTokens: z.number().int().positive().default(8192),
  supportsJsonSchema: z.boolean().default(true),
  supportsTemperature: z.boolean().default(true),
  supportsStreaming: z.boolean().default(false),
  supportsSeed: z.boolean().default(true),
  privacyLevel: PrivacyLevelSchema.default("cloud_sanitized"),
  costPer1kPromptTokensUsd: z.number().nonnegative().optional(),
  costPer1kCompletionTokensUsd: z.number().nonnegative().optional(),
});
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

/**
 * Model policy for routing and inference constraints.
 */
export const ModelPolicySchema = z.object({
  taskClass: ModelTaskClassSchema,
  allowedPrivacyLevels: z
    .array(PrivacyLevelSchema)
    .default(["cloud_sanitized", "cloud_private", "local", "airgapped"]),
  defaultTemperature: z.number().min(0).max(2).default(0.2),
  maxTemperature: z.number().min(0).max(2).default(1.0),
  maxTokens: z.number().int().positive().default(4096),
  seed: z.number().int().optional(),
  priorityProviders: z.array(z.string()).default([]),
  disallowedModels: z.array(z.string()).default([]),
  cacheTtlSeconds: z.number().int().nonnegative().default(3600),
  rateLimitPerMinute: z.number().int().positive().default(60),
  redactionStrictness: z.enum(["strict", "standard", "lax"]).default("strict"),
  allowRawTranscripts: z.boolean().default(false),
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

/**
 * Model usage telemetry.
 */
export const ModelUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/**
 * Complete inference provenance record.
 */
export const InferenceProvenanceSchema = z.object({
  requestId: z.string(),
  tenantId: z.string(),
  taskClass: ModelTaskClassSchema,
  providerId: z.string(),
  providerName: z.string(),
  model: z.string().default(""),
  promptTemplateId: z.string(),
  promptTemplateVersion: z.string(),
  promptDigest: z.string(),
  inputDigest: z.string(),
  schemaDigest: z.string(),
  cached: z.boolean(),
  cacheKey: z.string().optional(),
  repairAttempts: z.number().int().nonnegative().default(0),
  usage: ModelUsageSchema,
  latencyMs: z.number().nonnegative(),
  createdAt: z.string(),
  finishedAt: z.string(),
});
export type InferenceProvenance = z.infer<typeof InferenceProvenanceSchema>;

/**
 * Structured inference request.
 */
export interface InferenceRequest<TInput = Record<string, unknown>, TOutput = unknown> {
  requestId?: string;
  tenantId: string;
  taskClass: ModelTaskClass;
  promptTemplateId: string;
  promptTemplateVersion?: string;
  inputs: TInput;
  schema?: z.ZodType<TOutput> | Record<string, unknown>;
  policyOverride?: Partial<ModelPolicy>;
  bypassCache?: boolean;
  preferredProviderId?: string;
  preferredModel?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Structured inference response.
 */
export interface InferenceResponse<TOutput = unknown> {
  requestId: string;
  tenantId: string;
  taskClass: ModelTaskClass;
  output: TOutput;
  rawOutput?: string;
  provenance: InferenceProvenance;
}

/**
 * Request passed to a low-level ModelProvider.
 */
export interface ProviderExecutionRequest {
  model: string;
  systemInstruction: string;
  userMessage: string;
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  seed?: number;
  stopSequences?: string[];
  timeoutMs?: number;
}

/**
 * Response from a low-level ModelProvider.
 */
export interface ProviderExecutionResponse {
  rawText: string;
  parsedJson?: unknown;
  usage: ModelUsage;
  model: string;
  latencyMs: number;
  finishReason?: string;
}

/**
 * Route selection result.
 */
export interface RouteSelectionResult {
  providerId: string;
  provider: ModelProvider;
  model: string;
  policy: ModelPolicy;
}

/**
 * Circuit breaker states.
 */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Forward interface declaration for ModelProvider.
 */
export interface ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ModelCapability[];
  getCapability(model?: string): ModelCapability | undefined;
  supportsTaskClass(taskClass: ModelTaskClass, model?: string): boolean;
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResponse>;
}
