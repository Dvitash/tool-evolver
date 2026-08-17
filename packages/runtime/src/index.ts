import type { ToolSpec } from "@tool-evolver/contracts";
import { type ProtocolMessage, createMessage } from "@tool-evolver/protocol";

// Bundle Specification, Schemas & Types
export * from "./bundle/spec.js";

// Bundle Construction & Encoding
export * from "./bundle/builder.js";

// Bundle Cryptographic Signatures & Key Store
export * from "./bundle/signature.js";

// Loader Security & Path Traversal Checks
export * from "./loader/security-checks.js";

// Content-Addressed Cache & Reference Tracking
export * from "./loader/cache.js";

// Quarantine Manager
export * from "./loader/quarantine.js";

// Cache Reconciliation
export * from "./loader/reconciliation.js";

// Retention & Garbage Collection
export * from "./loader/retention.js";

// Static Inspection API & CLI
export * from "./loader/inspector.js";

// Tool Bundle Loader
export * from "./loader/loader.js";

// Worker Protocol, SDK, Process & Runner
export * from "./worker/index.js";

// Capability Policy Engine, Grants, Canonicalizers & Inspection
export * from "./policy/index.js";

// Backward-compatible Runtime Engine Interface
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
