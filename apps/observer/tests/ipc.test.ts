import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonConfigSchema } from "../src/config.js";
import { IpcClient } from "../src/ipc/client.js";
import { FrameDecoder, MAX_FRAME_SIZE, encodeFrame } from "../src/ipc/framing.js";
import { IPC_ERROR_CODES, type IpcRequest, type IpcResponse } from "../src/ipc/protocol.js";
import { IpcServer } from "../src/ipc/server.js";
import { createInMemoryIpcPair } from "../src/ipc/transport.js";
import type { DaemonModule, ModuleContext, ModuleLifecycleState } from "../src/lifecycle.js";
import { DaemonSupervisor } from "../src/supervisor.js";

function createDummyModule(id: string): DaemonModule {
  let state: ModuleLifecycleState = "uninitialized";
  return {
    id,
    name: `Dummy ${id}`,
    getState: () => state,
    start: async () => {
      state = "ready";
    },
    stop: async () => {
      state = "stopped";
    },
    getDiagnostics: async () => ({ status: "ok" }),
  };
}

describe("ipc", () => {
  describe("Framing and Stream Decoder", () => {
    it("encodes and decodes a single frame", () => {
      const message = { id: "123", method: "ping", params: { nonce: "abc" } };
      const frame = encodeFrame(message);
      expect(frame.length).toBeGreaterThan(4);

      const decoder = new FrameDecoder();
      const decoded = decoder.push(frame);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toEqual(message);
    });

    it("decodes multiple frames received in a single chunk", () => {
      const msg1 = { id: "1", method: "ping" };
      const msg2 = { id: "2", method: "getHealth" };

      const frame1 = encodeFrame(msg1);
      const frame2 = encodeFrame(msg2);
      const combined = Buffer.concat([frame1, frame2]);

      const decoder = new FrameDecoder();
      const decoded = decoder.push(combined);
      expect(decoded).toHaveLength(2);
      expect(decoded[0]).toEqual(msg1);
      expect(decoded[1]).toEqual(msg2);
    });

    it("decodes a frame fragmented across multiple chunks", () => {
      const message = { id: "frag-1", method: "getDiagnostics", data: "large-string-".repeat(100) };
      const frame = encodeFrame(message);

      const splitIndex = Math.floor(frame.length / 2);
      const chunk1 = frame.subarray(0, splitIndex);
      const chunk2 = frame.subarray(splitIndex);

      const decoder = new FrameDecoder();
      const decoded1 = decoder.push(chunk1);
      expect(decoded1).toHaveLength(0); // Incomplete

      const decoded2 = decoder.push(chunk2);
      expect(decoded2).toHaveLength(1);
      expect(decoded2[0]).toEqual(message);
    });

    it("rejects payloads exceeding maximum allowable frame size", () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(MAX_FRAME_SIZE + 100, 0);

      const decoder = new FrameDecoder();
      expect(() => decoder.push(header)).toThrow(/exceeds limit/);
    });
  });

  describe("In-Memory Transport RPC Operations", () => {
    async function setupInMemoryIpc(token = "test-token") {
      const config = DaemonConfigSchema.parse({ logLevel: "silent", authToken: token });
      const mod = createDummyModule("core");
      const supervisor = new DaemonSupervisor({ config, modules: [mod] });
      await supervisor.start();

      const server = new IpcServer({ supervisor, authToken: token });
      await server.start();

      const { serverTransport, clientTransport } = createInMemoryIpcPair();
      server.attachTransport(serverTransport);

      const client = new IpcClient({
        transport: clientTransport,
        authToken: token,
      });

      return { supervisor, server, client };
    }

    it("executes ping RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const res = await client.ping("test-nonce");
      expect(res.pong).toBe(true);
      expect(res.nonce).toBe("test-nonce");
      expect(res.timestamp).toBeGreaterThan(0);

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes getHealth RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const health = await client.getHealth();
      expect(health.status).toBe("fully-ready");
      expect(health.modules.core.status).toBe("ready");

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes getModuleStatus RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const statusList = await client.getModuleStatus();
      expect(statusList).toHaveLength(1);
      expect(statusList[0].id).toBe("core");
      expect(statusList[0].state).toBe("ready");

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes reloadConfig RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const reloadRes = await client.reloadConfig({ port: 9876 });
      expect(reloadRes.success).toBe(true);
      expect(supervisor.getConfig().port).toBe(9876);

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes getDiagnostics RPC method with secret redaction", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const diag = await client.getDiagnostics();
      expect(diag.config.authToken).toBe("[REDACTED]");
      expect(diag.modules.core).toEqual({ status: "ok" });

      await client.close();
      await server.stop();
      await supervisor.stop();
    });

    it("executes gracefulShutdown RPC method", async () => {
      const { supervisor, server, client } = await setupInMemoryIpc();

      const res = await client.gracefulShutdown({ reason: "test shutdown" });
      expect(res.accepted).toBe(true);

      // Wait a microtask cycle for shutdown to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(supervisor.currentState).toBe("stopped");

      await client.close();
      await server.stop();
    });
  });

  describe("Authentication", () => {
    it("rejects unauthorized client with incorrect auth token", async () => {
      const config = DaemonConfigSchema.parse({ logLevel: "silent", authToken: "correct-token" });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({ supervisor, authToken: "correct-token" });
      await server.start();

      const { serverTransport, clientTransport } = createInMemoryIpcPair();
      server.attachTransport(serverTransport);

      const unauthorizedClient = new IpcClient({
        transport: clientTransport,
        authToken: "wrong-token",
      });

      await expect(unauthorizedClient.ping()).rejects.toThrow(/Unauthorized/);

      await unauthorizedClient.close();
      await server.stop();
      await supervisor.stop();
    });
  });

  describe("Unix Domain Socket Transport", () => {
    it("communicates successfully over a real Unix domain socket file", async () => {
      const tempDir = path.join(os.tmpdir(), `te-ipc-uds-${Date.now()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });
      const socketPath = path.join(tempDir, "daemon.sock");
      const token = "uds-secret-token";

      const config = DaemonConfigSchema.parse({
        logLevel: "silent",
        authToken: token,
        socketPath,
      });
      const supervisor = new DaemonSupervisor({ config });
      await supervisor.start();

      const server = new IpcServer({
        supervisor,
        socketPath,
        authToken: token,
      });
      await server.start();

      const client = new IpcClient({
        socketPath,
        authToken: token,
      });

      await client.connect();
      expect(client.connected).toBe(true);

      const pingResult = await client.ping("uds-test-nonce");
      expect(pingResult.pong).toBe(true);
      expect(pingResult.nonce).toBe("uds-test-nonce");

      const health = await client.getHealth();
      expect(health.status).toBe("fully-ready");

      await client.close();
      await server.stop();
      await supervisor.stop();

      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });
  });
});
