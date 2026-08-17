/**
 * @tool-evolver/cloud - Platform Tools & Fixtures Tests
 */

import { describe, expect, it } from "vitest";
import { MemoryDatabasePool } from "../../src/db/index.js";
import {
  createGetEvolutionStatusTool,
  createGetToolLineageTool,
  echoFixtureTool,
  statusFixtureTool,
  testFailureFixtureTool,
} from "../../src/mcp/tools/index.js";
import type { CloudMcpInvocationContext } from "../../src/mcp/types.js";

describe("Cloud MCP - Platform Tools & Dev Fixtures", () => {
  const context: CloudMcpInvocationContext = {
    tenant: {
      accountId: "acc-tools-1",
      workspaceId: "ws-tools-1",
    },
    sessionId: "sess-123",
    traceId: "trace-456",
  };

  describe("get_evolution_status", () => {
    it("returns structured health status with default parameters", async () => {
      const tool = createGetEvolutionStatusTool();
      const result = await tool.handler({}, context);

      expect(result.isError).toBe(false);
      expect(result.structuredData).toBeDefined();

      const report = result.structuredData as {
        workspaceId: string;
        status: string;
        timeframe: string;
        observations: { totalEvents: number; ingestionHealth: string };
        candidates: { detected: number; approved: number };
        evaluation: { averageScore: number };
        deployments: { activeToolsCount: number };
      };

      expect(report.workspaceId).toBe("ws-tools-1");
      expect(report.timeframe).toBe("24h");
      expect(report.observations).toBeDefined();
      expect(report.candidates).toBeDefined();
      expect(report.evaluation.averageScore).toBeGreaterThan(0);
    });

    it("accepts custom timeframe and toolId filter", async () => {
      const tool = createGetEvolutionStatusTool();
      const result = await tool.handler({ timeframe: "7d", toolId: "code_analyzer" }, context);

      expect(result.isError).toBe(false);
      const report = result.structuredData as {
        timeframe: string;
        summary: string;
      };
      expect(report.timeframe).toBe("7d");
      expect(report.summary).toContain("code_analyzer");
    });

    it("aggregates data from database when available", async () => {
      const dbPool = new MemoryDatabasePool();
      // Insert mock observations
      await dbPool.query(
        "CREATE TABLE IF NOT EXISTS observations (id VARCHAR(64), workspace_id VARCHAR(64), raw_payload JSONB)",
      );
      await dbPool.query(
        "INSERT INTO observations (id, workspace_id, raw_payload) VALUES ($1, $2, $3)",
        ["obs-1", context.tenant.workspaceId, JSON.stringify({ isError: false })],
      );
      await dbPool.query(
        "INSERT INTO observations (id, workspace_id, raw_payload) VALUES ($1, $2, $3)",
        ["obs-2", context.tenant.workspaceId, JSON.stringify({ isError: true })],
      );

      const tool = createGetEvolutionStatusTool({ dbPool });
      const result = await tool.handler({}, context);

      expect(result.isError).toBe(false);
      const report = result.structuredData as {
        observations: { totalEvents: number; errorEvents: number };
      };
      expect(report.observations.totalEvents).toBe(2);
      expect(report.observations.errorEvents).toBe(1);
    });
  });

  describe("get_tool_lineage", () => {
    it("returns version history, evaluation decisions, and rollback targets", async () => {
      const dbPool = new MemoryDatabasePool();
      await dbPool.query(
        "CREATE TABLE IF NOT EXISTS tools (id VARCHAR(64), workspace_id VARCHAR(64), name VARCHAR(255), description TEXT, active_version VARCHAR(64))",
      );
      await dbPool.query(
        "CREATE TABLE IF NOT EXISTS tool_versions (tool_id VARCHAR(64), workspace_id VARCHAR(64), version VARCHAR(64), manifest_digest VARCHAR(64), artifact_digest VARCHAR(64), status VARCHAR(32), created_at TIMESTAMPTZ)",
      );

      await dbPool.query(
        "INSERT INTO tools (id, workspace_id, name, description, active_version) VALUES ($1, $2, $3, $4, $5)",
        ["linter", context.tenant.workspaceId, "Smart Linter", "AI-assisted code linter", "2.0.0"],
      );

      await dbPool.query(
        "INSERT INTO tool_versions (tool_id, workspace_id, version, manifest_digest, artifact_digest, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          "linter",
          context.tenant.workspaceId,
          "2.0.0",
          "sha256:digest2",
          "sha256:art2",
          "promoted",
          new Date().toISOString(),
        ],
      );
      await dbPool.query(
        "INSERT INTO tool_versions (tool_id, workspace_id, version, manifest_digest, artifact_digest, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          "linter",
          context.tenant.workspaceId,
          "1.0.0",
          "sha256:digest1",
          "sha256:art1",
          "promoted",
          new Date(Date.now() - 86400000).toISOString(),
        ],
      );

      const tool = createGetToolLineageTool({ dbPool });
      const result = await tool.handler({ toolId: "linter" }, context);

      expect(result.isError).toBe(false);
      const report = result.structuredData as {
        toolId: string;
        name: string;
        activeVersion: string;
        versions: Array<{ version: string; status: string; evaluation?: { score: number } }>;
        rollbackTargets: Array<{ version: string }>;
      };

      expect(report.toolId).toBe("linter");
      expect(report.name).toBe("Smart Linter");
      expect(report.activeVersion).toBe("2.0.0");
      expect(report.versions).toHaveLength(2);
      expect(report.versions[0].evaluation?.score).toBeGreaterThan(0.9);

      // Rollback target should include 1.0.0 (and exclude current active 2.0.0)
      expect(report.rollbackTargets.map((r) => r.version)).toContain("1.0.0");
      expect(report.rollbackTargets.map((r) => r.version)).not.toContain("2.0.0");
    });
  });

  describe("Dev Fixtures", () => {
    it("echo tool echoes back message and session context", async () => {
      const result = await echoFixtureTool.handler(
        { message: "ping test", payload: { a: 1 } },
        context,
      );

      expect(result.isError).toBe(false);
      const data = result.structuredData as {
        echoed: string;
        workspaceId: string;
        sessionId: string;
      };
      expect(data.echoed).toBe("ping test");
      expect(data.workspaceId).toBe(context.tenant.workspaceId);
      expect(data.sessionId).toBe("sess-123");
    });

    it("status tool returns online status and service metadata", async () => {
      const result = await statusFixtureTool.handler({}, context);
      expect(result.isError).toBe(false);
      const data = result.structuredData as { status: string; service: string };
      expect(data.status).toBe("online");
      expect(data.service).toBe("@tool-evolver/cloud");
    });

    it("test_failure tool simulates throw and error result", async () => {
      // 1. Throw mode
      await expect(
        testFailureFixtureTool.handler({ mode: "throw", message: "Boom" }, context),
      ).rejects.toThrow("Boom");

      // 2. Error result mode
      const errRes = await testFailureFixtureTool.handler(
        { mode: "error_result", message: "Graceful error" },
        context,
      );
      expect(errRes.isError).toBe(true);
      expect(errRes.content[0].text).toContain("Graceful error");
    });
  });
});
