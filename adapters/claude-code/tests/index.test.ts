import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/index.js";

describe("ClaudeCodeAdapter", () => {
  it("executes mock tool calls", async () => {
    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize();
    const res = await adapter.execute(
      { id: "t1", name: "tool", version: "1.0.0", description: "desc" },
      { query: "hello" },
    );
    expect(res).toEqual({
      adapter: "claude-code",
      toolId: "t1",
      input: { query: "hello" },
      output: "mock-claude-code-response",
    });
  });
});
