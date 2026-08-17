// Core Schema & Type Exports

// Common Primitives
export * from "./common.js";

// Canonical Serialization & Hashing
export * from "./canonical.js";

// Session Events
export * from "./events.js";

// Tools & Manifests
export * from "./tools.js";

// Capabilities & Envelopes
export * from "./capabilities.js";

// Evolution Candidates
export * from "./candidates.js";

// Tool Versions & Artifacts
export * from "./versions.js";

// Deployments & State Machine
export * from "./deployments.js";

// Evaluation & Quality Gates
export * from "./evaluation.js";

// Workspace, Device, Invocation & Telemetry Records
export * from "./records.js";

// Legacy compatibility types and constants
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
