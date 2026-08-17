/**
 * @tool-evolver/protocol
 *
 * Wire protocol, device authentication envelopes, OpenAPI schemas,
 * control streams, and mock fixtures for Tool Evolver.
 */

// Error Taxonomy & Error Classes
export * from "./errors.js";

// Protocol Message Envelope & Helpers
export * from "./envelope.js";

// Device Authentication & Token Lifecycle
export * from "./auth.js";

// HTTP Endpoints, Data Models & OpenAPI 3.1 Specification
export * from "./http.js";

// Bidirectional Control Stream, Sequencing, Replay Buffer & Backoff
export * from "./stream.js";

// Deterministic Mock Protocol Server & Fixtures
export * from "./mock.js";

// Local-to-Cloud Protocol Client
export * from "./client.js";

// Protocol Version
export const PROTOCOL_VERSION = "1.0.0";

// Backward Compatibility Helpers
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
