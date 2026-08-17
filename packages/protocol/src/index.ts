import type { ToolSpec } from "@tool-evolver/contracts";

export interface ProtocolMessage<T = unknown> {
  id: string;
  type: string;
  payload: T;
  timestamp: number;
}

export function createMessage<T>(type: string, payload: T): ProtocolMessage<T> {
  return {
    id: crypto.randomUUID(),
    type,
    payload,
    timestamp: Date.now(),
  };
}

export const PROTOCOL_VERSION = "0.1.0";
