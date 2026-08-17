import { describe, expect, it } from "vitest";
import { CodexCliAdapter } from "../src/index.js";

describe("CodexCliAdapter", () => {
  it("executes mock tool calls", async () => {
    const adapter = new CodexCliAdapter();
    await adapter.initialize();
    const res = await adapter.execute(
      { id: "t2", name: "tool2", version: "1.0.0", description: "desc2" },
      { query: "world" },
    );
    expect(res).toEqual({
      adapter: "codex-cli",
      toolId: "t2",
      input: { query: "world" },
      output: "mock-codex-cli-response",
    });
  });
});
