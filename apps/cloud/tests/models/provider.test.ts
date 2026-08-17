import { describe, expect, it } from "vitest";
import {
  FakeModelProvider,
  OpenAiCompatibleProvider,
  ProviderAuthError,
  ProviderNetworkError,
  ProviderRateLimitError,
  ProviderServerError,
} from "../../src/models/index.js";

describe("Model Providers (Fake & OpenAI-Compatible)", () => {
  it("should record calls and support mock handlers in FakeModelProvider", async () => {
    const provider = new FakeModelProvider({ id: "test-fake" });

    provider.setMockResponse((req) => req.userMessage.includes("special trigger"), {
      custom: "handled",
    });

    const res1 = await provider.execute({
      model: "fake-default-model",
      systemInstruction: "sys",
      userMessage: "special trigger here",
    });

    expect(res1.parsedJson).toEqual({ custom: "handled" });
    expect(provider.recordedCalls.length).toBe(1);

    // Default synthetic generator
    const res2 = await provider.execute({
      model: "fake-default-model",
      systemInstruction: "You are the Tool Evolver Opportunity Detection Engine",
      userMessage: "Detect opportunities",
    });

    expect((res2.parsedJson as any).opportunities).toBeDefined();
    expect(provider.recordedCalls.length).toBe(2);
  });

  it("should support fault injection in FakeModelProvider", async () => {
    const provider = new FakeModelProvider();

    provider.injectError(
      (req) => req.userMessage.includes("fail_me"),
      new Error("Injected simulated error"),
    );

    await expect(
      provider.execute({
        model: "fake-default-model",
        systemInstruction: "sys",
        userMessage: "please fail_me now",
      }),
    ).rejects.toThrow("Injected simulated error");

    provider.injectInvalidJson((req) => req.userMessage.includes("invalid_json"), "{ broken...");

    const invalidRes = await provider.execute({
      model: "fake-default-model",
      systemInstruction: "sys",
      userMessage: "give me invalid_json",
    });

    expect(invalidRes.rawText).toBe("{ broken...");
    expect(invalidRes.parsedJson).toBeUndefined();
  });

  it("should execute OpenAI-compatible requests and parse json_schema structured outputs", async () => {
    let capturedUrl = "";
    let capturedBody: any;
    let capturedHeaders: Record<string, string> = {};

    const mockFetch: typeof fetch = async (url, init) => {
      capturedUrl = url.toString();
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = init?.headers as Record<string, string>;

      const responsePayload = {
        id: "chatcmpl-test",
        choices: [
          {
            message: {
              content: JSON.stringify({
                opportunities: [
                  {
                    id: "opp_openai_1",
                    title: "OpenAI Detected Opportunity",
                    description: "Detected via OpenAI compatible provider",
                    taskClass: "opportunity_detection",
                    pattern: "high_latency",
                    confidenceScore: 0.96,
                    evidence: ["evidence 1"],
                    priority: "high",
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 85,
          total_tokens: 205,
        },
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const provider = new OpenAiCompatibleProvider({
      id: "openai-test",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-mock-key-12345",
      defaultModel: "gpt-4o-mini",
      customFetch: mockFetch,
    });

    const schema = {
      type: "object",
      properties: {
        opportunities: { type: "array" },
      },
      required: ["opportunities"],
    };

    const res = await provider.execute({
      model: "gpt-4o-mini",
      systemInstruction: "You are the Opportunity Detection Engine.",
      userMessage: "Session data here",
      jsonSchema: schema,
      schemaName: "opportunity_detection_schema",
      temperature: 0.1,
      seed: 42,
    });

    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(capturedHeaders.Authorization).toBe("Bearer sk-test-mock-key-12345");
    expect(capturedBody.model).toBe("gpt-4o-mini");
    expect(capturedBody.temperature).toBe(0.1);
    expect(capturedBody.seed).toBe(42);
    expect(capturedBody.response_format.type).toBe("json_schema");
    expect(capturedBody.response_format.json_schema.name).toBe("opportunity_detection_schema");
    expect(capturedBody.response_format.json_schema.strict).toBe(true);

    expect(res.usage.promptTokens).toBe(120);
    expect(res.usage.completionTokens).toBe(85);
    expect(res.usage.totalTokens).toBe(205);
    expect((res.parsedJson as any).opportunities[0].id).toBe("opp_openai_1");
  });

  it("should map HTTP error statuses to typed provider errors in OpenAiCompatibleProvider", async () => {
    const authErrorFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });

    const rateLimitFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "retry-after": "30" },
      });

    const serverErrorFetch: typeof fetch = async () =>
      new Response("Internal Server Error", { status: 502 });

    const authProvider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      customFetch: authErrorFetch,
    });

    await expect(
      authProvider.execute({
        model: "gpt-4o-mini",
        systemInstruction: "sys",
        userMessage: "msg",
      }),
    ).rejects.toThrow(ProviderAuthError);

    const rateLimitProvider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      customFetch: rateLimitFetch,
    });

    await expect(
      rateLimitProvider.execute({
        model: "gpt-4o-mini",
        systemInstruction: "sys",
        userMessage: "msg",
      }),
    ).rejects.toThrow(ProviderRateLimitError);

    const serverErrorProvider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      customFetch: serverErrorFetch,
    });

    await expect(
      serverErrorProvider.execute({
        model: "gpt-4o-mini",
        systemInstruction: "sys",
        userMessage: "msg",
      }),
    ).rejects.toThrow(ProviderServerError);
  });
});
