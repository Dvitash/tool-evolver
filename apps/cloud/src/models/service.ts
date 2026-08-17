import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InferenceCache, computeInferenceCacheKey } from "./cache.js";
import { OutboundPrivacyGate } from "./privacy-gate.js";
import { PromptRegistry } from "./prompt-registry.js";
import { ModelRouter } from "./router.js";
import {
  InferenceProvenance,
  InferenceRequest,
  InferenceResponse,
  ModelPolicy,
  ModelUsage,
  ProviderExecutionRequest,
  ProviderExecutionResponse,
  RouteSelectionResult,
} from "./types.js";
import { StructuredOutputValidator } from "./validator.js";

/**
 * Error thrown when a requested prompt template is not found in the registry.
 */
export class PromptTemplateNotFoundError extends Error {
  public readonly templateId: string;
  public readonly version?: string;

  constructor(templateId: string, version?: string) {
    super(`Prompt template '${templateId}' (version: ${version ?? "latest"}) not found in registry`);
    this.name = "PromptTemplateNotFoundError";
    this.templateId = templateId;
    this.version = version;
  }
}

/**
 * Error thrown when inference execution fails across all providers.
 */
export class InferenceExecutionError extends Error {
  public readonly requestId: string;
  public readonly attempts: number;
  public readonly cause?: unknown;

  constructor(message: string, requestId: string, attempts: number, cause?: unknown) {
    super(`Inference execution failed for request '${requestId}' after ${attempts} attempts: ${message}`);
    this.name = "InferenceExecutionError";
    this.requestId = requestId;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Options to initialize InferenceService.
 */
export interface InferenceServiceOptions {
  promptRegistry?: PromptRegistry;
  privacyGate?: OutboundPrivacyGate;
  router?: ModelRouter;
  cache?: InferenceCache;
  validator?: StructuredOutputValidator;
}

/**
 * Main structured inference service orchestrating prompt resolution,
 * privacy redaction, caching, routing, provider execution, and schema validation with bounded repair.
 */
export class InferenceService {
  public readonly promptRegistry: PromptRegistry;
  public readonly privacyGate: OutboundPrivacyGate;
  public readonly router: ModelRouter;
  public readonly cache: InferenceCache;
  public readonly validator: StructuredOutputValidator;

  constructor(options: InferenceServiceOptions = {}) {
    this.promptRegistry = options.promptRegistry ?? new PromptRegistry();
    this.privacyGate = options.privacyGate ?? new OutboundPrivacyGate();
    this.router = options.router ?? new ModelRouter();
    this.cache = options.cache ?? new InferenceCache();
    this.validator = options.validator ?? new StructuredOutputValidator();
  }

  /**
   * Executes a structured inference request through the end-to-end gateway.
   */
  async infer<TInput = Record<string, unknown>, TOutput = unknown>(
    request: InferenceRequest<TInput, TOutput>,
  ): Promise<InferenceResponse<TOutput>> {
    const startTime = Date.now();
    const createdAt = new Date(startTime).toISOString();
    const requestId = request.requestId ?? `inf_${randomUUID()}`;

    // 1. Resolve prompt template
    const template = this.promptRegistry.get<TInput, TOutput>(
      request.promptTemplateId,
      request.promptTemplateVersion,
    );
    if (!template) {
      throw new PromptTemplateNotFoundError(request.promptTemplateId, request.promptTemplateVersion);
    }

    // 2. Render prompt and compute digests
    const rendered = this.promptRegistry.render(template, request.inputs);

    // 3. Resolve policy & check tenant rate limits
    const policy = this.router.getPolicy(request.taskClass, request.policyOverride);
    this.router.checkTenantRateLimit(request.tenantId, policy.rateLimitPerMinute);

    // 4. Privacy evaluation and redaction
    const sanitizedUserMessage = this.privacyGate.processString(rendered.userMessage, policy);

    // 5. Select provider route
    const route = this.router.selectRoute({
      tenantId: request.tenantId,
      taskClass: request.taskClass,
      policyOverride: request.policyOverride,
      preferredProviderId: request.preferredProviderId,
      preferredModel: request.preferredModel,
    });

    // 6. Check cache if not bypassed
    const cacheKey = computeInferenceCacheKey({
      tenantId: request.tenantId,
      providerId: route.providerId,
      model: route.model,
      templateId: template.id,
      templateVersion: template.version,
      inputDigest: rendered.inputDigest,
      schemaDigest: rendered.schemaDigest,
    });

    if (!request.bypassCache) {
      const cached = await this.cache.get<TOutput>(cacheKey, request.tenantId);
      if (cached) {
        const finishedAt = new Date().toISOString();
        return {
          requestId,
          tenantId: request.tenantId,
          taskClass: request.taskClass,
          output: cached.output,
          rawOutput: cached.rawOutput,
          provenance: {
            ...cached.provenance,
            requestId,
            cached: true,
            cacheKey,
            finishedAt,
          },
        };
      }
    }

    // 7. Execute on provider with fallback resilience
    const targetSchema = (request.schema as z.ZodType<TOutput>) ?? template.outputSchema;
    const { executionResponse, activeRoute, usageAccumulator } = await this.executeWithFallback({
      requestId,
      request: request as InferenceRequest<unknown, unknown>,
      initialRoute: route,
      systemInstruction: rendered.systemInstruction,
      userMessage: sanitizedUserMessage,
      jsonSchema: template.jsonSchema,
      schemaName: template.id,
      policy,
    });

    // 8. Structured output validation and bounded repair (max 2 attempts)
    const validationResult = await this.validator.validateWithRepair<TOutput>({
      rawText: executionResponse.rawText,
      schema: targetSchema,
      jsonSchema: template.jsonSchema,
      maxRepairAttempts: 2,
      repairExecutor: async (repairPrompt: string) => {
        const repairReq: ProviderExecutionRequest = {
          model: activeRoute.model,
          systemInstruction: rendered.systemInstruction,
          userMessage: repairPrompt,
          jsonSchema: template.jsonSchema,
          schemaName: `${template.id}_repair`,
          temperature: 0.1,
          maxTokens: policy.maxTokens,
        };

        const repairRes = await activeRoute.provider.execute(repairReq);
        this.accumulateUsage(usageAccumulator, repairRes.usage);
        return repairRes.rawText;
      },
    });

    const finishedTime = Date.now();
    const latencyMs = finishedTime - startTime;
    const finishedAt = new Date(finishedTime).toISOString();

    const provenance: InferenceProvenance = {
      requestId,
      tenantId: request.tenantId,
      taskClass: request.taskClass,
      providerId: activeRoute.providerId,
      providerName: activeRoute.provider.name,
      model: activeRoute.model,
      promptTemplateId: template.id,
      promptTemplateVersion: template.version,
      promptDigest: rendered.promptDigest,
      inputDigest: rendered.inputDigest,
      schemaDigest: rendered.schemaDigest,
      cached: false,
      cacheKey,
      repairAttempts: validationResult.repairAttempts,
      usage: usageAccumulator,
      latencyMs,
      createdAt,
      finishedAt,
    };

    // 9. Cache response if TTL > 0 and not bypassed
    if (!request.bypassCache && policy.cacheTtlSeconds > 0) {
      await this.cache.set(
        cacheKey,
        request.tenantId,
        {
          output: validationResult.output,
          rawOutput: validationResult.rawOutput,
          provenance,
        },
        policy.cacheTtlSeconds,
      );
    }

    return {
      requestId,
      tenantId: request.tenantId,
      taskClass: request.taskClass,
      output: validationResult.output,
      rawOutput: validationResult.rawOutput,
      provenance,
    };
  }

  /**
   * Executes inference on the primary route and automatically falls back to secondary routes on failure.
   */
  private async executeWithFallback(params: {
    requestId: string;
    request: InferenceRequest<unknown, unknown>;
    initialRoute: RouteSelectionResult;
    systemInstruction: string;
    userMessage: string;
    jsonSchema?: Record<string, unknown>;
    schemaName?: string;
    policy: ModelPolicy;
  }): Promise<{
    executionResponse: ProviderExecutionResponse;
    activeRoute: RouteSelectionResult;
    usageAccumulator: ModelUsage;
  }> {
    const candidateRoutes = [
      params.initialRoute,
      ...this.router.getFallbackRoutes(
        {
          tenantId: params.request.tenantId,
          taskClass: params.request.taskClass,
          policyOverride: params.request.policyOverride,
          preferredModel: params.request.preferredModel,
        },
        params.initialRoute.providerId,
      ),
    ];

    let lastError: unknown;
    let attempts = 0;

    for (const route of candidateRoutes) {
      attempts++;
      try {
        const execReq: ProviderExecutionRequest = {
          model: route.model,
          systemInstruction: params.systemInstruction,
          userMessage: params.userMessage,
          jsonSchema: params.jsonSchema,
          schemaName: params.schemaName,
          temperature: params.policy.defaultTemperature,
          maxTokens: params.policy.maxTokens,
          seed: params.policy.seed,
        };

        const executionResponse = await route.provider.execute(execReq);
        this.router.recordSuccess(route.providerId);

        const usageAccumulator: ModelUsage = {
          promptTokens: executionResponse.usage.promptTokens,
          completionTokens: executionResponse.usage.completionTokens,
          totalTokens: executionResponse.usage.totalTokens,
        };

        return {
          executionResponse,
          activeRoute: route,
          usageAccumulator,
        };
      } catch (err: unknown) {
        lastError = err;
        this.router.recordFailure(route.providerId);
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new InferenceExecutionError(message, params.requestId, attempts, lastError);
  }

  private accumulateUsage(target: ModelUsage, addition: ModelUsage): void {
    target.promptTokens += addition.promptTokens;
    target.completionTokens += addition.completionTokens;
    target.totalTokens += addition.totalTokens;
    if (addition.estimatedCostUsd) {
      target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + addition.estimatedCostUsd;
    }
  }
}
