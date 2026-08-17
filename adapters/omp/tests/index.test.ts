import { describe, expect, it } from "vitest";
import { OmpAdapter } from "../src/index.js";

describe("OmpAdapter", () => {
  it("executes mock tool calls", async () => {
    const adapter = new OmpAdapter();
    await adapter.initialize();
    const res = await adapter.execute(
      { id: "t3", name: "tool3", version: "1.0.0", description: "desc3" },
      { query: "omp" },
    );
    expect(res).toEqual({
      adapter: "omp",
      toolId: "t3",
      input: { query: "omp" },
      output: "mock-omp-response",
    });
  });
});
