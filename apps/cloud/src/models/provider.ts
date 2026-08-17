import { setTimeout as delay } from "node:timers/promises";
import {
  ModelCapability,
  ModelProvider,
  ModelTaskClass,
  ModelUsage,
  ProviderExecutionRequest,
  ProviderExecutionResponse,
} from "./types.js";

/**
 * Base provider error.
 */
export class ProviderError extends Error {
  public readonly providerId: string;
  public readonly statusCode?: number;
  public readonly retryable: boolean;

  constructor(message: string, providerId: string, statusCode?: number, retryable = false) {
    super(`[${providerId}] ${message}`);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(message: string, providerId: string) {
    super(message, providerId, 401, false);
    this.name = "ProviderAuthError";
  }
}

export class ProviderRateLimitError extends ProviderError {
  public readonly retryAfterSeconds?: number;

  constructor(message: string, providerId: string, retryAfterSeconds?: number) {
    super(message, providerId, 429, true);
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProviderServerError extends ProviderError {
  constructor(message: string, providerId: string, statusCode = 500) {
    super(message, providerId, statusCode, true);
    this.name = "ProviderServerError";
  }
}

export class ProviderNetworkError extends ProviderError {
  constructor(message: string, providerId: string) {
    super(message, providerId, undefined, true);
    this.name = "ProviderNetworkError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message: string, providerId: string) {
    super(message, providerId, 408, true);
    this.name = "ProviderTimeoutError";
  }
}

/**
 * Synthetic mock response generator function.
 */
export type MockResponseGenerator = (
  req: ProviderExecutionRequest,
) => Promise<unknown> | unknown;

/**
 * In-memory deterministic fake model provider for testing and offline simulation.
 */
export class FakeModelProvider implements ModelProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly capabilities: ModelCapability[];
  public simulatedLatencyMs: number = 0;
  public recordedCalls: ProviderExecutionRequest[] = [];

  private mockResponses: Array<{
    matcher: (req: ProviderExecutionRequest) => boolean;
    generator: MockResponseGenerator;
  }> = [];

  private faults: Array<{
    matcher: (req: ProviderExecutionRequest) => boolean;
    action: (req: ProviderExecutionRequest) => never | string | unknown;
  }> = [];

  constructor(options: {
    id?: string;
    name?: string;
    capabilities?: ModelCapability[];
    simulatedLatencyMs?: number;
  } = {}) {
    this.id = options.id ?? "fake-provider";
    this.name = options.name ?? "Fake In-Memory Model Provider";
    this.simulatedLatencyMs = options.simulatedLatencyMs ?? 0;
    this.capabilities = options.capabilities ?? [
      {
        name: "fake-default-model",
        supportedTaskClasses: [
          "opportunity_detection",
          "candidate_planning",
          "tool_synthesis",
          "test_generation",
          "candidate_scoring",
        ],
        maxContextTokens: 128000,
        maxOutputTokens: 8192,
        supportsJsonSchema: true,
        supportsTemperature: true,
        supportsStreaming: false,
        supportsSeed: true,
        privacyLevel: "local",
      },
    ];
  }

  getCapability(model?: string): ModelCapability | undefined {
    if (!model) return this.capabilities[0];
    return this.capabilities.find((c) => c.name === model) ?? this.capabilities[0];
  }

  supportsTaskClass(taskClass: ModelTaskClass, model?: string): boolean {
    const cap = this.getCapability(model);
    return cap ? cap.supportedTaskClasses.includes(taskClass) : false;
  }

  /**
   * Registers a mock response generator when the matcher predicate returns true.
   */
  setMockResponse(
    matcher: (req: ProviderExecutionRequest) => boolean,
    generator: MockResponseGenerator | unknown,
  ): void {
    const genFn = typeof generator === "function" ? (generator as MockResponseGenerator) : () => generator;
    this.mockResponses.unshift({ matcher, generator: genFn });
  }

  /**
   * Injects an error fault when the matcher matches.
   */
  injectFault(
    matcher: (req: ProviderExecutionRequest) => boolean,
    action: (req: ProviderExecutionRequest) => never | string | unknown,
  ): void {
    this.faults.unshift({ matcher, action });
  }

  /**
   * Injects a standard provider error.
   */
  injectError(matcher: (req: ProviderExecutionRequest) => boolean, error: Error): void {
    this.injectFault(matcher, () => {
      throw error;
    });
  }

  /**
   * Injects invalid unparseable JSON text.
   */
  injectInvalidJson(matcher: (req: ProviderExecutionRequest) => boolean, invalidText = "{ malformed json ..."): void {
    this.injectFault(matcher, () => invalidText);
  }

  /**
   * Injects a response that violates the expected schema.
   */
  injectSchemaViolation(matcher: (req: ProviderExecutionRequest) => boolean, violationData: unknown = { unexpectedField: 123 }): void {
    this.injectFault(matcher, () => JSON.stringify(violationData));
  }

  /**
   * Resets recorded calls and mock configurations.
   */
  reset(): void {
    this.recordedCalls = [];
    this.mockResponses = [];
    this.faults = [];
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResponse> {
    const startTime = Date.now();
    this.recordedCalls.push({ ...request });

    if (this.simulatedLatencyMs > 0) {
      await delay(this.simulatedLatencyMs);
    }

    // Check fault injections first
    for (const fault of this.faults) {
      if (fault.matcher(request)) {
        const result = fault.action(request);
        if (typeof result === "string") {
          const latencyMs = Date.now() - startTime;
          return {
            rawText: result,
            model: request.model,
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            latencyMs,
          };
        }
      }
    }

    // Check custom registered mock responses
    for (const mock of this.mockResponses) {
      if (mock.matcher(request)) {
        const responseData = await mock.generator(request);
        const rawText = typeof responseData === "string" ? responseData : JSON.stringify(responseData);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(rawText);
        } catch {
          // ignore if unparseable
        }
        const latencyMs = Date.now() - startTime;
        return {
          rawText,
          parsedJson,
          usage: {
            promptTokens: Math.ceil(request.userMessage.length / 4),
            completionTokens: Math.ceil(rawText.length / 4),
            totalTokens: Math.ceil((request.userMessage.length + rawText.length) / 4),
          },
          model: request.model,
          latencyMs,
        };
      }
    }

    // Default synthetic response generation based on request context and schema
    const syntheticData = this.generateSyntheticResponse(request);
    const rawText = JSON.stringify(syntheticData, null, 2);
    const latencyMs = Date.now() - startTime;

    return {
      rawText,
      parsedJson: syntheticData,
      usage: {
        promptTokens: Math.ceil(request.userMessage.length / 4),
        completionTokens: Math.ceil(rawText.length / 4),
        totalTokens: Math.ceil((request.userMessage.length + rawText.length) / 4),
      },
      model: request.model,
      latencyMs,
    };
  }

  private generateSyntheticResponse(request: ProviderExecutionRequest): unknown {
    const schemaName = (request.schemaName || "").toLowerCase();
    const system = (request.systemInstruction || "").toLowerCase();
    const userMsg = (request.userMessage || "").toLowerCase();

    // 1. Candidate Planning (checked before opportunity to avoid matching "opportunity id")
    if (
      schemaName.includes("candidate_planning") ||
      system.includes("candidate planning") ||
      userMsg.includes("candidate evolution plan")
    ) {
      return {
        planId: "plan_syn_001",
        targetToolName: "fs_buffered_read",
        action: "create",
        summary: "Introduce chunked buffered file reader to eliminate sequential I/O overhead.",
        interfaceChanges: ["+ readBuffered(path, bufferSize)"],
        securityRisks: ["Ensure sandbox directory jail is respected."],
        estimatedImpact: "Reduces trace latency by ~65%",
      };
    }

    // 2. Opportunity Detection
    if (
      schemaName.includes("opportunity_detection") ||
      system.includes("opportunity detection") ||
      userMsg.includes("detect evolution opportunities")
    ) {
      return {
        opportunities: [
          {
            id: "opp_syn_001",
            title: "Optimize file read buffering",
            description: "High latency detected in repeated sequential read operations.",
            taskClass: "opportunity_detection",
            pattern: "sequential_io_bottleneck",
            confidenceScore: 0.94,
            evidence: ["12 tool invocations with >200ms latency", "Redundant directory scans"],
            priority: "high",
          },
        ],
      };
    }

    // 3. Tool Synthesis
    if (
      schemaName.includes("tool_synthesis") ||
      system.includes("tool synthesis") ||
      userMsg.includes("synthesize tool implementation")
    ) {
      return {
        toolId: "tool_syn_001",
        name: "fs_buffered_read",
        version: "1.0.0",
        description: "Buffered file reader for high-throughput sequential reading.",
        schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            bufferSizeBytes: { type: "number", default: 65536 },
          },
          required: ["path"],
        },
        code: "export async function run(args: { path: string }) { return Deno.readTextFile(args.path); }",
        runtimeRequirements: ["deno:fs_read"],
      };
    }

    // 4. Test Generation
    if (
      schemaName.includes("test_generation") ||
      system.includes("test generation") ||
      userMsg.includes("generate test suite")
    ) {
      return {
        suiteId: "suite_syn_001",
        targetTool: "fs_buffered_read",
        unitTests: [
          {
            name: "reads file content successfully",
            description: "Verifies buffered read produces exact text content.",
            code: "Deno.test('reads content', async () => { /* test logic */ });",
          },
        ],
        propertyTests: [
          {
            name: "idempotent reads",
            property: "Multiple sequential reads produce identical bytes.",
            code: "Deno.test('idempotency', async () => { /* property logic */ });",
          },
        ],
        edgeCases: ["Empty file", "Large 100MB file", "Non-existent path"],
      };
    }

    // 5. Candidate Scoring
    if (
      schemaName.includes("candidate_scoring") ||
      system.includes("candidate scoring") ||
      userMsg.includes("score candidate tool")
    ) {
      return {
        candidateId: "cand_syn_001",
        overallScore: 92.5,
        approved: true,
        categories: {
          quality: 95,
          performance: 90,
          security: 98,
          utility: 87,
        },
        rationale: "Exceeds all quality gates, zero capability envelope violations, 4x throughput improvement.",
        recommendations: ["Promote to canary deployment tier."],
      };
    }

    // Generic schema mock fallback
    return {
      status: "success",
      timestamp: new Date().toISOString(),
      details: "Synthetic structured model response.",
    };
  }
}

/**
 * OpenAiCompatibleProvider options.
 */
export interface OpenAiCompatibleProviderOptions {
  id?: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  organizationId?: string;
  defaultModel?: string;
  timeoutMs?: number;
  capabilities?: ModelCapability[];
  customFetch?: typeof fetch;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Model provider communicating with OpenAI or OpenAI-compatible endpoints
 * (e.g. OpenAI, Azure OpenAI, Groq, Together, Ollama, vLLM).
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly capabilities: ModelCapability[];
  private baseUrl: string;
  private apiKey?: string;
  private organizationId?: string;
  private defaultModel: string;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.id = options.id ?? "openai-compatible";
    this.name = options.name ?? "OpenAI-Compatible Provider";
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.organizationId = options.organizationId;
    this.defaultModel = options.defaultModel ?? "gpt-4o-mini";
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchFn = options.customFetch ?? globalThis.fetch;

    this.capabilities = options.capabilities ?? [
      {
        name: this.defaultModel,
        supportedTaskClasses: [
          "opportunity_detection",
          "candidate_planning",
          "tool_synthesis",
          "test_generation",
          "candidate_scoring",
        ],
        maxContextTokens: 128000,
        maxOutputTokens: 8192,
        supportsJsonSchema: true,
        supportsTemperature: true,
        supportsStreaming: false,
        supportsSeed: true,
        privacyLevel: "cloud_sanitized",
      },
    ];
  }

  getCapability(model?: string): ModelCapability | undefined {
    const targetModel = model ?? this.defaultModel;
    return this.capabilities.find((c) => c.name === targetModel) ?? this.capabilities[0];
  }

  supportsTaskClass(taskClass: ModelTaskClass, model?: string): boolean {
    const cap = this.getCapability(model);
    return cap ? cap.supportedTaskClasses.includes(taskClass) : false;
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResponse> {
    const startTime = Date.now();
    const model = request.model || this.defaultModel;
    const url = `${this.baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (this.organizationId) {
      headers["OpenAI-Organization"] = this.organizationId;
    }

    const payload: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: request.systemInstruction },
        { role: "user", content: request.userMessage },
      ],
      temperature: request.temperature ?? 0.2,
    };

    if (request.maxTokens) {
      payload.max_tokens = request.maxTokens;
    }
    if (request.seed !== undefined) {
      payload.seed = request.seed;
    }
    if (request.stopSequences && request.stopSequences.length > 0) {
      payload.stop = request.stopSequences;
    }

    if (request.jsonSchema) {
      payload.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.schemaName ?? "structured_output",
          strict: true,
          schema: request.jsonSchema,
        },
      };
    }

    const timeout = request.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort || controller.signal.aborted) {
        throw new ProviderTimeoutError(`Request timed out after ${timeout}ms`, this.id);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderNetworkError(`Network error communicating with provider: ${message}`, this.id);
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        // ignore
      }

      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(`Authentication failed: ${errorBody}`, this.id);
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || undefined;
        throw new ProviderRateLimitError(`Rate limit exceeded: ${errorBody}`, this.id, retryAfter);
      }
      if (response.status >= 500) {
        throw new ProviderServerError(`Server returned error ${response.status}: ${errorBody}`, this.id, response.status);
      }

      throw new ProviderError(`Provider request failed with status ${response.status}: ${errorBody}`, this.id, response.status);
    }

    let responseJson: OpenAiChatCompletionResponse;
    try {
      responseJson = (await response.json()) as OpenAiChatCompletionResponse;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`Failed to parse response JSON: ${message}`, this.id);
    }

    const choice = responseJson.choices?.[0];
    const rawText = choice?.message?.content ?? "";
    const finishReason = choice?.finish_reason;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      // ignore
    }

    const usage: ModelUsage = {
      promptTokens: responseJson.usage?.prompt_tokens ?? 0,
      completionTokens: responseJson.usage?.completion_tokens ?? 0,
      totalTokens: responseJson.usage?.total_tokens ?? 0,
    };

    return {
      rawText,
      parsedJson,
      usage,
      model,
      latencyMs,
      finishReason,
    };
  }
}
