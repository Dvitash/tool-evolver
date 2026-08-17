import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermeticE2EEnvironment } from "../src/environment.js";
import { runUserControlsScenario } from "../src/scenarios/user-controls.js";

describe("E2E - User Controls, Pinning, and Emergency Switches", () => {
  let env: HermeticE2EEnvironment;

  beforeEach(async () => {
    env = new HermeticE2EEnvironment();
    await env.initialize();
  });

  afterEach(async () => {
    await env.shutdown();
  });

  it("enforces explicit pause evolution, execution kill switch, tool deactivation, version pinning, manual rollback, and cloud disconnect", async () => {
    const result = await runUserControlsScenario(env);

    expect(result.success).toBe(true);
    expect(result.pauseEvolutionRespected).toBe(true);
    expect(result.disableExecutionRespected).toBe(true);
    expect(result.disableToolRespected).toBe(true);
    expect(result.pinVersionRespected).toBe(true);
    expect(result.manualRollbackRespected).toBe(true);
    expect(result.emergencyDisconnectRespected).toBe(true);

    const report = env.traceReporter.getReport();
    expect(report.categories["user-controls"].passed).toBeGreaterThanOrEqual(6);
    expect(report.categories["user-controls"].failed).toBe(0);
  });
});
