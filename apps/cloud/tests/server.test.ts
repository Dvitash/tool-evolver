import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MemoryDatabasePool, runMigrations } from "../src/db/index.js";
import { MemoryDurableQueue } from "../src/queue/index.js";
import { CloudServer, createCloudServer } from "../src/server/index.js";
import { MemoryObjectStore } from "../src/storage/index.js";

describe("Cloud API Server", () => {
  async function setupTestServer(): Promise<{ server: CloudServer; baseUrl: string; stop: () => Promise<void> }> {
    const config = loadConfig({
      server: { port: 0, host: "127.0.0.1", logLevel: "info", bodyLimitBytes: 1048576, requestTimeoutMs: 5000, corsOrigins: ["*"] },
    });

    const dbPool = new MemoryDatabasePool();
    await runMigrations(dbPool);
    const objectStore = new MemoryObjectStore();
    const queue = new MemoryDurableQueue();

    const server = createCloudServer({
      config,
      dbPool,
      objectStore,
      queue,
    });

    const port = await server.start(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
      server,
      baseUrl,
      stop: async () => {
        await server.stop();
        await dbPool.end();
      },
    };
  }

  it("should respond to /health/live with ok status", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      const res = await fetch(`${baseUrl}/health/live`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { status: string; timestamp: number; uptime: number };
      expect(body.status).toBe("ok");
      expect(typeof body.timestamp).toBe("number");
      expect(typeof body.uptime).toBe("number");
    } finally {
      await stop();
    }
  });

  it("should respond to /health/ready with readiness status", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { status: string; checks: { database: boolean; storage: boolean; queue: boolean } };
      expect(body.status).toBe("ok");
      expect(body.checks.database).toBe(true);
      expect(body.checks.storage).toBe(true);
      expect(body.checks.queue).toBe(true);
    } finally {
      await stop();
    }
  });

  it("should enforce tenant authentication on protected /v1/* endpoints", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      // Unauthenticated request to /v1/devices
      const unauthRes = await fetch(`${baseUrl}/v1/devices`);
      expect(unauthRes.status).toBe(401);
      const unauthBody = (await unauthRes.json()) as { error: string };
      expect(unauthBody.error).toBe("UNAUTHORIZED");

      // Authenticated request with tenant headers
      const authRes = await fetch(`${baseUrl}/v1/devices`, {
        headers: {
          "x-account-id": "acc-100",
          "x-workspace-id": "ws-200",
        },
      });
      expect(authRes.status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("should propagate trace and request IDs in response headers", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      const customTraceId = "trace-custom-uuid-1234";
      const customReqId = "req-custom-uuid-5678";

      const res = await fetch(`${baseUrl}/health/live`, {
        headers: {
          "x-trace-id": customTraceId,
          "x-request-id": customReqId,
        },
      });

      expect(res.headers.get("x-trace-id")).toBe(customTraceId);
      expect(res.headers.get("x-request-id")).toBe(customReqId);
    } finally {
      await stop();
    }
  });

  it("should handle accounts, workspaces, and devices CRUD", async () => {
    const { baseUrl, stop } = await setupTestServer();
    const headers = {
      "Content-Type": "application/json",
      "x-account-id": "acc-acme",
      "x-workspace-id": "ws-main",
    };

    try {
      // 1. Create account
      const createAccRes = await fetch(`${baseUrl}/v1/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "acc-acme", name: "Acme Corp", plan: "pro" }),
      });
      expect(createAccRes.status).toBe(201);

      // 2. Create workspace
      const createWsRes = await fetch(`${baseUrl}/v1/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "ws-main", name: "Main Workspace", slug: "main" }),
      });
      expect(createWsRes.status).toBe(201);

      // 3. Register device
      const createDevRes = await fetch(`${baseUrl}/v1/devices`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "dev-mac", name: "MacBook Pro", platform: "darwin-arm64" }),
      });
      expect(createDevRes.status).toBe(201);

      // 4. List devices
      const listDevRes = await fetch(`${baseUrl}/v1/devices`, { headers });
      expect(listDevRes.status).toBe(200);
      const listDevBody = (await listDevRes.json()) as { devices: Array<{ id: string; name: string }> };
      expect(listDevBody.devices.length).toBe(1);
      expect(listDevBody.devices[0].id).toBe("dev-mac");
    } finally {
      await stop();
    }
  });

  it("should support job enqueueing and queue stats via /v1/jobs", async () => {
    const { baseUrl, stop } = await setupTestServer();
    const headers = {
      "Content-Type": "application/json",
      "x-account-id": "acc-jobs",
      "x-workspace-id": "ws-jobs",
    };

    try {
      const enqueueRes = await fetch(`${baseUrl}/v1/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jobType: "evolution.evaluate",
          payload: { candidateId: "cand-99" },
        }),
      });

      expect(enqueueRes.status).toBe(202);
      const enqueueBody = (await enqueueRes.json()) as { jobId: string; status: string };
      expect(enqueueBody.status).toBe("enqueued");
      expect(enqueueBody.jobId).toBeDefined();

      const statsRes = await fetch(`${baseUrl}/v1/jobs`, { headers });
      expect(statsRes.status).toBe(200);
      const statsBody = (await statsRes.json()) as { stats: { pendingCount: number } };
      expect(statsBody.stats.pendingCount).toBe(1);
    } finally {
      await stop();
    }
  });

  it("should support object upload and download via /v1/objects", async () => {
    const { baseUrl, stop } = await setupTestServer();
    const headers = {
      "x-account-id": "acc-storage",
      "x-workspace-id": "ws-storage",
    };

    try {
      const content = "Blob data content 12345";

      // Upload object
      const uploadRes = await fetch(`${baseUrl}/v1/objects/my-file.txt`, {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "text/plain",
        },
        body: content,
      });
      expect(uploadRes.status).toBe(201);

      // Download object
      const downloadRes = await fetch(`${baseUrl}/v1/objects/my-file.txt`, {
        headers,
      });
      expect(downloadRes.status).toBe(200);
      const downloadedText = await downloadRes.text();
      expect(downloadedText).toBe(content);
    } finally {
      await stop();
    }
  });
});
