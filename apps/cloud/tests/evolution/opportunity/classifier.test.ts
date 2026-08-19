import { describe, expect, it } from "vitest";
import { OpportunityClassifier } from "../../../src/evolution/opportunity/classifier.js";
import { StructuralClusterer } from "../../../src/evolution/opportunity/clustering.js";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import type { WorkflowCluster } from "../../../src/evolution/opportunity/types.js";
import { FakeModelProvider, createInferenceService } from "../../../src/models/index.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createToolCallEvent,
  createToolResultEvent,
} from "./helpers.js";

describe("OpportunityClassifier & Model Invariants", () => {
  it("should generate heuristic classification when inference service is omitted", async () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier();

    const events = [
      createToolCallEvent({
        eventId: "e1",
        sessionId: "sess-1",
        toolName: "read_file",
        parameters: { path: "src/a.ts" },
      }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "ok" }),
      createFileEditEvent({ eventId: "e3", sessionId: "sess-1", filePath: "src/a.ts" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const classification = await classifier.classifyOpportunity(
      "tenant-1",
      cluster,
      "repeated_pattern",
    );
    expect(classification.title).toBeDefined();
    expect(classification.pattern).toBeDefined();
    expect(classification.confidenceScore).toBeGreaterThan(0);
    expect(classification.taskClass).toBe("file_read");
  });

  it("does not expose unrelated path inputs for an immutable VCS command profile", async () => {
    const classifier = new OpportunityClassifier();
    const cluster: WorkflowCluster = {
      clusterId: "cluster-vcs",
      workspaceId: "ws-1",
      version: "1.0.0",
      structuralHash: "vcs-hash",
      representativeSignature: {
        signatureId: "sig-vcs",
        structuralHash: "vcs-hash",
        operationSequence: ["vcs:git status --porcelain"],
        toolClasses: ["vcs"],
        commandPatterns: ["git status --porcelain"],
        normalizedPaths: ["src/a.ts"],
        argumentShapeHashes: [],
        stepCount: 1,
        totalDurationMs: 10,
        totalTokens: 0,
        retryCount: 0,
        estimatedCostUsd: 0,
        errorTypes: [],
      },
      episodes: [],
      episodeCount: 1,
      distinctSessionIds: ["sess-1"],
      completedOccurrences: 1,
      metrics: {
        totalDurationMs: 10,
        avgDurationMs: 10,
        totalTokens: 0,
        avgTokens: 0,
        totalCostUsd: 0,
        totalRetries: 0,
        totalStepCount: 1,
        avgStepCount: 1,
      },
      firstSeenAt: "2026-08-18T00:00:00.000Z",
      lastSeenAt: "2026-08-18T00:00:00.000Z",
      evidenceEventIds: ["evt-1"],
    };

    const classification = await classifier.classifyOpportunity(
      "tenant-1",
      cluster,
      "repeated_pattern",
    );
    expect(classification.commandProfiles).toEqual(["git status --porcelain"]);
    expect(classification.inferredInputs).toEqual([]);
    expect(classification.title).toBe("Inspect Git Working Tree Status");
    expect(classification.description).toBe(
      "Inspects Git working tree status. Use this instead of running: git status --porcelain — one call replaces the repeated command(s).",
    );
    expect(classification.description).toContain("Use this instead of running: git status --porcelain");
  });

  it("generates adoption-oriented description and title for git diff command profile", async () => {
    const classifier = new OpportunityClassifier();
    const cluster: WorkflowCluster = {
      clusterId: "cluster-git-diff",
      workspaceId: "ws-1",
      version: "1.0.0",
      structuralHash: "diff-hash",
      representativeSignature: {
        signatureId: "sig-diff",
        structuralHash: "diff-hash",
        operationSequence: ["vcs:git diff"],
        toolClasses: ["vcs"],
        commandPatterns: ["git diff"],
        normalizedPaths: [],
        argumentShapeHashes: [],
        stepCount: 1,
        totalDurationMs: 10,
        totalTokens: 0,
        retryCount: 0,
        estimatedCostUsd: 0,
        errorTypes: [],
      },
      episodes: [],
      episodeCount: 1,
      distinctSessionIds: ["sess-1"],
      completedOccurrences: 1,
      metrics: {
        totalDurationMs: 10,
        avgDurationMs: 10,
        totalTokens: 0,
        avgTokens: 0,
        totalCostUsd: 0,
        totalRetries: 0,
        totalStepCount: 1,
        avgStepCount: 1,
      },
      firstSeenAt: "2026-08-18T00:00:00.000Z",
      lastSeenAt: "2026-08-18T00:00:00.000Z",
      evidenceEventIds: ["evt-diff"],
    };

    const classification = await classifier.classifyOpportunity(
      "tenant-1",
      cluster,
      "repeated_pattern",
    );

    expect(classification.title).toBe("Inspect Git Working Tree Diff");
    expect(classification.commandProfiles).toEqual(["git diff"]);
    expect(classification.description).toBe(
      "Inspects Git working tree diff. Use this instead of running: git diff — one call replaces the repeated command(s).",
    );
    expect(classification.description).toContain("Use this instead of running: git diff");
    expect(classification.description).toContain("instead of");
  });

  it("formats multiple command profiles in adoption guidance", async () => {
    const classifier = new OpportunityClassifier();
    const cluster: WorkflowCluster = {
      clusterId: "cluster-multi-cmd",
      workspaceId: "ws-1",
      version: "1.0.0",
      structuralHash: "multi-hash",
      representativeSignature: {
        signatureId: "sig-multi",
        structuralHash: "multi-hash",
        operationSequence: ["vcs:git status", "vcs:git diff"],
        toolClasses: ["vcs"],
        commandPatterns: ["git status", "git diff"],
        normalizedPaths: [],
        argumentShapeHashes: [],
        stepCount: 2,
        totalDurationMs: 20,
        totalTokens: 0,
        retryCount: 0,
        estimatedCostUsd: 0,
        errorTypes: [],
      },
      episodes: [],
      episodeCount: 1,
      distinctSessionIds: ["sess-1"],
      completedOccurrences: 1,
      metrics: {
        totalDurationMs: 20,
        avgDurationMs: 20,
        totalTokens: 0,
        avgTokens: 0,
        totalCostUsd: 0,
        totalRetries: 0,
        totalStepCount: 2,
        avgStepCount: 2,
      },
      firstSeenAt: "2026-08-18T00:00:00.000Z",
      lastSeenAt: "2026-08-18T00:00:00.000Z",
      evidenceEventIds: ["evt-multi"],
    };

    const classification = await classifier.classifyOpportunity(
      "tenant-1",
      cluster,
      "repeated_pattern",
    );

    expect(classification.description).toBe(
      "Inspects Git working tree status. Use this instead of running: git status, git diff — one call replaces the repeated command(s).",
    );
  });
  it("should enrich opportunity classification using InferenceService", async () => {
    const fakeProvider = new FakeModelProvider({ id: "mock-model-provider" });
    const inferenceService = createInferenceService();
    inferenceService.router.registerProvider(fakeProvider);

    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier(inferenceService);

    const events = [
      createToolCallEvent({
        eventId: "e1",
        sessionId: "sess-1",
        toolName: "run_tests",
        parameters: { filter: "unit" },
      }),
      createToolResultEvent({
        eventId: "e2",
        sessionId: "sess-1",
        toolCallId: "e1",
        result: "1 failed",
      }),
      createCommandExecEvent({
        eventId: "e3",
        sessionId: "sess-1",
        command: "vitest run --coverage",
      }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    const classification = await classifier.classifyOpportunity(
      "tenant-1",
      cluster,
      "repeated_pattern",
    );
    expect(classification.title).toBeDefined();
    expect(classification.provenance).toBeDefined();
    expect(classification.provenance?.providerId).toBe("mock-model-provider");
  });

  it("CRITICAL INVARIANT: model output cannot alter deterministic occurrence counts or evidence references", async () => {
    const fakeProvider = new FakeModelProvider({ id: "malicious-mock" });
    const inferenceService = createInferenceService();
    inferenceService.router.registerProvider(fakeProvider);

    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier(inferenceService);

    const events = [
      createToolCallEvent({ eventId: "truth-event-1", sessionId: "sess-1", toolName: "read_file" }),
      createToolResultEvent({
        eventId: "truth-event-2",
        sessionId: "sess-1",
        toolCallId: "truth-event-1",
        result: "ok",
      }),
      createFileEditEvent({
        eventId: "truth-event-3",
        sessionId: "sess-1",
        filePath: "src/main.ts",
      }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);

    expect(cluster.completedOccurrences).toBe(1);
    expect(cluster.evidenceEventIds).toEqual(["truth-event-1", "truth-event-2", "truth-event-3"]);

    const classification = await classifier.classifyOpportunity(
      "tenant-1",
      cluster,
      "repeated_pattern",
    );

    expect(classification).not.toHaveProperty("completedOccurrences");
    expect(classification).not.toHaveProperty("occurrenceCount");
    expect(classification).not.toHaveProperty("evidenceEventIds");

    expect(cluster.completedOccurrences).toBe(1);
    expect(cluster.evidenceEventIds).toEqual(["truth-event-1", "truth-event-2", "truth-event-3"]);
  });
});
