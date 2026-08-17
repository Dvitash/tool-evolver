import { describe, expect, it } from "vitest";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createMessageEvent,
  createToolCallEvent,
  createToolResultEvent,
} from "./helpers.js";

describe("EpisodeSegmenter", () => {
  it("should segment events by session boundaries", () => {
    const segmenter = new EpisodeSegmenter();
    const events = [
      createMessageEvent({ eventId: "e1", sessionId: "sess-1", role: "user", content: "Run tests" }),
      createCommandExecEvent({ eventId: "e2", sessionId: "sess-1", command: "pnpm test" }),
      createMessageEvent({ eventId: "e3", sessionId: "sess-2", role: "user", content: "Fix file" }),
      createFileEditEvent({ eventId: "e4", sessionId: "sess-2", filePath: "src/index.ts" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].sessionId).toBe("sess-1");
    expect(episodes[0].events).toHaveLength(2);
    expect(episodes[1].sessionId).toBe("sess-2");
    expect(episodes[1].events).toHaveLength(2);
  });

  it("should segment events across distinct user turns", () => {
    const segmenter = new EpisodeSegmenter();
    const t0 = new Date(1700000000000).toISOString();
    const t1 = new Date(1700000001000).toISOString();
    const t2 = new Date(1700000002000).toISOString();
    const t3 = new Date(1700000003000).toISOString();

    const events = [
      createMessageEvent({ eventId: "e1", sessionId: "sess-1", role: "user", content: "Check status", timestamp: t0 }),
      createCommandExecEvent({ eventId: "e2", sessionId: "sess-1", command: "git status", timestamp: t1 }),
      createMessageEvent({ eventId: "e3", sessionId: "sess-1", role: "user", content: "Now build", timestamp: t2 }),
      createCommandExecEvent({ eventId: "e4", sessionId: "sess-1", command: "pnpm build", timestamp: t3 }),
    ];

    const episodes = segmenter.segmentEvents(events);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].turnIndex).toBe(0);
    expect(episodes[1].turnIndex).toBe(1);
    expect(episodes[0].metrics.stepCount).toBe(1);
    expect(episodes[1].metrics.stepCount).toBe(1);
  });

  it("should segment events when temporal gap exceeds idle threshold", () => {
    const segmenter = new EpisodeSegmenter({ idleGapThresholdMs: 60_000 }); // 1 min threshold
    const t0 = new Date(1700000000000).toISOString();
    const t1 = new Date(1700000005000).toISOString();
    const t2 = new Date(1700000200000).toISOString(); // 195 seconds later (> 60s)
    const t3 = new Date(1700000205000).toISOString();

    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "read_file", timestamp: t0 }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "file content", timestamp: t1 }),
      createToolCallEvent({ eventId: "e3", sessionId: "sess-1", toolName: "edit_file", timestamp: t2 }),
      createToolResultEvent({ eventId: "e4", sessionId: "sess-1", toolCallId: "e3", result: "ok", timestamp: t3 }),
    ];

    const episodes = segmenter.segmentEvents(events);
    expect(episodes).toHaveLength(2);
  });

  it("should accurately compute step counts, durations, and retry counts", () => {
    const segmenter = new EpisodeSegmenter();
    const t0 = new Date(1700000000000).toISOString();
    const t1 = new Date(1700000002000).toISOString();
    const t2 = new Date(1700000004000).toISOString();

    const events = [
      createToolCallEvent({ eventId: "e1", sessionId: "sess-1", toolName: "bash", parameters: { command: "pnpm test" }, timestamp: t0 }),
      createToolResultEvent({ eventId: "e2", sessionId: "sess-1", toolCallId: "e1", result: "test failed", isError: true, timestamp: t1, durationMs: 2000 }),
      createToolCallEvent({ eventId: "e3", sessionId: "sess-1", toolName: "bash", parameters: { command: "pnpm test" }, timestamp: t2 }),
    ];

    const episodes = segmenter.segmentEvents(events);
    expect(episodes).toHaveLength(1);
    const ep = episodes[0];
    expect(ep.metrics.stepCount).toBe(2);
    expect(ep.hasErrors).toBe(true);
    expect(ep.metrics.retryCount).toBe(1); // repeated tool:bash
    expect(ep.durationMs).toBeGreaterThanOrEqual(2000);
  });
});
