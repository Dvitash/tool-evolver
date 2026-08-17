import { describe, expect, it } from "vitest";
import type { ExecutedBrokerOperation } from "../../../src/evolution/replay/types.js";
import {
  DeterministicRandom,
  VirtualBrokerReconstructor,
  VirtualCmdBroker,
  VirtualFsBroker,
  VirtualNetBroker,
  VirtualSecretBroker,
  VirtualToolBrokerClient,
} from "../../../src/evolution/replay/virtual-broker.js";
import { createMockWorkflowEvents } from "./helpers.js";

describe("VirtualBroker Subsystem", () => {
  describe("DeterministicRandom PRNG", () => {
    it("generates deterministic random sequence given same seed", () => {
      const rng1 = new DeterministicRandom(42);
      const rng2 = new DeterministicRandom(42);

      const seq1 = [rng1.next(), rng1.next(), rng1.nextInt(1, 100), rng1.nextUuid()];
      const seq2 = [rng2.next(), rng2.next(), rng2.nextInt(1, 100), rng2.nextUuid()];

      expect(seq1).toEqual(seq2);
    });

    it("supports string seeds", () => {
      const rng1 = new DeterministicRandom("test-seed-xyz");
      const rng2 = new DeterministicRandom("test-seed-xyz");

      expect(rng1.next()).toBe(rng2.next());
      expect(rng1.nextInt(10, 50)).toBe(rng2.nextInt(10, 50));
    });

    it("generates valid UUID v4 format", () => {
      const rng = new DeterministicRandom(999);
      const uuid = rng.nextUuid();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe("VirtualFsBroker", () => {
    it("reads and writes files in virtual memory with path normalization", async () => {
      const trace: ExecutedBrokerOperation[] = [];
      const fs = new VirtualFsBroker(
        {
          files: {
            "workspace/sample.txt": "Hello Virtual World",
          },
        },
        trace,
      );

      const exists1 = await fs.exists("/workspace/sample.txt");
      expect(exists1).toBe(true);

      const content = await fs.readFile("/workspace/sample.txt", "utf-8");
      expect(content).toBe("Hello Virtual World");

      await fs.writeFile("/workspace/output.txt", "New Output");
      const exists2 = await fs.exists("/workspace/output.txt");
      expect(exists2).toBe(true);

      const modified = fs.getModifiedFiles();
      expect(modified["/workspace/output.txt"]).toBe("New Output");

      // Verify trace recording
      expect(trace.length).toBeGreaterThanOrEqual(3);
      expect(trace.some((t) => t.service === "fs" && t.operation === "readFile")).toBe(true);
      expect(trace.some((t) => t.service === "fs" && t.operation === "writeFile")).toBe(true);
    });

    it("throws simulated ENOENT and EACCES errors", async () => {
      const trace: ExecutedBrokerOperation[] = [];
      const fs = new VirtualFsBroker(
        {
          files: { "/workspace/secret.key": "key123" },
          simulateErrors: {
            "/workspace/missing.txt": "ENOENT",
            "/workspace/secret.key": "EACCES",
          },
        },
        trace,
      );

      await expect(fs.readFile("/workspace/missing.txt")).rejects.toThrow("ENOENT");
      await expect(fs.readFile("/workspace/secret.key")).rejects.toThrow("EACCES");
    });

    it("enforces read-only filesystem mode", async () => {
      const fs = new VirtualFsBroker({
        readOnly: true,
        files: { "/workspace/test.txt": "data" },
      });

      await expect(fs.writeFile("/workspace/new.txt", "fail")).rejects.toThrow("EROFS");
      await expect(fs.removeFile("/workspace/test.txt")).rejects.toThrow("EROFS");
    });

    it("supports listDir and stat", async () => {
      const fs = new VirtualFsBroker({
        files: {
          "/workspace/src/a.ts": "export const a = 1;",
          "/workspace/src/b.ts": "export const b = 2;",
          "/workspace/docs/readme.md": "# Docs",
        },
      });

      const list = await fs.listDir("/workspace/src");
      expect(list).toContain("a.ts");
      expect(list).toContain("b.ts");

      const stat = await fs.stat("/workspace/src/a.ts");
      expect(stat.isFile).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
    });
  });

  describe("VirtualNetBroker", () => {
    it("intercepts fetch requests and returns configured mock responses", async () => {
      const trace: ExecutedBrokerOperation[] = [];
      const net = new VirtualNetBroker(
        {
          routes: {
            "https://api.example.com/data": {
              status: 200,
              body: { items: [1, 2, 3] },
            },
          },
        },
        trace,
      );

      const res = await net.fetch("https://api.example.com/data");
      expect(res.status).toBe(200);
      expect(res.ok).toBe(true);

      const json = await res.json<{ items: number[] }>();
      expect(json.items).toEqual([1, 2, 3]);

      const requests = net.getNetworkRequests();
      expect(requests.length).toBe(1);
      expect(requests[0]!.url).toBe("https://api.example.com/data");
    });

    it("simulates network timeouts and connection errors", async () => {
      const netTimeout = new VirtualNetBroker({ simulateTimeout: true });
      await expect(netTimeout.fetch("https://api.example.com")).rejects.toThrow("ETIMEDOUT");

      const netRefused = new VirtualNetBroker({ simulateNetworkError: true });
      await expect(netRefused.fetch("https://api.example.com")).rejects.toThrow("ECONNREFUSED");
    });
  });

  describe("VirtualCmdBroker", () => {
    it("executes simulated commands and records command trace", async () => {
      const trace: ExecutedBrokerOperation[] = [];
      const cmd = new VirtualCmdBroker(
        {
          commands: {
            "npm test": {
              stdout: "PASS all tests (42)",
              stderr: "",
              exitCode: 0,
            },
          },
        },
        trace,
      );

      const res = await cmd.exec("npm", ["test"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("PASS all tests");

      expect(cmd.getExecutedCommands()).toContain("npm test");
    });

    it("simulates command execution failure", async () => {
      const cmd = new VirtualCmdBroker({ simulateFailure: true });
      const res = await cmd.exec("git", ["status"]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("failed");
    });
  });

  describe("VirtualSecretBroker", () => {
    it("creates opaque secret references without exposing raw secret bytes", () => {
      const secret = new VirtualSecretBroker();

      const ref = secret.createReference("API_KEY");
      expect(ref.kind).toBe("secret_reference");
      expect(ref.name).toBe("API_KEY");
      expect("secret" in ref).toBe(false);
      expect("value" in ref).toBe(false);

      const bearer = secret.bearerToken("API_KEY");
      expect(bearer.kind).toBe("secret_reference");
      expect(bearer.permittedModes).toContain("bearer_token");

      const templ = secret.template("API_KEY");
      expect(templ).toContain("API_KEY");
    });

    it("rejects direct secret read requests via virtual client dispatch", async () => {
      const client = new VirtualToolBrokerClient();
      await expect(client.request("secret", "getSecret", { name: "API_KEY" })).rejects.toThrow(
        "Direct secret read or administrative secret operation",
      );
    });
  });

  describe("VirtualToolBrokerClient & Reconstructor", () => {
    it("unifies all broker clients with shared trace recording", async () => {
      const client = new VirtualToolBrokerClient({
        fs: { files: { "/workspace/a.txt": "content" } },
        net: { routes: { "http://localhost/ping": { status: 200, body: "pong" } } },
      });

      await client.request("fs", "readFile", { path: "/workspace/a.txt" });
      await client.request("net", "fetch", { url: "http://localhost/ping" });

      expect(client.trace.length).toBe(2);
      expect(client.trace[0]!.service).toBe("fs");
      expect(client.trace[1]!.service).toBe("net");
    });

    it("reconstructs virtual broker state from normalized events", () => {
      const events = createMockWorkflowEvents();
      const state = VirtualBrokerReconstructor.buildFromEvents(events);

      expect(state.fs?.files).toBeDefined();
      expect(state.fs?.files?.["/workspace/src/index.ts"]).toBeDefined();
    });
  });
});
