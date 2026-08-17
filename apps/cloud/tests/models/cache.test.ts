import { describe, expect, it, vi } from "vitest";
import {
  FakeModelProvider,
  InferenceCache,
  computeInferenceCacheKey,
  createInferenceService,
} from "../../src/models/index.js";

describe("Deterministic Response Cache & Tenant Isolation", () => {
  it("should return cached response on identical request without invoking provider again", async () => {
    const fakeProvider = new FakeModelProvider({ id: "cache-provider" });
    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const requestPayload = {
      tenantId: "tenant-cache-1",
      taskClass: "opportunity_detection" as const,
      promptTemplateId: "opportunity_detection",
      inputs: {
        sessionId: "sess-cache-001",
        traceData: "trace sample",
        telemetrySummary: "telemetry sample",
      },
    };

    // First call: cache miss
    const res1 = await service.infer(requestPayload);
    expect(res1.provenance.cached).toBe(false);
    expect(fakeProvider.recordedCalls.length).toBe(1);

    // Second call: cache hit
    const res2 = await service.infer(requestPayload);
    expect(res2.provenance.cached).toBe(true);
    expect(res2.output).toEqual(res1.output);
    expect(fakeProvider.recordedCalls.length).toBe(1); // Provider not called second time
  });

  it("should enforce strict tenant cache isolation (no cross-tenant leakage)", async () => {
    const fakeProvider = new FakeModelProvider({ id: "iso-provider" });
    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const commonInputs = {
      sessionId: "shared-session",
      traceData: "identical trace data",
      telemetrySummary: "identical telemetry summary",
    };

    // Tenant A executes inference
    const resA = await service.infer({
      tenantId: "tenant-AAA",
      taskClass: "opportunity_detection",
      promptTemplateId: "opportunity_detection",
      inputs: commonInputs,
    });
    expect(resA.provenance.cached).toBe(false);
    expect(resA.provenance.tenantId).toBe("tenant-AAA");
    expect(fakeProvider.recordedCalls.length).toBe(1);

    // Tenant B executes inference with identical inputs
    const resB = await service.infer({
      tenantId: "tenant-BBB",
      taskClass: "opportunity_detection",
      promptTemplateId: "opportunity_detection",
      inputs: commonInputs,
    });

    // Tenant B MUST NOT get Tenant A's cached entry
    expect(resB.provenance.cached).toBe(false);
    expect(resB.provenance.tenantId).toBe("tenant-BBB");
    expect(fakeProvider.recordedCalls.length).toBe(2);

    // Ensure distinct cache keys
    const keyA = computeInferenceCacheKey({
      tenantId: "tenant-AAA",
      providerId: "iso-provider",
      model: "fake-default-model",
      templateId: "opportunity_detection",
      templateVersion: "1.0.0",
      inputDigest: resA.provenance.inputDigest,
      schemaDigest: resA.provenance.schemaDigest,
    });

    const keyB = computeInferenceCacheKey({
      tenantId: "tenant-BBB",
      providerId: "iso-provider",
      model: "fake-default-model",
      templateId: "opportunity_detection",
      templateVersion: "1.0.0",
      inputDigest: resB.provenance.inputDigest,
      schemaDigest: resB.provenance.schemaDigest,
    });

    expect(keyA).not.toBe(keyB);
  });

  it("should bypass cache when bypassCache flag is set", async () => {
    const fakeProvider = new FakeModelProvider({ id: "bypass-provider" });
    const service = createInferenceService();
    service.router.registerProvider(fakeProvider);

    const req = {
      tenantId: "tenant-bypass",
      taskClass: "opportunity_detection" as const,
      promptTemplateId: "opportunity_detection",
      inputs: {
        sessionId: "sess-b",
        traceData: "trace",
        telemetrySummary: "telemetry",
      },
    };

    // First call: cache miss
    await service.infer(req);
    expect(fakeProvider.recordedCalls.length).toBe(1);

    // Second call with bypassCache: executes provider
    const res2 = await service.infer({
      ...req,
      bypassCache: true,
    });
    expect(res2.provenance.cached).toBe(false);
    expect(fakeProvider.recordedCalls.length).toBe(2);
  });

  it("should support tenant invalidation without affecting other tenants", async () => {
    const cache = new InferenceCache();
    const fakeProv = {
      requestId: "r1",
      tenantId: "tenant-1",
      taskClass: "opportunity_detection" as const,
      providerId: "p1",
      providerName: "p1",
      model: "m1",
      promptTemplateId: "t1",
      promptTemplateVersion: "1.0.0",
      promptDigest: "digest1",
      inputDigest: "digest2",
      schemaDigest: "digest3",
      cached: false,
      repairAttempts: 0,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      latencyMs: 15,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };

    await cache.set("key-1", "tenant-1", { output: { a: 1 }, provenance: fakeProv });
    await cache.set("key-2", "tenant-2", {
      output: { b: 2 },
      provenance: { ...fakeProv, tenantId: "tenant-2" },
    });

    expect(await cache.get("key-1", "tenant-1")).not.toBeNull();
    expect(await cache.get("key-2", "tenant-2")).not.toBeNull();

    // Invalidate tenant-1 only
    const deletedCount = await cache.invalidateTenant("tenant-1");
    expect(deletedCount).toBe(1);

    expect(await cache.get("key-1", "tenant-1")).toBeNull();
    expect(await cache.get("key-2", "tenant-2")).not.toBeNull();
  });

  it("should expire cache entries after TTL", async () => {
    vi.useFakeTimers();
    try {
      const cache = new InferenceCache({ defaultTtlSeconds: 10 });
      const fakeProv = {
        requestId: "r1",
        tenantId: "tenant-ttl",
        taskClass: "opportunity_detection" as const,
        providerId: "p1",
        providerName: "p1",
        model: "m1",
        promptTemplateId: "t1",
        promptTemplateVersion: "1.0.0",
        promptDigest: "digest1",
        inputDigest: "digest2",
        schemaDigest: "digest3",
        cached: false,
        repairAttempts: 0,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        latencyMs: 15,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };

      await cache.set("key-ttl", "tenant-ttl", { output: { val: 1 }, provenance: fakeProv }, 10);
      expect(await cache.get("key-ttl", "tenant-ttl")).not.toBeNull();

      // Advance time by 11 seconds
      vi.advanceTimersByTime(11000);
      expect(await cache.get("key-ttl", "tenant-ttl")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
