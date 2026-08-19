import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermeticE2EEnvironment } from "../src/environment.js";
import { runHappyPathScenario } from "../src/scenarios/happy-path.js";

describe("E2E - Autonomous Evolution Happy Path", () => {
  let env: HermeticE2EEnvironment;

  beforeEach(async () => {
    env = new HermeticE2EEnvironment();
    await env.initialize();
  });

  afterEach(async () => {
    await env.shutdown();
  });

  it("completes full autonomous tool lifecycle from repeated sessions to native & meta invocation", async () => {
    const result = await runHappyPathScenario(env);

    expect(result).toMatchObject({
      success: true,
      candidateValidated: true,
      candidateReplayed: true,
      candidateEvaluated: true,
      artifactPublished: true,
      localActivated: true,
      nativeInvocationSuccess: true,
      metaToolInvocationSuccess: true,
    });
    expect(result.toolName).toBeTruthy();

    // Verify trace assertions recorded cleanly
    const report = env.traceReporter.getReport();
    expect(report.summary.passed).toBeGreaterThan(0);
    expect(report.summary.failed).toBe(0);
  });

  it("discovers evolved tool in catalog via search_tools meta-tool", async () => {
    const result = await runHappyPathScenario(env);

    const searchRes = await env.invokeTool("search_tools", { query: result.toolName });
    expect(searchRes.success).toBe(true);
    const contentText = searchRes.content[0]?.text ?? "";
    expect(contentText).toContain(result.toolName);
  });

  it("inspects evolved tool schema via get_tool_schema meta-tool", async () => {
    const result = await runHappyPathScenario(env);

    const schemaRes = await env.invokeTool("get_tool_schema", { name: result.toolName });
    expect(schemaRes.success).toBe(true);
    const contentText = schemaRes.content[0]?.text ?? "";
    expect(contentText).toContain(result.toolName);
    expect(contentText).toContain("inputSchema");
  });
});
