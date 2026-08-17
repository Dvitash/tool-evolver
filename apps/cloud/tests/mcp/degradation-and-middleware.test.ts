/**
 * @tool-evolver/cloud - Middleware Pipeline & Degradation Tests
 */

import { describe, expect, it, vi } from "vitest";
import {
  CloudCatalogService,
  CloudMcpServer,
  MCP_ERROR_CODES,
  McpInvocationError,
  composeMiddleware,
  createAuditPrivacyMiddleware,
  createCancellationMiddleware,
  createCloudCatalogService,
  createCloudMcpServer,
  createParameterValidationMiddleware,
  createRateLimitMiddleware,
  createTenantAuthMiddleware,
  createTimeoutMiddleware,
} from "../../src/mcp/index.js";
import type {
  CloudMcpInvocationContext,
  CloudMcpToolDefinition,
  InvocationAuditRecord,
} from "../../src/mcp/types.js";

describe("Cloud MCP - Middleware & Degradation Resilience", () => {
  const context: CloudMcpInvocationContext = {
    tenant: {
      accountId: "acc-mid-1",
      workspaceId: "ws-mid-1",
    },
    traceId: "trace-mid",
  };

  describe("Graceful Partial Degradation", () => {
    it("continues operating and serving healthy tools when a provider fails", async () => {
      const catalogService = createCloudCatalogService();

      // Healthy provider
      catalogService.registerProvider({
        name: "healthy-provider",
        getTools: async () => [
          {
            name: "healthy_tool",
            description: "Working tool",
            inputSchema: { type: "object", properties: {} },
            handler: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
          },
        ],
        getTool: async (_t, name) => {
          if (name === "healthy_tool") {
            return {
              name: "healthy_tool",
              description: "Working tool",
              inputSchema: { type: "object", properties: {} },
              handler: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
            };
          }
          return null;
        },
      });

      // Broken provider that crashes
      catalogService.registerProvider({
        name: "failing-provider",
        getTools: async () => {
          throw new Error("External service connection failed");
        },
        getTool: async () => {
          throw new Error("External service connection failed");
        },
      });

      // getTools should NOT throw: it must gracefully return healthy tools + platform tools
      const tools = await catalogService.getTools(context.tenant);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("healthy_tool");
      expect(toolNames).toContain("echo");
      expect(toolNames).toContain("status");

      // getTool for healthy tool succeeds
      const healthyTool = await catalogService.getTool(context.tenant, "healthy_tool");
      expect(healthyTool).not.toBeNull();
      expect(healthyTool?.name).toBe("healthy_tool");
    });
  });

  describe("Rate Limit Middleware", () => {
    it("enforces rate limit and returns structured error when limit exceeded", async () => {
      const rateLimiter = createRateLimitMiddleware({ defaultRequestsPerMinute: 2 });
      const tool: CloudMcpToolDefinition = {
        name: "rate_limited_tool",
        description: "Test rate limit",
        inputSchema: { type: "object", properties: {} },
        rateLimit: { maxRequestsPerMinute: 2 },
        handler: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
      };

      const next = async () => tool.handler({}, context);

      // Call 1: pass
      await expect(rateLimiter(context, tool, {}, next)).resolves.toBeDefined();
      // Call 2: pass
      await expect(rateLimiter(context, tool, {}, next)).resolves.toBeDefined();

      // Call 3: rejected with RATE_LIMITED
      await expect(rateLimiter(context, tool, {}, next)).rejects.toThrowError(McpInvocationError);
      try {
        await rateLimiter(context, tool, {}, next);
      } catch (err: unknown) {
        const error = err as McpInvocationError;
        expect(error.code).toBe(MCP_ERROR_CODES.RATE_LIMITED);
        expect(error.message).toContain("Rate limit exceeded");
      }
    });
  });

  describe("Parameter Validation Middleware", () => {
    it("validates types and required properties", async () => {
      const validator = createParameterValidationMiddleware();
      const tool: CloudMcpToolDefinition = {
        name: "strict_tool",
        description: "Requires typed params",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "integer" },
            name: { type: "string" },
            tags: { type: "array" },
          },
          required: ["count", "name"],
        },
        handler: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
      };

      const next = async () => tool.handler({}, context);

      // 1. Valid params
      await expect(
        validator(context, tool, { count: 10, name: "Alpha", tags: ["a", "b"] }, next),
      ).resolves.toBeDefined();

      // 2. Missing required field
      await expect(validator(context, tool, { count: 10 }, next)).rejects.toThrow(
        /Missing required parameter: 'name'/,
      );

      // 3. Type mismatch
      await expect(
        validator(context, tool, { count: "not-a-number", name: "Alpha" }, next),
      ).rejects.toThrow(/Field 'count' must be an integer/);
    });
  });

  describe("Timeout Middleware", () => {
    it("aborts execution and throws REQUEST_TIMEOUT when deadline exceeded", async () => {
      const timeoutMiddleware = createTimeoutMiddleware(50); // 50ms timeout
      const tool: CloudMcpToolDefinition = {
        name: "slow_tool",
        description: "Slow tool",
        timeoutMs: 50,
        inputSchema: { type: "object", properties: {} },
        handler: async (_p, ctx) => {
          const { promise, reject } = Promise.withResolvers<CallToolResult>();
          const timer = setTimeout(() => {
            reject(new Error("Done waiting"));
          }, 500);

          if (ctx.signal) {
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(ctx.signal?.reason);
            });
          }
          return promise;
        },
      };

      const next = async () => tool.handler({}, context);

      await expect(timeoutMiddleware(context, tool, {}, next)).rejects.toThrowError(
        McpInvocationError,
      );

      try {
        await timeoutMiddleware(context, tool, {}, next);
      } catch (err: unknown) {
        const error = err as McpInvocationError;
        expect(error.code).toBe(MCP_ERROR_CODES.REQUEST_TIMEOUT);
      }
    });
  });

  describe("Audit & Privacy Middleware", () => {
    it("records invocation audit records with classification and duration", async () => {
      const auditRecords: InvocationAuditRecord[] = [];
      const auditMiddleware = createAuditPrivacyMiddleware({
        onAuditRecord: (rec) => auditRecords.push(rec),
      });

      const tool: CloudMcpToolDefinition = {
        name: "audited_tool",
        description: "Audited tool",
        classification: "mutation",
        privacyLevel: "airgapped",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: [{ type: "text", text: "done" }], isError: false }),
      };

      const next = async () => tool.handler({}, context);
      await auditMiddleware(context, tool, {}, next);

      expect(auditRecords).toHaveLength(1);
      expect(auditRecords[0].toolName).toBe("audited_tool");
      expect(auditRecords[0].classification).toBe("mutation");
      expect(auditRecords[0].privacyLevel).toBe("airgapped");
      expect(auditRecords[0].isError).toBe(false);
      expect(auditRecords[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
