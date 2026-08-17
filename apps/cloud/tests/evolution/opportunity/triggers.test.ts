import { describe, expect, it } from "vitest";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import { StructuralClusterer } from "../../../src/evolution/opportunity/clustering.js";
import { TriggerEvaluator } from "../../../src/evolution/opportunity/triggers.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createToolCallEvent,
  createToolResultEvent,
} from "./helpers.js";

describe("TriggerEvaluator", () => {
  it("should trigger normal opportunity when cluster has >= 3 completed occurrences", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const evaluator = new TriggerEvaluator({ minOccurrencesNormal: 3 });

    const createOccurrenceEvents = (sessionId: string, idPrefix: string) => [
      createToolCallEvent({ eventId: `${idPrefix}_1`, sessionId, toolName: "read_file", parameters: { path: "src/main.ts" } }),
      createToolResultEvent({ eventId: `${idPrefix}_2`, sessionId, toolCallId: `${idPrefix}_1`, result: "content" }),
      createFileEditEvent({ eventId: `${idPrefix}_3`, sessionId, filePath: "src/main.ts" }),
    ];

    const events = [
      ...createOccurrenceEvents("sess-1", "occ1"),
      ...createOccurrenceEvents("sess-2", "occ2"),
      ...createOccurrenceEvents("sess-3", "occ3"),
    ];

    const episodes = segmenter.segmentEvents(events);
    const clusters = clusterer.clusterEpisodes(episodes);
    expect(clusters).toHaveLength(1);

    const result = evaluator.evaluateCluster(clusters[0]);
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe("normal_frequency");
    expect(result.reason).toBe("repeated_pattern");
    expect(result.metrics.occurrenceCount).toBe(3);
  });

  it("should NOT trigger opportunity on 1 or 2 occurrences if waste thresholds are not exceeded", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const evaluator = new TriggerEvaluator({ minOccurrencesNormal: 3 });

    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "read_file", parameters: { path: "src/main.ts" } }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "content", durationMs: 100 }),
      createFileEditEvent({ eventId: "e3", sessionId: "sess-1", filePath: "src/main.ts" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const clusters = clusterer.clusterEpisodes(episodes);
    expect(clusters).toHaveLength(1);

    const result = evaluator.evaluateCluster(clusters[0]);
    expect(result.triggered).toBe(false);
    expect(result.triggerType).toBe("none");
  });

  it("should trigger exceptional waste opportunity on 1 occurrence exceeding duration threshold", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const evaluator = new TriggerEvaluator({
      wasteThresholds: { exceptionalDurationMs: 60_000 },
    });

    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "heavy_task", parameters: { target: "all" } }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "done", durationMs: 75_000 }), // 75s > 60s
    ];

    const episodes = segmenter.segmentEvents(events);
    const clusters = clusterer.clusterEpisodes(episodes);
    expect(clusters).toHaveLength(1);

    const result = evaluator.evaluateCluster(clusters[0]);
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe("exceptional_waste");
    expect(result.reason).toBe("latency_bottleneck");
    expect(result.metrics.occurrenceCount).toBe(1);
  });

  it("should trigger exceptional waste opportunity on 1 occurrence exceeding retry threshold", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const evaluator = new TriggerEvaluator({
      wasteThresholds: { exceptionalRetryCount: 3 },
    });

    // 4 repeated failed attempts (3 retries)
    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "bash", parameters: { command: "npm test" } }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "fail", isError: true }),
      createToolCallEvent({ eventId: "e3", sessionId: "sess-1", toolName: "bash", parameters: { command: "npm test" } }),
      createToolResultEvent({ eventId: "e4", sessionId: "sess-1", toolCallId: "e3", result: "fail", isError: true }),
      createToolCallEvent({ eventId: "e5", sessionId: "sess-1", toolName: "bash", parameters: { command: "npm test" } }),
      createToolResultEvent({ eventId: "e6", sessionId: "sess-1", toolCallId: "e5", result: "fail", isError: true }),
      createToolCallEvent({ eventId: "e7", sessionId: "sess-1", toolName: "bash", parameters: { command: "npm test" } }),
      createToolResultEvent({ eventId: "e8", sessionId: "sess-1", toolCallId: "e7", result: "success" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const clusters = clusterer.clusterEpisodes(episodes);
    expect(clusters).toHaveLength(1);

    const result = evaluator.evaluateCluster(clusters[0]);
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe("exceptional_waste");
    expect(result.reason).toBe("failure_recovery");
    expect(result.metrics.retryCount).toBeGreaterThanOrEqual(3);
  });

  it("should trigger exceptional waste on high token volume", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const evaluator = new TriggerEvaluator({
      wasteThresholds: { exceptionalTokenCount: 10_000 },
    });

    const events = [
      {
        ...createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "read_large_dump" }),
        payload: { usage: { promptTokens: 8000, completionTokens: 4000, totalTokens: 12000 } },
      },
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "ok" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const clusters = clusterer.clusterEpisodes(episodes);
    const result = evaluator.evaluateCluster(clusters[0]);

    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe("exceptional_waste");
    expect(result.reason).toBe("missing_abstraction");
  });
});
