import type { ProtocolMessage } from "@tool-evolver/protocol";

// Paths & Environment Resolution
export * from "./paths.js";

// Lockfile & Single-Instance Mechanics
export * from "./lock.js";

// Validated Configuration & Redaction
export * from "./config.js";

// Module Lifecycle, DAG Dependency Ordering & Timeouts
export * from "./lifecycle.js";

// Supervisor & Signal Handling
export * from "./supervisor.js";

// Internal IPC Protocol, Framing, Transports, Server & Client
export * from "./ipc/protocol.js";
export * from "./ipc/framing.js";
export * from "./ipc/transport.js";
export * from "./ipc/server.js";
export * from "./ipc/client.js";

// Worker Process Supervision & Isolation
export * from "./worker-supervisor.js";


// Transcript Tailing, Checkpointing, and Source Recovery
export * from "./tailing/index.js";

// Transcript Normalization, Deduplication, Privacy Redaction & Re-normalization
export * from "./normalization/index.js";
// Backward Compatibility Observer Service
export interface ObserverService {
  recordEvent(message: ProtocolMessage): void;
  getEventCount(): number;
}

export function createObserver(): ObserverService {
  const events: ProtocolMessage[] = [];
  return {
    recordEvent(msg) {
      events.push(msg);
    },
    getEventCount() {
      return events.length;
    },
  };
}
