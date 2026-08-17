import type { CapabilityEnvelope, ToolManifest } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import {
  OpportunityDetectionService,
  createOpportunityDetectionService,
} from "../../../src/evolution/opportunity/index.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createToolCallEvent,
  createToolResultEvent,
} from "./helpers.js";

describe("OpportunityDetectionService (End-to-End)", () => {
  it("should produce 1 eligible opportunity from 3 structurally similar occurrences", async () => {
    const service = createOpportunityDetectionService({
      triggers: { minOccurrencesNormal: 3 },
    });

    const createOccurrence = (sessionId: string, prefix: string) => [
      createToolCallEvent({
        eventId: `${prefix}_1`,
        sessionId,
        toolName: "read_file",
        parameters: { path: `src/${prefix}.ts` },
      }),
      createToolResultEvent({
        eventId: `${prefix}_2`,
        sessionId,
        toolCallId: `${prefix}_1`,
        result: "content",
      }),
      createFileEditEvent({ eventId: `${prefix}_3`, sessionId, filePath: `src/${prefix}.ts` }),
    ];

    const events = [
      ...createOccurrence("sess-1", "occ1"),
      ...createOccurrence("sess-2", "occ2"),
      ...createOccurrence("sess-3", "occ3"),
    ];

    const result = await service.detectOpportunities({
      accountId: "acct-1",
      workspaceId: "ws-1",
      events,
    });

    expect(result.episodes).toHaveLength(3);
    expect(result.clusters).toHaveLength(1);
    expect(result.eligibleCount).toBe(1);
    expect(result.opportunities).toHaveLength(1);

    const opp = result.opportunities[0];
    expect(opp.status).toBe("eligible");
    expect(opp.triggerType).toBe("normal_frequency");
    expect(opp.triggerReason).toBe("repeated_pattern");
    expect(opp.occurrenceCount).toBe(3);
    expect(opp.distinctSessionCount).toBe(3);
    expect(opp.evidenceEventIds).toHaveLength(9);
  });

  it("should trigger only on exceptional waste for 1 occurrence", async () => {
    const service = createOpportunityDetectionService({
      triggers: {
        minOccurrencesNormal: 3,
        wasteThresholds: { exceptionalDurationMs: 60_000 },
      },
    });

    // Case A: 1 normal occurrence -> 0 opportunities
    const normalEvents = [
      createToolCallEvent({
        eventId: "n1",
        sessionId: "sess-norm",
        toolName: "read_file",
        parameters: { path: "src/a.ts" },
      }),
      createToolResultEvent({
        eventId: "n2",
        sessionId: "sess-norm",
        toolCallId: "n1",
        result: "ok",
        durationMs: 200,
      }),
    ];

    const normalResult = await service.detectOpportunities({
      accountId: "acct-1",
      workspaceId: "ws-1",
      events: normalEvents,
    });
    expect(normalResult.opportunities).toHaveLength(0);

    // Case B: 1 exceptional waste occurrence -> 1 eligible opportunity
    const wasteEvents = [
      createToolCallEvent({ eventId: "w1", sessionId: "sess-waste", toolName: "heavy_build" }),
      createToolResultEvent({
        eventId: "w2",
        sessionId: "sess-waste",
        toolCallId: "w1",
        result: "ok",
        durationMs: 90_000,
      }), // 90s > 60s
    ];

    const wasteResult = await service.detectOpportunities({
      accountId: "acct-1",
      workspaceId: "ws-1",
      events: wasteEvents,
    });
    expect(wasteResult.opportunities).toHaveLength(1);
    expect(wasteResult.opportunities[0].triggerType).toBe("exceptional_waste");
    expect(wasteResult.opportunities[0].triggerReason).toBe("latency_bottleneck");
    expect(wasteResult.opportunities[0].occurrenceCount).toBe(1);
  });

  it("should prevent duplicate net-new tools when existing tool catalog covers the workflow", async () => {
    const service = createOpportunityDetectionService({
      triggers: { minOccurrencesNormal: 3 },
    });

    const existingTool: ToolManifest = {
      id: "bulk_file_updater",
      name: "bulk_file_updater",
      version: "1.0.0",
      description: "Updates files in bulk",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      runtime: { language: "typescript", entrypoint: "dist/index.js", timeoutMs: 10000 },
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedHosts: [],
          denyHosts: [],
          allowLoopback: true,
          allowedPorts: [],
        },
        command: {
          allowShellExecution: false,
          allowedCommands: [],
          allowedBinaries: [],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
        secrets: {
          requiredKeys: [],
          optionalKeys: [],
          allowEnvSecrets: false,
          allowVaultSecrets: false,
          denySecrets: [],
        },
        limits: {
          maxMemoryMb: 512,
          maxCpuPercent: 100,
          maxDurationMs: 60000,
          maxConcurrentInvocations: 1,
          maxLogSizeBytes: 1048576,
        },
      },
      limits: {},
      scope: "workspace",
      digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    const createOccurrence = (sessionId: string, prefix: string) => [
      createToolCallEvent({
        eventId: `${prefix}_1`,
        sessionId,
        toolName: "bulk_file_updater",
        parameters: { path: `src/${prefix}.ts` },
      }),
      createToolResultEvent({
        eventId: `${prefix}_2`,
        sessionId,
        toolCallId: `${prefix}_1`,
        result: "updated",
      }),
    ];

    const events = [
      ...createOccurrence("sess-1", "occ1"),
      ...createOccurrence("sess-2", "occ2"),
      ...createOccurrence("sess-3", "occ3"),
    ];

    const result = await service.detectOpportunities({
      accountId: "acct-1",
      workspaceId: "ws-1",
      events,
      existingTools: [existingTool],
    });

    expect(result.opportunities).toHaveLength(1);
    const opp = result.opportunities[0];
    expect(opp.status).toBe("duplicate");
    expect(opp.coverage.status).toBe("duplicate");
    expect(opp.coverage.matchingToolId).toBe("bulk_file_updater");
    expect(result.eligibleCount).toBe(0); // Not eligible for net-new generation
    expect(result.duplicateCount).toBe(1);
  });

  it("should suppress out-of-envelope or destructive workflows", async () => {
    const service = createOpportunityDetectionService({
      triggers: { minOccurrencesNormal: 3 },
    });

    const envelope: CapabilityEnvelope = {
      envelopeId: "env-1",
      workspaceId: "ws-1",
      version: "1.0.0",
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowOutbound: false,
        allowedHosts: [],
        denyHosts: [],
        allowLoopback: true,
        allowedPorts: [],
      },
      command: {
        allowShellExecution: false,
        allowedCommands: ["pnpm"],
        allowedBinaries: ["node"],
        forbiddenPatterns: ["rm -rf"],
        allowEnvPassthrough: [],
      },
      secrets: {
        requiredKeys: [],
        optionalKeys: [],
        allowEnvSecrets: false,
        allowVaultSecrets: false,
        denySecrets: [],
      },
      limits: {
        maxMemoryMb: 512,
        maxCpuPercent: 100,
        maxDurationMs: 60000,
        maxConcurrentInvocations: 1,
        maxLogSizeBytes: 1048576,
      },
      isFrozen: false,
      createdAt: new Date().toISOString(),
    };

    // 3 occurrences of destructive rm -rf
    const createOccurrence = (sessionId: string, prefix: string) => [
      createCommandExecEvent({ eventId: `${prefix}_1`, sessionId, command: "rm -rf /tmp/test" }),
      createCommandExecEvent({ eventId: `${prefix}_2`, sessionId, command: "pnpm test" }),
    ];

    const events = [
      ...createOccurrence("sess-1", "occ1"),
      ...createOccurrence("sess-2", "occ2"),
      ...createOccurrence("sess-3", "occ3"),
    ];

    const result = await service.detectOpportunities({
      accountId: "acct-1",
      workspaceId: "ws-1",
      events,
      envelope,
    });

    expect(result.opportunities).toHaveLength(1);
    const opp = result.opportunities[0];
    expect(opp.status).toBe("suppressed");
    expect(opp.suppression.suppressed).toBe(true);
    expect(opp.suppression.reason).toBe("destructive");
    expect(result.eligibleCount).toBe(0);
    expect(result.suppressedCount).toBe(1);
  });

  it("should support query and retrieval by tenant and filter", async () => {
    const service = createOpportunityDetectionService({
      triggers: { minOccurrencesNormal: 3 },
    });

    const createOccurrence = (sessionId: string, prefix: string) => [
      createToolCallEvent({
        eventId: `${prefix}_1`,
        sessionId,
        toolName: "read_file",
        parameters: { path: "src/a.ts" },
      }),
      createToolResultEvent({
        eventId: `${prefix}_2`,
        sessionId,
        toolCallId: `${prefix}_1`,
        result: "ok",
      }),
      createFileEditEvent({ eventId: `${prefix}_3`, sessionId, filePath: "src/a.ts" }),
    ];

    const events = [
      ...createOccurrence("sess-1", "occ1"),
      ...createOccurrence("sess-2", "occ2"),
      ...createOccurrence("sess-3", "occ3"),
    ];

    const tenant = { accountId: "acct-alpha", workspaceId: "ws-alpha" };
    const detected = await service.processSessionEvents(tenant, events);
    expect(detected).toHaveLength(1);

    const fetched = await service.getOpportunityById(tenant, detected[0].id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(detected[0].id);

    const listed = await service.listOpportunities(tenant, { status: "eligible" });
    expect(listed).toHaveLength(1);

    // Different tenant cannot access
    const otherTenant = { accountId: "acct-beta", workspaceId: "ws-beta" };
    const foreignGet = await service.getOpportunityById(otherTenant, detected[0].id);
    expect(foreignGet).toBeNull();
  });
});
