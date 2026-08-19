import { FakeModelProvider, OpenAiCompatibleProvider } from "./provider.js";
import { InferenceService } from "./service.js";

function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function redactSecret(value: string | undefined): string {
  if (!value) return "(unset)";
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 7)}...${value.slice(-4)} (len=${value.length})`;
}

function parseExtraBody(env: Record<string, string | undefined>): Record<string, unknown> {
  const extraBody: Record<string, unknown> = {};
  const reasoningEffort = env.MODEL_REASONING_EFFORT?.trim();
  const reasoningEnabledRaw = env.MODEL_REASONING_ENABLED?.trim();
  if (reasoningEffort || reasoningEnabledRaw) {
    const reasoning: Record<string, unknown> = {};
    if (reasoningEnabledRaw !== undefined) {
      reasoning.enabled = envFlag(reasoningEnabledRaw);
    } else {
      reasoning.enabled = true;
    }
    if (reasoningEffort) {
      reasoning.effort = reasoningEffort;
    }
    extraBody.reasoning = reasoning;
  }
  return extraBody;
}

/**
 * Build an InferenceService from MODEL_* environment variables.
 * Used by the cloud backend so OpenRouter (or any OpenAI-compatible endpoint)
 * can be pointed at for live LLM testing.
 */
export function createInferenceServiceFromEnv(
  env: Record<string, string | undefined> = process.env,
): InferenceService {
  const service = new InferenceService();
  const providerKind = (env.MODEL_PROVIDER ?? "").trim().toLowerCase();
  const allowDeterministicFallback = envFlag(env.MODEL_ALLOW_DETERMINISTIC_FALLBACK);
  const logLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  const verbose = logLevel === "debug";

  const modelId = env.MODEL_ID?.trim();
  const baseUrl = env.MODEL_BASE_URL?.trim();
  const apiKey = env.MODEL_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();

  const shouldLogConfig = Boolean(providerKind) || verbose;
  if (shouldLogConfig) {
    console.log("[model] Configuring inference service from environment");
    console.log(`[model] MODEL_PROVIDER=${providerKind || "(unset)"}`);
    console.log(`[model] MODEL_BASE_URL=${baseUrl || "(unset)"}`);
    console.log(`[model] MODEL_ID=${modelId || "(unset)"}`);
    console.log(`[model] MODEL_API_KEY=${redactSecret(apiKey)}`);
    console.log(`[model] MODEL_ALLOW_DETERMINISTIC_FALLBACK=${allowDeterministicFallback}`);
    console.log(`[model] MODEL_REASONING_EFFORT=${env.MODEL_REASONING_EFFORT ?? "(unset)"}`);
    console.log(`[model] MODEL_REASONING_ENABLED=${env.MODEL_REASONING_ENABLED ?? "(unset)"}`);
  }

  if (providerKind === "openai-compatible") {
    if (!baseUrl) {
      throw new Error("MODEL_BASE_URL is required when MODEL_PROVIDER=openai-compatible");
    }
    if (!apiKey) {
      throw new Error("MODEL_API_KEY (or OPENROUTER_API_KEY) is required for openai-compatible");
    }
    if (!modelId) {
      throw new Error("MODEL_ID is required when MODEL_PROVIDER=openai-compatible");
    }

    const extraBody = parseExtraBody(env);
    const extraHeaders: Record<string, string> = {
      "HTTP-Referer": env.OPENROUTER_HTTP_REFERER ?? "http://localhost:8080",
      "X-Title": env.OPENROUTER_APP_TITLE ?? "tool-evolver-dev",
    };

    const fetchFn: typeof fetch = async (input, init) => {
      const started = Date.now();
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      console.log(`[model] request ${init?.method ?? "GET"} ${url} model=${modelId}`);
      if (verbose && extraBody.reasoning) {
        console.log(`[model] reasoning=${JSON.stringify(extraBody.reasoning)}`);
      }
      try {
        const response = await globalThis.fetch(input, init);
        console.log(
          `[model] response status=${response.status} latencyMs=${Date.now() - started} model=${modelId}`,
        );
        return response;
      } catch (err) {
        console.error(
          `[model] request failed after ${Date.now() - started}ms:`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      }
    };

    const provider = new OpenAiCompatibleProvider({
      id: "openai-compatible",
      name: "OpenAI-Compatible Provider",
      baseUrl,
      apiKey,
      defaultModel: modelId,
      timeoutMs: env.MODEL_TIMEOUT_MS ? Number(env.MODEL_TIMEOUT_MS) : 120000,
      extraHeaders,
      extraBody,
      customFetch: fetchFn,
      capabilities: [
        {
          name: modelId,
          supportedTaskClasses: [
            "opportunity_detection",
            "candidate_planning",
            "tool_synthesis",
            "test_generation",
            "candidate_scoring",
          ],
          maxContextTokens: 1000000,
          maxOutputTokens: 8192,
          supportsJsonSchema: true,
          supportsTemperature: true,
          supportsStreaming: false,
          supportsSeed: true,
          privacyLevel: "cloud_sanitized",
        },
      ],
    });
    service.router.registerProvider(provider);
    console.log(`[model] registered openai-compatible provider defaultModel=${modelId}`);
  } else if (providerKind) {
    throw new Error(`Unsupported MODEL_PROVIDER: ${providerKind}`);
  }

  if (allowDeterministicFallback) {
    service.router.registerProvider(new FakeModelProvider({ id: "fake-provider" }));
    if (shouldLogConfig) {
      console.log("[model] registered FakeModelProvider (deterministic fallback enabled)");
    }
  } else if (shouldLogConfig) {
    console.log("[model] deterministic fallback disabled; live provider only");
  }

  return service;
}
