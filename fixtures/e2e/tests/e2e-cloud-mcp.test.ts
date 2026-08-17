import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermeticE2EEnvironment } from "../src/environment.js";
import { runCloudMcpProxyScenario } from "../src/scenarios/cloud-mcp-proxy.js";

describe("E2E - Cloud MCP Proxying, Lineage, and Resilience", () => {
  let env: HermeticE2EEnvironment;

  beforeEach(async () => {
    env = new HermeticE2EEnvironment();
    await env.initialize();
  });

  afterEach(async () => {
    await env.shutdown();
  });

  it("queries get_evolution_status, retrieves get_tool_lineage provenance, supports abort cancellation, and degrades offline gracefully", async () => {
    const result = await runCloudMcpProxyScenario(env);

    expect(result.success).toBe(true);
    expect(result.evolutionStatusRetrieved).toBe(true);
    expect(result.toolLineageRetrieved).toBe(true);
    expect(result.cancellationRespected).toBe(true);
    expect(result.offlineDegradationHandled).toBe(true);

    const report = env.traceReporter.getReport();
    expect(report.categories["cloud-proxy"].passed).toBeGreaterThanOrEqual(4);
    expect(report.categories["cloud-proxy"].failed).toBe(0);
  });
});
