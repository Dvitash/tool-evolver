import type { HarnessAdapter } from "@tool-evolver/harness-contracts";

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = "claude-code";
  readonly version = "0.1.0";

  async initialize(): Promise<void> {}

  async execute(
    tool: { id: string; name: string; version: string; description: string },
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return {
      adapter: this.name,
      toolId: tool.id,
      input,
      output: "mock-claude-code-response",
    };
  }
}
