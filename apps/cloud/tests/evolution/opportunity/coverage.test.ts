import { ToolManifest } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { StructuralClusterer } from "../../../src/evolution/opportunity/clustering.js";
import { CoverageEngine } from "../../../src/evolution/opportunity/coverage.js";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createToolCallEvent,
  createToolResultEvent,
} from "./helpers.js";

const mockToolManifest: ToolManifest = {
  id: "run_test_suite",
  name: "run_test_suite",
  version: "1.0.0",
  description: "Executes unit and integration test suites with coverage",
  parameters: {
    type: "object",
    properties: {
      testFilter: { type: "string" },
      coverage: { type: "boolean" },
    },
    required: [],
  },
  runtime: {
    language: "typescript",
    entrypoint: "dist/index.js",
    timeoutMs: 30000,
  },
  capabilities: {
    fs: { readPaths: [], writePaths: [], allowWorkspaceRoot: true, allowTemp: true, denyPaths: [], maxFileSizeBytes: 10485760 },
    net: { allowOutbound: false, allowedHosts: [], denyHosts: [], allowLoopback: true, allowedPorts: [] },
    command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
    secrets: { requiredKeys: [], optionalKeys: [], allowEnvSecrets: false, allowVaultSecrets: false, denySecrets: [] },
    limits: { maxMemoryMb: 512, maxCpuPercent: 100, maxDurationMs: 60000, maxConcurrentInvocations: 1, maxLogSizeBytes: 1048576 },
  },
  limits: {},
  scope: "workspace",
  digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  metadata: {},
  createdAt: new Date().toISOString(),
};

describe("CoverageEngine", () => {
  it("should classify workflow as net_new when catalog is empty or has no matches", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const engine = new CoverageEngine();

    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "special_compiler", parameters: { src: "foo.rs" } }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "ok" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const result = engine.evaluateCoverage(cluster, []);
    expect(result.status).toBe("net_new");
    expect(result.similarityScore).toBe(0);
  });

  it("should classify workflow as duplicate or covered when an existing tool matches", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const engine = new CoverageEngine();

    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "run_test_suite", parameters: { testFilter: "auth" } }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "all passed" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const result = engine.evaluateCoverage(cluster, [mockToolManifest]);
    expect(result.status).toBe("duplicate");
    expect(result.matchingToolId).toBe("run_test_suite");
    expect(result.similarityScore).toBeGreaterThanOrEqual(0.9);
  });

  it("should classify as update_candidate when existing tool partially matches", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const engine = new CoverageEngine();

    // Partial match: uses test runner plus extra custom steps
    const events = [
      createCommandExecEvent({ eventId: "e1", sessionId: "sess-1", command: "run_test_suite --watch" }),
      createFileEditEvent({ eventId: "e2", sessionId: "sess-1", filePath: "coverage/report.json" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const result = engine.evaluateCoverage(cluster, [mockToolManifest]);
    expect(result.status).toBe("update_candidate");
    expect(result.matchingToolId).toBe("run_test_suite");
  });
});
