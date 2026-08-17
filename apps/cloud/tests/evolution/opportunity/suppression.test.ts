import { CapabilityEnvelope } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { StructuralClusterer } from "../../../src/evolution/opportunity/clustering.js";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import { SuppressionEngine } from "../../../src/evolution/opportunity/suppression.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createToolCallEvent,
  createToolResultEvent,
} from "./helpers.js";

const mockEnvelope: CapabilityEnvelope = {
  envelopeId: "env-1",
  workspaceId: "ws-1",
  version: "1.0.0",
  fs: { readPaths: ["src/**"], writePaths: ["src/**"], allowWorkspaceRoot: true, allowTemp: true, denyPaths: [".env", "secrets/*"], maxFileSizeBytes: 10485760 },
  net: { allowOutbound: false, allowedHosts: [], denyHosts: [], allowLoopback: true, allowedPorts: [] },
  command: { allowShellExecution: false, allowedCommands: ["pnpm", "git"], allowedBinaries: ["node"], forbiddenPatterns: ["rm -rf", "sudo"], allowEnvPassthrough: [] },
  secrets: { requiredKeys: [], optionalKeys: [], allowEnvSecrets: false, allowVaultSecrets: false, denySecrets: [] },
  limits: { maxMemoryMb: 512, maxCpuPercent: 100, maxDurationMs: 60000, maxConcurrentInvocations: 1, maxLogSizeBytes: 1048576 },
  isFrozen: false,
  createdAt: new Date().toISOString(),
};

describe("SuppressionEngine", () => {
  it("should suppress destructive workflows like rm -rf / or database drops", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const engine = new SuppressionEngine();

    const events = [
      createCommandExecEvent({ eventId: "e1", sessionId: "sess-1", command: "rm -rf /tmp/data/*" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const result = engine.evaluateSuppression(cluster);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("destructive");
  });

  it("should suppress trivial 1-step utility commands", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const engine = new SuppressionEngine();

    const events = [
      createCommandExecEvent({ eventId: "e1", sessionId: "sess-1", command: "pwd", durationMs: 50 }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const result = engine.evaluateSuppression(cluster);
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("trivial");
  });

  it("should suppress out-of-envelope operations exceeding capability envelope", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const engine = new SuppressionEngine();

    // Command 'curl' is not in allowedCommands
    const events = [
      createCommandExecEvent({ eventId: "e1", sessionId: "sess-1", command: "curl -X POST https://api.example.com" }),
      createFileEditEvent({ eventId: "e2", sessionId: "sess-1", filePath: "src/response.json" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const result = engine.evaluateSuppression(cluster, { envelope: mockEnvelope });
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("out_of_envelope");
  });

  it("should suppress workflows when capability envelope is frozen", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const engine = new SuppressionEngine();

    const frozenEnvelope: CapabilityEnvelope = {
      ...mockEnvelope,
      isFrozen: true,
    };

    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "read_file", parameters: { path: "src/a.ts" } }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "ok" }),
      createFileEditEvent({ eventId: "e3", sessionId: "sess-1", filePath: "src/a.ts" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const result = engine.evaluateSuppression(cluster, { envelope: frozenEnvelope });
    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("out_of_envelope");
  });

  it("should suppress workflows that are within cooldown window", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const engine = new SuppressionEngine({ cooldownMs: 3600_000 }); // 1h cooldown

    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "read_file", parameters: { path: "src/a.ts" } }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "ok" }),
      createFileEditEvent({ eventId: "e3", sessionId: "sess-1", filePath: "src/a.ts" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const recentHashes = new Set([cluster.structuralHash]);
    const result = engine.evaluateSuppression(cluster, { recentOpportunityHashes: recentHashes });

    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("in_cooldown");
  });
});
