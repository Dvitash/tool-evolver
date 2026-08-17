import type { ToolSpec } from "@tool-evolver/contracts";

export interface HarnessAdapter {
  name: string;
  version: string;
  initialize(): Promise<void>;
  execute(tool: ToolSpec, input: Record<string, unknown>): Promise<unknown>;
}

export const HARNESS_CONTRACTS_VERSION = "0.1.0";
