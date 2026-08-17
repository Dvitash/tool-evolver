import type { ToolSpec } from "@tool-evolver/contracts";
import { type ProtocolMessage, createMessage } from "@tool-evolver/protocol";

export interface RuntimeEngine {
  isReady(): boolean;
  run(tool: ToolSpec): Promise<ProtocolMessage<{ toolId: string; status: string }>>;
}

export class DefaultRuntimeEngine implements RuntimeEngine {
  isReady(): boolean {
    return true;
  }

  async run(tool: ToolSpec): Promise<ProtocolMessage<{ toolId: string; status: string }>> {
    return createMessage("runtime:executed", { toolId: tool.id, status: "completed" });
  }
}
