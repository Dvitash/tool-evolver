import { describe, expect, it, vi } from "vitest";
import {
  FakeModelProvider,
  ModelRouter,
  NoAvailableProviderError,
  ProviderServerError,
  TenantRateLimitExceededError,
  createInferenceService,
} from "../../src/models/index.js";

describe("Model Router, Fallback & Circuit Breaking", () => {
  it("should route inference by task class to compatible provider", async () => {
    const router = new ModelRouter();
    const synthesisProvider = new FakeModelProvider({
      id: "synthesis-only",
      capabilities: [
        {
          name: "synth-model",
          supportedTaskClasses: ["tool_synthesis"],
          maxContextTokens: 64000,
          maxOutputTokens: 4096,
          supportsJsonSchema: true,
          supportsTemperature: true,
          supportsStreaming: false,
          supportsSeed: true,
          privacyLevel: "cloud_sanitized",
        },
      ],
    });

    const scoringProvider = new FakeModelProvider({
      id: "scoring-only",
      capabilities: [
        {
          name: "score-model",
          supportedTaskClasses: ["candidate_scoring"],
          maxContextTokens: 32000,
          maxOutputTokens: 2048,
          supportsJsonSchema: true,
          supportsTemperature: true,
          supportsStreaming: false,
          supportsSeed: true,
          privacyLevel: "cloud_sanitized",
        },
      ],
    });

    router.registerProvider(synthesisProvider);
    router.registerProvider(scoringProvider);

    const synthRoute = router.selectRoute({
      tenantId: "tenant-1",
      taskClass: "tool_synthesis",
    });
    expect(synthRoute.providerId).toBe("synthesis-only");

    const scoreRoute = router.selectRoute({
      tenantId: "tenant-1",
      taskClass: "candidate_scoring",
    });
    expect(scoreRoute.providerId).toBe("scoring-only");
  });

  it("should automatically fallback to secondary provider when primary provider fails", async () => {
    const primary = new FakeModelProvider({ id: "primary-failing" });
    primary.injectError(
      () => true,
      new ProviderServerError("Primary 503 Outage", "primary-failing", 503),
    );

    const secondary = new FakeModelProvider({ id: "secondary-backup" });

    const service = createInferenceService();
    service.router.registerProvider(primary);
    service.router.registerProvider(secondary);

    service.router.registerPolicy("opportunity_detection", {
      taskClass: "opportunity_detection",
      allowedPrivacyLevels: ["cloud_sanitized", "local"],
      defaultTemperature: 0.2,
      maxTemperature: 1.0,
      maxTokens: 4096,
      priorityProviders: ["primary-failing", "secondary-backup"],
      disallowedModels: [],
      cacheTtlSeconds: 3600,
      rateLimitPerMinute: 60,
      redactionStrictness: "strict",
      allowRawTranscripts: false,
    });

    const result = await service.infer({
      tenantId: "tenant-fallback",
      taskClass: "opportunity_detection",
      promptTemplateId: "opportunity_detection",
      inputs: { sessionId: "s1", traceData: "data", telemetrySummary: "summary" },
    });

    expect(result.provenance.providerId).toBe("secondary-backup");
    expect(primary.recordedCalls.length).toBe(1);
    expect(secondary.recordedCalls.length).toBe(1);
  });

  it("should trip circuit breaker to OPEN after failure threshold and skip failing provider", () => {
    const router = new ModelRouter({ failureThreshold: 3, circuitCooldownMs: 10000 });
    const provider = new FakeModelProvider({ id: "flaky-provider" });
    router.registerProvider(provider);

    expect(router.getCircuitState("flaky-provider")).toBe("CLOSED");

    router.recordFailure("flaky-provider");
    expect(router.getCircuitState("flaky-provider")).toBe("CLOSED");

    router.recordFailure("flaky-provider");
    expect(router.getCircuitState("flaky-provider")).toBe("CLOSED");

    // 3rd failure trips the circuit
    router.recordFailure("flaky-provider");
    expect(router.getCircuitState("flaky-provider")).toBe("OPEN");

    // Route selection should now skip the provider with open circuit
    expect(() =>
      router.selectRoute({
        tenantId: "tenant-cb",
        taskClass: "opportunity_detection",
      }),
    ).toThrow(NoAvailableProviderError);
  });

  it("should transition circuit from OPEN to HALF_OPEN after cooldown and close on success", () => {
    vi.useFakeTimers();
    try {
      const router = new ModelRouter({ failureThreshold: 2, circuitCooldownMs: 5000 });
      const provider = new FakeModelProvider({ id: "recovering-provider" });
      router.registerProvider(provider);

      router.recordFailure("recovering-provider");
      router.recordFailure("recovering-provider");
      expect(router.getCircuitState("recovering-provider")).toBe("OPEN");

      // Advance clock deterministically past cooldown
      vi.advanceTimersByTime(6000);
      expect(router.getCircuitState("recovering-provider")).toBe("HALF_OPEN");

      // Success in half-open resets circuit to CLOSED
      router.recordSuccess("recovering-provider");
      expect(router.getCircuitState("recovering-provider")).toBe("CLOSED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should enforce tenant rate limits and throw TenantRateLimitExceededError", () => {
    const router = new ModelRouter();
    const tenantId = "tenant-throttled";
    const limit = 3;

    expect(() => router.checkTenantRateLimit(tenantId, limit)).not.toThrow();
    expect(() => router.checkTenantRateLimit(tenantId, limit)).not.toThrow();
    expect(() => router.checkTenantRateLimit(tenantId, limit)).not.toThrow();

    // 4th request exceeds rate limit
    expect(() => router.checkTenantRateLimit(tenantId, limit)).toThrow(
      TenantRateLimitExceededError,
    );
  });
});
