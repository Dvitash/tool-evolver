export interface ToolSpec {
  id: string;
  name: string;
  version: string;
  description: string;
}

export interface ExecutionContext {
  sessionId: string;
  toolId: string;
  timestamp: number;
}

export const CONTRACTS_VERSION = "0.1.0";
