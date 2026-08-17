import { gzipSync } from "node:zlib";
import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import type { ObservationBatchRequest, ObservationBatchResponse } from "@tool-evolver/protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { MemoryDatabasePool, OutboxRepository, runMigrations } from "../../src/db/index.js";
import { MemoryDurableQueue } from "../../src/queue/index.js";
import { CloudServer, createCloudServer } from "../../src/server/index.js";
import { MemoryObjectStore } from "../../src/storage/index.js";

describe("Observation Ingestion HTTP API (POST /v1/observations/batch)", () => {
  async function setupTestServer() {
    const config = loadConfig({
      server: {
        port: 0,
        host: "127.0.0.1",
        logLevel: "info",
        bodyLimitBytes: 10485760,
        requestTimeoutMs: 5000,
        corsOrigins: ["*"],
      },
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
      dbPool,
      stop: async () => {
        await server.stop();
        await dbPool.end();
      },
    };
  }

  const sampleEvent: NormalizedSessionEvent = {
    eventId: "evt-http-1",
    schemaVersion: "1.0.0",
    sessionId: "sess-http-1",
    timestamp: "2026-08-17T12:00:00.000Z",
    causalRef: { causalSequence: 0 },
    redaction: {
      isRedacted: true,
      redactedFields: [],
      redactionStrategy: "none",
      scrubbedPatterns: [],
    },
    type: "message",
    role: "user",
    content: "Create migration table",
  };

  const sampleEvent2: NormalizedSessionEvent = {
    eventId: "evt-http-2",
    schemaVersion: "1.0.0",
    sessionId: "sess-http-1",
    timestamp: "2026-08-17T12:00:01.000Z",
    causalRef: { causalSequence: 1, parentId: "evt-http-1" },
    redaction: {
      isRedacted: true,
      redactedFields: [],
      redactionStrategy: "none",
      scrubbedPatterns: [],
    },
    type: "message",
    role: "assistant",
    content: "Created migration table successfully",
  };

  const validBatch: ObservationBatchRequest = {
    batchId: "batch-http-100",
    workspaceId: "ws-http-1",
    deviceId: "dev-http-1",
    installationId: "inst-http-1",
    cursor: "seq-10",
    compressed: false,
    compression: "none",
    observations: [sampleEvent, sampleEvent2],
  };

  const authHeaders = {
    "x-account-id": "acc-http-1",
    "x-workspace-id": "ws-http-1",
    "x-device-id": "dev-http-1",
    "x-installation-id": "inst-http-1",
    "Content-Type": "application/json",
  };

  it("should successfully ingest valid observation batch via HTTP POST", async () => {
    const { baseUrl, dbPool, stop } = await setupTestServer();
    try {
      const res = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validBatch),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as ObservationBatchResponse;
      expect(body.status).toBe("accepted");
      expect(body.acceptedCount).toBe(2);
      expect(body.batchId).toBe("batch-http-100");
      expect(body.cursorAck).toBe("seq-10");

      // Verify DB receipt
      const receipts = await dbPool.query("SELECT * FROM ingestion_receipts WHERE batch_id = $1", [
        "batch-http-100",
      ]);
      expect(receipts.rows.length).toBe(1);

      // Verify transactional outbox job
      const outbox = await OutboxRepository.fetchPending(dbPool);
      expect(outbox.length).toBe(1);
      expect(outbox[0].eventType).toBe("store-observation-batch");
    } finally {
      await stop();
    }
  });

  it("should support gzip compressed batch body via Content-Encoding: gzip", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      const jsonBuffer = Buffer.from(
        JSON.stringify({
          ...validBatch,
          batchId: "batch-gzip-1",
        }),
        "utf8",
      );
      const compressed = gzipSync(jsonBuffer);

      const res = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Encoding": "gzip",
          "Content-Type": "application/json",
        },
        body: compressed,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as ObservationBatchResponse;
      expect(body.status).toBe("accepted");
      expect(body.batchId).toBe("batch-gzip-1");
    } finally {
      await stop();
    }
  });

  it("should return idempotent 200 response on exact duplicate retry", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      // First POST
      const res1 = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validBatch),
      });
      expect(res1.status).toBe(200);

      // Second identical POST
      const res2 = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validBatch),
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as ObservationBatchResponse;
      expect(body2.status).toBe("accepted");
      expect(body2.batchId).toBe("batch-http-100");
    } finally {
      await stop();
    }
  });

  it("should return 409 Conflict when submitting altered batch with same batchId", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      // First POST
      await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validBatch),
      });

      // Conflicting POST (same batchId, altered event)
      const alteredBatch = {
        ...validBatch,
        observations: [
          sampleEvent,
          {
            ...sampleEvent2,
            eventId: "evt-altered",
            timestamp: "2026-08-17T12:05:00.000Z",
          },
        ],
      };

      const conflictRes = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(alteredBatch),
      });

      expect(conflictRes.status).toBe(409);
      const conflictBody = (await conflictRes.json()) as { error: string };
      expect(conflictBody.error).toBe("BATCH_CONFLICT");
    } finally {
      await stop();
    }
  });

  it("should reject unauthenticated request with 401 Unauthorized", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      const res = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBatch),
      });

      expect(res.status).toBe(401);
    } finally {
      await stop();
    }
  });

  it("should reject cross-tenant spoofing with 403 Forbidden", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      const spoofedBatch = {
        ...validBatch,
        workspaceId: "ws-victim-tenant",
      };

      const res = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: authHeaders, // auth is ws-http-1
        body: JSON.stringify(spoofedBatch),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("TENANT_MISMATCH");
    } finally {
      await stop();
    }
  });

  it("should return 400 Bad Request for malformed request or schema errors", async () => {
    const { baseUrl, stop } = await setupTestServer();
    try {
      const res = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ batchId: "invalid-batch" }), // missing observations
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("VALIDATION_ERROR");
    } finally {
      await stop();
    }
  });
});
