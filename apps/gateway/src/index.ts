import { DefaultRuntimeEngine } from "@tool-evolver/runtime";

export interface GatewayService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGateway(): GatewayService {
  const runtime = new DefaultRuntimeEngine();
  return {
    async start() {
      if (!runtime.isReady()) {
        throw new Error("Runtime is not ready");
      }
    },
    async stop() {},
  };
}
