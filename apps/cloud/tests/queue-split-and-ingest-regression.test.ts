import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import type { ObservationBatchRequest, ObservationBatchResponse } from "@tool-evolver/protocol";
import { describe, expect, it } from "vitest";
import { createCloudService } from "../src/index.js";

describe("Regression #107 & #108: Queue Split & Ingest Store Chain", () => {
  it("executes jobs submitted via HTTP POST /v1/jobs on the shared worker queue (#107)", async () => {
    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
        auth: { mode: "development" },
      },
    });

    const port = await cloud.start(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const { promise: handlerExecutedPromise, resolve: resolveHandler } =
        Promise.withResolvers<void>();

      cloud.worker.registerHandler("opportunity.detect", async () => {
        resolveHandler();
      });

      const res = await fetch(`${baseUrl}/v1/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-account-id": "acc-reg-1",
          "x-workspace-id": "ws-reg-1",
        },
        body: JSON.stringify({
          jobType: "opportunity.detect",
          payload: { sessionIds: ["sess-reg-1"] },
        }),
      });

      expect(res.status).toBe(202);
      const json = (await res.json()) as { jobId: string };
      expect(json.jobId).toBeDefined();

      // Await worker runtime processing the job from the shared queue
      await handlerExecutedPromise;
      const stats = await cloud.queue.getQueueStats();
      expect(stats.pendingCount).toBe(0);
    } finally {
      await cloud.stop();
    }
  });

  it("persists observation batches end-to-end and avoids observation-available DLQ (#108)", async () => {
    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
        auth: { mode: "development" },
      },
    });

    const port = await cloud.start(0);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const { promise: obsAvailablePromise, resolve: resolveObsAvailable } =
        Promise.withResolvers<void>();

      cloud.worker.registerHandler("observation-available", async () => {
        resolveObsAvailable();
      });

      const timestamp = new Date().toISOString();
      const sampleEvent: NormalizedSessionEvent = {
        eventId: "evt-reg-1",
        schemaVersion: "1.0.0",
        sessionId: "sess-reg-1",
        timestamp,
        causalRef: { causalSequence: 0 },
        redaction: {
          isRedacted: true,
          redactedFields: [],
          redactionStrategy: "none",
          scrubbedPatterns: [],
        },
        type: "message",
        role: "user",
        content: "Run test suite",
      };

      const validBatch: ObservationBatchRequest = {
        batchId: "batch-reg-1",
        workspaceId: "ws-reg-1",
        deviceId: "dev-reg-1",
        installationId: "inst-reg-1",
        cursor: "seq-1",
        compressed: false,
        compression: "none",
        observations: [sampleEvent],
      };

      const res = await fetch(`${baseUrl}/v1/observations/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-account-id": "acc-reg-1",
          "x-workspace-id": "ws-reg-1",
          "x-device-id": "dev-reg-1",
          "x-installation-id": "inst-reg-1",
        },
        body: JSON.stringify(validBatch),
      });

      expect(res.status).toBe(200);
      const ack = (await res.json()) as ObservationBatchResponse;
      expect(ack.status).toBe("accepted");
      expect(ack.acceptedCount).toBe(1);

      // Wait for observation-available event to be processed by worker
      await obsAvailablePromise;

      // Verify observation repo query
      const queryRes = await cloud.observationRepo.queryEvents({
        accountId: "acc-reg-1",
        workspaceId: "ws-reg-1",
        sessionId: "sess-reg-1",
      });
      expect(queryRes.events.length).toBe(1);
      expect(queryRes.events[0].id).toBe("evt-reg-1");

      // Verify sessions repo
      const session = await cloud.sessionRepo.getSessionById(
        { accountId: "acc-reg-1", workspaceId: "ws-reg-1" },
        "sess-reg-1",
      );
      expect(session).toBeDefined();
      expect(session?.id).toBe("sess-reg-1");

      // Verify get_evolution_status through the real MCP/HTTP path (catalog-registered tool)
      const statusRes = await fetch(`${baseUrl}/v1/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-account-id": "acc-reg-1",
          "x-workspace-id": "ws-reg-1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_evolution_status", arguments: { timeframe: "all" } },
        }),
      });
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as {
        result: { isError?: boolean; structuredData: unknown };
      };
      const statusResult = statusJson.result;
      expect(statusResult.isError).toBe(false);
      const report = statusResult.structuredData as {
        observations: { totalEvents: number; totalSessions: number };
      };
      expect(report.observations.totalEvents).toBeGreaterThan(0);
      expect(report.observations.totalSessions).toBeGreaterThan(0);

      // Verify no dead letter queue growth
      const stats = await cloud.queue.getQueueStats();
      expect(stats.deadLetterCount).toBe(0);
    } finally {
      await cloud.stop();
    }
  });
});
