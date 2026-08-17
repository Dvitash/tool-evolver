import { type NormalizedSessionEvent, hashCanonicalContent } from "@tool-evolver/contracts";
import type { Episode, EpisodeMetrics, SegmenterOptions } from "./types.js";

const DEFAULT_IDLE_GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MIN_EVENTS = 1;
const DEFAULT_MAX_EVENTS = 100;

/**
 * Parses timestamp string or number into epoch milliseconds.
 */
function parseTimestampMs(ts: string | number | undefined): number {
  if (!ts) return Date.now();
  if (typeof ts === "number") return ts;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Extracts token usage from an event if available in payload or metadata.
 */
function extractEventTokens(event: NormalizedSessionEvent): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;

  const anyEvt = event as unknown as Record<string, unknown>;
  const payload = (anyEvt.payload as Record<string, unknown>) ?? {};
  const metadata = (anyEvt.metadata as Record<string, unknown>) ?? {};

  // Check model events or usage objects
  const usage =
    (payload.usage as Record<string, unknown>) || (metadata.usage as Record<string, unknown>);
  if (usage && typeof usage === "object") {
    inputTokens =
      typeof usage.inputTokens === "number"
        ? usage.inputTokens
        : typeof usage.promptTokens === "number"
          ? usage.promptTokens
          : 0;
    outputTokens =
      typeof usage.outputTokens === "number"
        ? usage.outputTokens
        : typeof usage.completionTokens === "number"
          ? usage.completionTokens
          : 0;
    totalTokens =
      typeof usage.totalTokens === "number" ? usage.totalTokens : inputTokens + outputTokens;
  } else {
    if (typeof payload.tokens === "number") totalTokens = payload.tokens;
    if (typeof metadata.tokens === "number") totalTokens = metadata.tokens;
    if (typeof payload.totalTokens === "number") totalTokens = payload.totalTokens;
    if (typeof metadata.totalTokens === "number") totalTokens = metadata.totalTokens;
  }

  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Detects if an event signifies a tool/command failure or error.
 */
function isErrorEvent(event: NormalizedSessionEvent): boolean {
  if (event.type === "error") return true;

  if (event.type === "tool_result") {
    const res = event as unknown as { isError?: boolean; status?: string };
    if (res.isError === true || res.status === "error" || res.status === "failed") return true;
  }

  if (event.type === "command_exec") {
    const cmd = event as unknown as { exitCode?: number };
    if (typeof cmd.exitCode === "number" && cmd.exitCode !== 0) return true;
  }

  return false;
}

/**
 * Checks if an event is an actionable workflow step.
 */
function isActionableStep(event: NormalizedSessionEvent): boolean {
  return (
    event.type === "tool_call" ||
    event.type === "command_exec" ||
    event.type === "file_edit" ||
    event.type === "subagent_lifecycle"
  );
}

/**
 * Workflow episode segmenter breaking normalized event streams into cohesive episodes.
 */
export class EpisodeSegmenter {
  private readonly idleGapThresholdMs: number;
  private readonly minEventsPerEpisode: number;
  private readonly maxEventsPerEpisode: number;

  constructor(options: SegmenterOptions = {}) {
    this.idleGapThresholdMs = options.idleGapThresholdMs ?? DEFAULT_IDLE_GAP_THRESHOLD_MS;
    this.minEventsPerEpisode = options.minEventsPerEpisode ?? DEFAULT_MIN_EVENTS;
    this.maxEventsPerEpisode = options.maxEventsPerEpisode ?? DEFAULT_MAX_EVENTS;
  }

  /**
   * Segments a chronological sequence of session events into distinct workflow episodes.
   */
  segmentEvents(events: NormalizedSessionEvent[]): Episode[] {
    if (!events || events.length === 0) {
      return [];
    }

    // Sort events by timestamp and sequence number if present
    const sorted = [...events].sort((a, b) => {
      const tsA = parseTimestampMs(a.timestamp);
      const tsB = parseTimestampMs(b.timestamp);
      if (tsA !== tsB) return tsA - tsB;
      const seqA = (a as unknown as { sequenceNum?: number }).sequenceNum ?? 0;
      const seqB = (b as unknown as { sequenceNum?: number }).sequenceNum ?? 0;
      return seqA - seqB;
    });

    const episodes: Episode[] = [];
    let currentBatch: NormalizedSessionEvent[] = [];
    let currentSessionId = sorted[0].sessionId;
    let currentBranchId = (sorted[0] as unknown as { branchId?: string }).branchId;
    let turnIndex = 0;

    const flushBatch = () => {
      if (currentBatch.length >= this.minEventsPerEpisode) {
        const episode = this.buildEpisode(
          currentBatch,
          currentSessionId,
          currentBranchId,
          turnIndex,
        );
        episodes.push(episode);
        turnIndex++;
      }
      currentBatch = [];
    };

    for (let i = 0; i < sorted.length; i++) {
      const evt = sorted[i];
      const prevEvt = sorted[i - 1];
      const evtBranchId = (evt as unknown as { branchId?: string }).branchId;

      // 1. Session Boundary
      if (evt.sessionId !== currentSessionId) {
        flushBatch();
        currentSessionId = evt.sessionId;
        currentBranchId = evtBranchId;
        turnIndex = 0;
      }
      // 2. Branch Boundary
      else if (evtBranchId && evtBranchId !== currentBranchId) {
        flushBatch();
        currentBranchId = evtBranchId;
      }
      // 3. User Turn Boundary (e.g. user_message or role="user")
      else if (
        this.isUserTurnBoundary(evt) &&
        currentBatch.length > 0 &&
        this.hasActionableContent(currentBatch)
      ) {
        flushBatch();
      }
      // 4. Idle Gap Boundary
      else if (prevEvt) {
        const gapMs = parseTimestampMs(evt.timestamp) - parseTimestampMs(prevEvt.timestamp);
        if (gapMs > this.idleGapThresholdMs && currentBatch.length > 0) {
          flushBatch();
        }
      }
      // 5. Max Events per Episode Boundary
      else if (currentBatch.length >= this.maxEventsPerEpisode) {
        flushBatch();
      }

      currentBatch.push(evt);

      // If event is a branch_fork or session completion, flush immediately after adding
      if (
        evt.type === "branch_fork" ||
        (evt.type === "session_lifecycle" && this.isTerminalLifecycle(evt))
      ) {
        flushBatch();
      }
    }

    flushBatch();
    return episodes;
  }

  /**
   * Checks if an event marks the start of a new user turn.
   */
  private isUserTurnBoundary(event: NormalizedSessionEvent): boolean {
    if (event.type === "message" && event.role === "user") {
      return true;
    }
    return false;
  }

  /**
   * Checks if an event is a terminal session lifecycle event.
   */
  private isTerminalLifecycle(event: NormalizedSessionEvent): boolean {
    const anyEvt = event as unknown as Record<string, unknown>;
    const payload = anyEvt.payload as Record<string, unknown> | undefined;
    const status = payload?.status ?? anyEvt.status;
    return (
      status === "completed" ||
      status === "aborted" ||
      status === "terminated" ||
      status === "failed"
    );
  }

  /**
   * Checks if the batch contains more than just a user message.
   */
  private hasActionableContent(batch: NormalizedSessionEvent[]): boolean {
    return batch.some(
      (e) =>
        isActionableStep(e) ||
        (e.type === "message" && e.role === "assistant") ||
        e.type === "tool_result",
    );
  }
  /**
   * Builds an Episode from a grouped batch of events.
   */
  private buildEpisode(
    events: NormalizedSessionEvent[],
    sessionId: string,
    branchId: string | undefined,
    turnIndex: number,
  ): Episode {
    const first = events[0];
    const last = events[events.length - 1];

    const startedAt = first.timestamp;
    const endedAt = last.timestamp;

    const startMs = parseTimestampMs(startedAt);
    const endMs = parseTimestampMs(endedAt);
    const wallDurationMs = Math.max(0, endMs - startMs);

    // Compute metrics
    let stepCount = 0;
    let totalTokens = 0;
    let hasErrors = false;
    let accumulatedToolDurationMs = 0;

    // Detect retries
    let retryCount = 0;
    const recentActions: string[] = [];

    for (const evt of events) {
      if (isActionableStep(evt)) {
        stepCount++;
        const actionKey = this.getActionKey(evt);
        if (actionKey) {
          // If the same action key failed recently and is being repeated
          if (recentActions.includes(actionKey)) {
            retryCount++;
          }
          recentActions.push(actionKey);
        }
      }

      if (isErrorEvent(evt)) {
        hasErrors = true;
      }

      const tokens = extractEventTokens(evt);
      totalTokens += tokens.totalTokens;

      // Extract duration if present on tool/command events
      const anyEvt = evt as unknown as { durationMs?: number; duration?: number };
      if (typeof anyEvt.durationMs === "number") {
        accumulatedToolDurationMs += anyEvt.durationMs;
      } else if (typeof anyEvt.duration === "number") {
        accumulatedToolDurationMs += anyEvt.duration;
      }
    }

    const totalDurationMs = Math.max(wallDurationMs, accumulatedToolDurationMs);

    // Estimated cost ($3 / 1M tokens as heuristic estimate)
    const estimatedCostUsd = Number(((totalTokens / 1_000_000) * 3.0).toFixed(6));

    const metrics: EpisodeMetrics = {
      stepCount,
      totalTokens,
      retryCount,
      estimatedCostUsd,
      totalDurationMs,
    };

    // Determine completion status
    const isCompleted = !this.hasTerminalFatalError(events);

    // Extract tenant context from first event
    const anyFirst = first as unknown as {
      accountId?: string;
      workspaceId?: string;
      metadata?: Record<string, unknown>;
    };
    const accountId =
      anyFirst.accountId || (anyFirst.metadata?.accountId as string) || "default-account";
    const workspaceId =
      anyFirst.workspaceId || (anyFirst.metadata?.workspaceId as string) || "default-workspace";

    // Generate deterministic episode ID
    const eventIdsDigest = hashCanonicalContent(events.map((e) => e.eventId)).slice(0, 12);
    const id = `ep_${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}_t${turnIndex}_${eventIdsDigest}`;

    return {
      id,
      sessionId,
      branchId,
      accountId,
      workspaceId,
      events,
      startedAt,
      endedAt,
      durationMs: totalDurationMs,
      turnIndex,
      isCompleted,
      hasErrors,
      metrics,
    };
  }

  /**
   * Extracts action key for tracking retries.
   */
  private getActionKey(event: NormalizedSessionEvent): string {
    const anyEvt = event as unknown as Record<string, unknown>;
    if (event.type === "tool_call") {
      const toolName =
        anyEvt.toolName || anyEvt.name || (anyEvt.payload as Record<string, unknown>)?.name;
      return `tool:${toolName}`;
    }
    if (event.type === "command_exec") {
      const cmd =
        (anyEvt.command as string) || (anyEvt.payload as Record<string, unknown>)?.command;
      return `cmd:${cmd}`;
    }
    return event.type;
  }

  /**
   * Checks if the episode suffered an unrecoverable terminal error.
   */
  private hasTerminalFatalError(events: NormalizedSessionEvent[]): boolean {
    const lastEvent = events[events.length - 1];
    if (lastEvent.type === "error") {
      const err = lastEvent as unknown as { isFatal?: boolean };
      return err.isFatal === true;
    }
    return false;
  }
}

/**
 * Convenience function to segment events.
 */
export function segmentSessionEvents(
  events: NormalizedSessionEvent[],
  options?: SegmenterOptions,
): Episode[] {
  const segmenter = new EpisodeSegmenter(options);
  return segmenter.segmentEvents(events);
}
