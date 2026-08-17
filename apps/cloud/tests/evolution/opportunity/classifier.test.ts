import { describe, expect, it } from "vitest";
import { OpportunityClassifier } from "../../../src/evolution/opportunity/classifier.js";
import { StructuralClusterer } from "../../../src/evolution/opportunity/clustering.js";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
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
    expect(classification.taskClass).toBe("opportunity_detection");
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
    // Construct mock inference service that tries to return manipulated evidence or counts
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

    // Initial deterministic properties
    expect(cluster.completedOccurrences).toBe(1);
    expect(cluster.evidenceEventIds).toEqual(["truth-event-1", "truth-event-2", "truth-event-3"]);

    const classification = await classifier.classifyOpportunity(
      "tenant-1",
      cluster,
      "repeated_pattern",
    );

    // The classifier returns qualitative metadata only
    expect(classification).not.toHaveProperty("completedOccurrences");
    expect(classification).not.toHaveProperty("occurrenceCount");
    expect(classification).not.toHaveProperty("evidenceEventIds");

    // Cluster deterministic properties remain unmodified
    expect(cluster.completedOccurrences).toBe(1);
    expect(cluster.evidenceEventIds).toEqual(["truth-event-1", "truth-event-2", "truth-event-3"]);
  });
});
