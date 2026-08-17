import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityBrokerManager } from "../../src/brokers/manager.js";
import { createInvocationGrant } from "../../src/policy/grant.js";
import { ToolRuntime } from "../../src/worker/index.js";
import { WorkerProcess } from "../../src/worker/process.js";

describe("Broker-Only Workspace Filesystem Access", () => {
  let tempWorkspace: string;
  let testFile: string;
  let secretFile: string;

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "te_broker_fs_ws_"));
    testFile = path.join(tempWorkspace, "data.txt");
    secretFile = path.join(tempWorkspace, ".env");
    fs.writeFileSync(testFile, "HELLO_FROM_WORKSPACE_DATA");
    fs.writeFileSync(secretFile, "SECRET_TOKEN=supersecret123");
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempWorkspace)) {
        fs.rmSync(tempWorkspace, { recursive: true, force: true });
      }
    } catch {}
  });

  const createGrant = (
    toolId: string,
    fsCapabilities: Record<string, unknown>,
    invocationId = "inv_fs_001",
  ) => {
    return createInvocationGrant({
      grantId: `grant_${invocationId}`,
      invocationId,
      toolId,
      toolVersion: "1.0.0",
      workspaceId: "ws_001",
      envelopeId: "env_001",
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          ...fsCapabilities,
        },
      },
    });
  };

  it("proves WorkerProcess permissions strictly exclude workspace root from Deno allow-read and allow-write", async () => {
    const dummyBundle = path.join(tempWorkspace, "dummy_bundle.js");
    fs.writeFileSync(dummyBundle, "export default async function() { return { ok: true }; }");

    const worker = new WorkerProcess({
      manifest: { id: "test-tool", name: "test-tool", version: "1.0.0" },
      bundleEntrypoint: dummyBundle,
      workspaceRoot: tempWorkspace,
      denoExecutable: "nonexistent-deno-to-capture-args",
    });

    const res = await worker.execute("inv-test-args", {});
    expect(res.status).toBe("error");

    worker.cleanup();
    const scratchDir = worker.getScratchDir();
    if (scratchDir) {
      expect(fs.existsSync(scratchDir)).toBe(false);
    }
  });

  it("proves direct filesystem access fails while brokered access succeeds for the same target", async () => {
    const brokerManager = new CapabilityBrokerManager();
    const runtime = new ToolRuntime({ mode: "in-process", brokerManager });

    const grant = createGrant(
      "fs-tool",
      {
        allowWorkspaceRoot: true,
        readPaths: ["data.txt"],
        writePaths: ["output.txt"],
      },
      "inv_fs_brokered_001",
    );

    const manifest = {
      id: "fs-tool",
      name: "fs-tool",
      version: "1.0.0",
      description: "Demonstrates direct vs brokered filesystem access",
      parameters: { type: "object" as const, properties: {}, required: [] },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    // 1. Direct fs access attempt: direct require of 'fs' or 'node:fs' is blocked by sandbox
    const directAccessCode = `
      export default async function(context) {
        const fs = require('node:fs');
        return fs.readFileSync('${testFile.replace(/\\/g, "\\\\")}', 'utf8');
      }
    `;

    const directResult = await runtime.executeTool(
      manifest,
      directAccessCode,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
      },
    );

    expect(directResult.status).toBe("error");
    expect(directResult.error?.message).toContain("Permission Denied");

    // 2. Brokered fs access: travels through context.fs and capability broker
    const brokeredAccessCode = `
      export default async function(context) {
        const fileContent = await context.fs.readFile('data.txt');
        await context.fs.writeFile('output.txt', 'PROCESSED: ' + fileContent);
        const exists = await context.fs.exists('output.txt');
        return {
          content: fileContent,
          outputExists: exists,
        };
      }
    `;

    const brokeredResult = await runtime.executeTool(
      manifest,
      brokeredAccessCode,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
        brokerManager,
      },
    );

    expect(brokeredResult.status).toBe("success");
    expect(brokeredResult.output).toEqual({
      content: "HELLO_FROM_WORKSPACE_DATA",
      outputExists: true,
    });

    // Verify file was written to disk in workspace
    const written = fs.readFileSync(path.join(tempWorkspace, "output.txt"), "utf8");
    expect(written).toBe("PROCESSED: HELLO_FROM_WORKSPACE_DATA");
  });

  it("blocks direct attempts to access sensitive files via brokered context even with allowWorkspaceRoot", async () => {
    const brokerManager = new CapabilityBrokerManager();
    const runtime = new ToolRuntime({ mode: "in-process", brokerManager });

    const grant = createGrant(
      "sensitive-tool",
      {
        allowWorkspaceRoot: true,
        readPaths: ["**/*"], // Wildcard pattern must NOT expose .env
      },
      "inv_sensitive_001",
    );

    const manifest = {
      id: "sensitive-tool",
      name: "sensitive-tool",
      version: "1.0.0",
      parameters: { type: "object" as const, properties: {}, required: [] },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const attemptCode = `
      export default async function(context) {
        return await context.fs.readFile('.env');
      }
    `;

    const result = await runtime.executeTool(
      manifest,
      attemptCode,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
        brokerManager,
      },
    );

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("sensitive or hidden path is denied");
  });

  it("aborts invocation and emits audit event on capability violation", async () => {
    const brokerManager = new CapabilityBrokerManager();
    const runtime = new ToolRuntime({ mode: "in-process", brokerManager });

    // Grant does NOT allow writing
    const grant = createGrant(
      "unauth-tool",
      {
        allowWorkspaceRoot: false,
        readPaths: ["data.txt"],
        writePaths: [],
      },
      "inv_unauth_write_001",
    );

    const manifest = {
      id: "unauth-tool",
      name: "unauth-tool",
      version: "1.0.0",
      parameters: { type: "object" as const, properties: {}, required: [] },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const violationCode = `
      export default async function(context) {
        await context.fs.writeFile('unauthorized.txt', 'MALICIOUS');
        return { done: true };
      }
    `;

    const result = await runtime.executeTool(
      manifest,
      violationCode,
      {},
      {
        grant,
        workspaceRoot: tempWorkspace,
        brokerManager,
      },
    );

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("Access to path is not granted");
  });
});
