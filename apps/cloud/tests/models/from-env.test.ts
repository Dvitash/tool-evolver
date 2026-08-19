import { describe, expect, it } from "vitest";
import { createInferenceServiceFromEnv } from "../../src/models/from-env.js";

describe("createInferenceServiceFromEnv", () => {
  it("registers an OpenAI-compatible provider from MODEL_* env", () => {
    const service = createInferenceServiceFromEnv({
      MODEL_PROVIDER: "openai-compatible",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_API_KEY: "sk-or-v1-test-key",
      MODEL_ID: "deepseek/deepseek-v4-flash",
      MODEL_ALLOW_DETERMINISTIC_FALLBACK: "false",
      MODEL_REASONING_EFFORT: "low",
      MODEL_REASONING_ENABLED: "true",
    });

    const provider = service.router.getProvider("openai-compatible");
    expect(provider).toBeDefined();
    expect(provider?.getCapability()?.name).toBe("deepseek/deepseek-v4-flash");
    expect(service.router.getProvider("fake-provider")).toBeUndefined();
  });

  it("registers FakeModelProvider only when deterministic fallback is allowed", () => {
    const service = createInferenceServiceFromEnv({
      MODEL_ALLOW_DETERMINISTIC_FALLBACK: "true",
    });
    expect(service.router.getProvider("fake-provider")).toBeDefined();
  });
});
