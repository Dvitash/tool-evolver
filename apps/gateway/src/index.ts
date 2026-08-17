/**
 * @tool-evolver/gateway
 *
 * Local Model Context Protocol (MCP) Gateway and Connection Lifecycle Service.
 */

// Protocol Types, Errors & Framing
export * from "./protocol/index.js";

// Gateway Router & Mock Router
export * from "./router.js";

// Workspace Context & Symlink-Aware Resolution
export * from "./workspace-resolver.js";

// Connection State, Rate Limiting & Lifecycle
export * from "./connection.js";

// Local MCP Gateway Server
export * from "./gateway.js";

// Stdio Shim & Bridge
export * from "./shim/index.js";

// Backward Compatibility Helpers
export interface GatewayService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGateway(): GatewayService {
  let isRunning = false;
  return {
    async start() {
      isRunning = true;
    },
    async stop() {
      isRunning = false;
    },
  };
}
