import type { HarnessAdapter } from "@tool-evolver/harness-contracts";

export class OmpAdapter implements HarnessAdapter {
  readonly name = "omp";
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
      output: "mock-omp-response",
    };
  }
}
