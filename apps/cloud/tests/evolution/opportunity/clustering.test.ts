import { describe, expect, it } from "vitest";
import { StructuralClusterer } from "../../../src/evolution/opportunity/clustering.js";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createToolCallEvent,
  createToolResultEvent,
} from "./helpers.js";

describe("StructuralClusterer", () => {
  it("should cluster structurally similar episodes together into a single cluster", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();

    // 3 episodes across 3 sessions performing the same test-fix pattern
    const events1 = [
      createToolCallEvent({
        eventId: "e1_1",
        sessionId: "sess-1",
        toolName: "read_file",
        parameters: { path: "src/a.ts" },
      }),
      createToolResultEvent({
        eventId: "e1_2",
        sessionId: "sess-1",
        toolCallId: "e1_1",
        result: "ok",
      }),
      createFileEditEvent({ eventId: "e1_3", sessionId: "sess-1", filePath: "src/a.ts" }),
    ];

    const events2 = [
      createToolCallEvent({
        eventId: "e2_1",
        sessionId: "sess-2",
        toolName: "read_file",
        parameters: { path: "src/b.ts" },
      }),
      createToolResultEvent({
        eventId: "e2_2",
        sessionId: "sess-2",
        toolCallId: "e2_1",
        result: "ok",
      }),
      createFileEditEvent({ eventId: "e2_3", sessionId: "sess-2", filePath: "src/b.ts" }),
    ];

    const events3 = [
      createToolCallEvent({
        eventId: "e3_1",
        sessionId: "sess-3",
        toolName: "read_file",
        parameters: { path: "src/c.ts" },
      }),
      createToolResultEvent({
        eventId: "e3_2",
        sessionId: "sess-3",
        toolCallId: "e3_1",
        result: "ok",
      }),
      createFileEditEvent({ eventId: "e3_3", sessionId: "sess-3", filePath: "src/c.ts" }),
    ];

    const allEvents = [...events1, ...events2, ...events3];
    const episodes = segmenter.segmentEvents(allEvents);
    expect(episodes).toHaveLength(3);

    const clusters = clusterer.clusterEpisodes(episodes);
    expect(clusters).toHaveLength(1);

    const cluster = clusters[0];
    expect(cluster.episodeCount).toBe(3);
    expect(cluster.distinctSessionIds).toHaveLength(3);
    expect(cluster.completedOccurrences).toBe(3);
    expect(cluster.evidenceEventIds).toHaveLength(9);
  });

  it("should separate distinct workflow patterns into separate clusters", () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();

    // Pattern A: read -> edit
    const eventsA = [
      createToolCallEvent({
        eventId: "a1",
        sessionId: "sess-1",
        toolName: "read_file",
        parameters: { path: "src/a.ts" },
      }),
      createToolResultEvent({ eventId: "a2", sessionId: "sess-1", toolCallId: "a1", result: "ok" }),
      createFileEditEvent({ eventId: "a3", sessionId: "sess-1", filePath: "src/a.ts" }),
    ];

    // Pattern B: git checkout -> pnpm test -> vitest
    const eventsB = [
      createCommandExecEvent({
        eventId: "b1",
        sessionId: "sess-2",
        command: "git checkout -b feature",
      }),
      createCommandExecEvent({ eventId: "b2", sessionId: "sess-2", command: "pnpm test" }),
      createCommandExecEvent({ eventId: "b3", sessionId: "sess-2", command: "vitest run" }),
    ];

    const episodes = segmenter.segmentEvents([...eventsA, ...eventsB]);
    const clusters = clusterer.clusterEpisodes(episodes);

    expect(clusters).toHaveLength(2);
    expect(clusters[0].structuralHash).not.toBe(clusters[1].structuralHash);
  });
});
