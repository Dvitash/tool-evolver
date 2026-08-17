import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermeticE2EEnvironment } from "../src/environment.js";
import { runCrossHarnessIsolationScenario } from "../src/scenarios/cross-harness-isolation.js";

describe("E2E - Cross-Harness and Multi-Tenant Isolation", () => {
  let env: HermeticE2EEnvironment;

  beforeEach(async () => {
    env = new HermeticE2EEnvironment();
    await env.initialize();
  });

  afterEach(async () => {
    await env.shutdown();
  });

  it("segregates observation events, enforces workspace tool scoping, and provides invariant system meta-tools across Claude Code, Codex CLI, and OMP", async () => {
    const result = await runCrossHarnessIsolationScenario(env);

    expect(result.success).toBe(true);
    expect(result.eventSegregationVerified).toBe(true);
    expect(result.workspaceToolIsolationVerified).toBe(true);
    expect(result.systemMetaToolsUniformlyAccessible).toBe(true);
    expect(result.harnessCount).toBe(3);

    const report = env.traceReporter.getReport();
    expect(report.categories.isolation.passed).toBeGreaterThanOrEqual(3);
    expect(report.categories.isolation.failed).toBe(0);
  });
});
