import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermeticE2EEnvironment } from "../src/environment.js";
import { runAdversarialSecurityScenario } from "../src/scenarios/adversarial-security.js";

describe("E2E - Adversarial Security and Privacy Boundaries", () => {
  let env: HermeticE2EEnvironment;

  beforeEach(async () => {
    env = new HermeticE2EEnvironment();
    await env.initialize();
  });

  afterEach(async () => {
    await env.shutdown();
  });

  it("redacts seeded secrets, blocks prompt injection, prevents path traversal, and restricts shell injection", async () => {
    const result = await runAdversarialSecurityScenario(env);

    expect(result.success).toBe(true);
    expect(result.secretsRedacted).toBe(true);
    expect(result.promptInjectionBlocked).toBe(true);
    expect(result.pathTraversalBlocked).toBe(true);
    expect(result.shellInjectionBlocked).toBe(true);
    expect(result.rawUploadBlocked).toBe(true);

    const report = env.traceReporter.getReport();
    expect(report.categories.security.passed).toBeGreaterThanOrEqual(4);
    expect(report.categories.security.failed).toBe(0);
  });
});
