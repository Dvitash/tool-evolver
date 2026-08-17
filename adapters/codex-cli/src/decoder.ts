import { randomUUID } from "node:crypto";
import type {
  DiscoveredToolEntry,
  FileDiffStats,
  MessageContentPart,
  NormalizedBranchForkEvent,
  NormalizedCommandExecEvent,
  NormalizedCompactionEvent,
  NormalizedErrorEvent,
  NormalizedFileEditEvent,
  NormalizedMessageEvent,
  NormalizedModelReasoningEvent,
  NormalizedSessionEvent,
  NormalizedSessionLifecycleEvent,
  NormalizedSubagentLifecycleEvent,
  NormalizedToolCallEvent,
  NormalizedToolDiscoveryEvent,
  NormalizedToolResultEvent,
  NormalizedUnknownPassthroughEvent,
  RedactionMeta,
} from "@tool-evolver/contracts";

export const DEFAULT_SCHEMA_VERSION = "1.0.0";

const DEFAULT_REDACTION: RedactionMeta = {
  isRedacted: false,
  redactedFields: [],
  redactionStrategy: "none",
  scrubbedPatterns: [],
};

/**
 * Options for configuring the Codex session decoder.
 */
export interface CodexDecoderOptions {
  sessionId?: string;
  initialSequence?: number;
  workspaceId?: string;
}

/**
 * Normalizes ISO timestamps or defaults to current time.
 */
function normalizeTimestamp(ts: unknown): string {
  if (typeof ts === "string") {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  } else if (typeof ts === "number") {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * Generates an event ID if one is not present.
 */
function generateEventId(prefix = "evt"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Normalizes raw tool parameters from string or object.
 */
function parseParameters(rawParams: unknown): Record<string, unknown> {
  if (typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)) {
    return rawParams as Record<string, unknown>;
  }
  if (typeof rawParams === "string") {
    try {
      const parsed = JSON.parse(rawParams) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: rawParams };
    }
  }
  return {};
}

/**
 * State-preserving decoder for Codex CLI session rollouts and JSONL transcripts.
 */
export class CodexSessionDecoder {
  private sessionId: string;
  private sequence: number;
  private lastEventId?: string;
  private readonly callMap = new Map<string, { toolName: string; timestamp: string }>();
  private readonly workspaceId?: string;

  constructor(options?: CodexDecoderOptions) {
    this.sessionId = options?.sessionId ?? `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.sequence = options?.initialSequence ?? 1;
    this.workspaceId = options?.workspaceId;
  }

  /**
   * Resets decoder state or re-initializes with new session.
   */
  reset(options?: CodexDecoderOptions): void {
    if (options?.sessionId) {
      this.sessionId = options.sessionId;
    }
    this.sequence = options?.initialSequence ?? 1;
    this.lastEventId = undefined;
    this.callMap.clear();
  }

  /**
   * Returns the current session ID being tracked.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Sets or updates the active session ID.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  private nextHeader(rawTimestamp?: unknown, rawEventId?: unknown) {
    const causalSequence = this.sequence++;
    const eventId =
      typeof rawEventId === "string" && rawEventId.length > 0
        ? rawEventId
        : generateEventId(`evt_${causalSequence}`);
    const timestamp = normalizeTimestamp(rawTimestamp);
    const parentId = this.lastEventId;
    this.lastEventId = eventId;

    return {
      eventId,
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      sessionId: this.sessionId,
      timestamp,
      causalRef: {
        causalSequence,
        parentId,
      },
      redaction: DEFAULT_REDACTION,
    };
  }

  /**
   * Decodes a single raw record or parsed object into zero or more NormalizedSessionEvents.
   */
  decodeRecord(raw: string | Record<string, unknown>): NormalizedSessionEvent[] {
    let payload: Record<string, unknown>;

    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      try {
        payload = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Unparseable JSON line -> return unknown passthrough event
        const header = this.nextHeader();
        const unknownEvt: NormalizedUnknownPassthroughEvent = {
          ...header,
          type: "unknown_passthrough",
          rawEventType: "unparseable_line",
          rawPayload: { line: raw },
        };
        return [unknownEvt];
      }
    } else if (typeof raw === "object" && raw !== null) {
      payload = raw;
    } else {
      return [];
    }

    return this.normalizePayload(payload);
  }

  /**
   * Decodes an entire transcript or batch of lines into NormalizedSessionEvents.
   */
  decodeTranscript(
    transcript: string | Array<string | Record<string, unknown>>,
  ): NormalizedSessionEvent[] {
    const events: NormalizedSessionEvent[] = [];

    if (typeof transcript === "string") {
      const lines = transcript.split(/\r?\n/);
      for (const line of lines) {
        events.push(...this.decodeRecord(line));
      }
    } else if (Array.isArray(transcript)) {
      for (const item of transcript) {
        events.push(...this.decodeRecord(item));
      }
    }

    return events;
  }

  private normalizePayload(p: Record<string, unknown>): NormalizedSessionEvent[] {
    const rawType = String(p.type || p.event || p.role || "").toLowerCase();
    const timestamp = p.timestamp || p.created_at || p.createdAt || p.time;
    const rawEventId = p.eventId || p.event_id || p.id;

    // Detect session ID override if embedded
    if (typeof p.sessionId === "string") {
      this.sessionId = p.sessionId;
    } else if (typeof p.session_id === "string") {
      this.sessionId = p.session_id;
    }

    // 1. Session Lifecycle
    if (
      rawType === "session_lifecycle" ||
      rawType === "session_start" ||
      rawType === "session_end" ||
      rawType === "session_pause" ||
      rawType === "session_resume" ||
      rawType === "session_crash"
    ) {
      const lifecycleType = (p.lifecycleType ||
        (rawType === "session_start"
          ? "start"
          : rawType === "session_end"
            ? "end"
            : rawType === "session_pause"
              ? "pause"
              : rawType === "session_resume"
                ? "resume"
                : rawType === "session_crash"
                  ? "crash"
                  : "start")) as "start" | "pause" | "resume" | "end" | "crash";

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedSessionLifecycleEvent = {
        ...header,
        type: "session_lifecycle",
        lifecycleType,
        exitReason:
          typeof p.exitReason === "string"
            ? p.exitReason
            : typeof p.reason === "string"
              ? p.reason
              : undefined,
        harnessName: typeof p.harnessName === "string" ? p.harnessName : "codex-cli",
        workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : this.workspaceId,
      };
      return [evt];
    }

    // 2. Model Reasoning / Thought
    if (
      rawType === "model_reasoning" ||
      rawType === "reasoning" ||
      rawType === "thought" ||
      rawType === "chain_of_thought"
    ) {
      const header = this.nextHeader(timestamp, rawEventId);
      const content =
        typeof p.reasoningContent === "string"
          ? p.reasoningContent
          : typeof p.content === "string"
            ? p.content
            : typeof p.text === "string"
              ? p.text
              : JSON.stringify(p);

      const evt: NormalizedModelReasoningEvent = {
        ...header,
        type: "model_reasoning",
        reasoningContent: content,
        signature: typeof p.signature === "string" ? p.signature : undefined,
        tokenCount: typeof p.tokenCount === "number" ? p.tokenCount : undefined,
        model: typeof p.model === "string" ? p.model : undefined,
        durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined,
      };
      return [evt];
    }

    // 3. User Message
    if (rawType === "user_message" || rawType === "user" || rawType === "user_turn") {
      const header = this.nextHeader(timestamp, rawEventId);
      let content = "";
      let contentParts: MessageContentPart[] | undefined;

      if (typeof p.content === "string") {
        content = p.content;
      } else if (typeof p.text === "string") {
        content = p.text;
      } else if (Array.isArray(p.content)) {
        contentParts = p.content as MessageContentPart[];
        content = (p.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
      } else if (typeof p.message === "object" && p.message !== null) {
        const msg = p.message as Record<string, unknown>;
        content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg);
      } else {
        content = JSON.stringify(p);
      }

      const evt: NormalizedMessageEvent = {
        ...header,
        type: "message",
        role: "user",
        content,
        contentParts,
        model: typeof p.model === "string" ? p.model : undefined,
      };
      return [evt];
    }

    // 4. Assistant Message
    if (rawType === "assistant_message" || rawType === "assistant" || rawType === "agent_turn") {
      const events: NormalizedSessionEvent[] = [];

      // Check if there is reasoning attached
      if (typeof p.reasoning === "string" && p.reasoning.length > 0) {
        const rHeader = this.nextHeader(timestamp);
        events.push({
          ...rHeader,
          type: "model_reasoning",
          reasoningContent: p.reasoning,
          model: typeof p.model === "string" ? p.model : undefined,
        });
      }

      let content = "";
      let contentParts: MessageContentPart[] | undefined;

      if (typeof p.content === "string") {
        content = p.content;
      } else if (typeof p.text === "string") {
        content = p.text;
      } else if (Array.isArray(p.content)) {
        contentParts = p.content as MessageContentPart[];
        content = (p.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
      } else if (typeof p.message === "object" && p.message !== null) {
        const msg = p.message as Record<string, unknown>;
        content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg);
      }

      // Check for inline tool_calls array
      const toolCalls = Array.isArray(p.tool_calls)
        ? p.tool_calls
        : Array.isArray(p.toolCalls)
          ? p.toolCalls
          : undefined;

      if (content || !toolCalls || toolCalls.length === 0) {
        const header = this.nextHeader(timestamp, rawEventId);
        events.push({
          ...header,
          type: "message",
          role: "assistant",
          content,
          contentParts,
          model: typeof p.model === "string" ? p.model : undefined,
        });
      }

      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls as Array<Record<string, unknown>>) {
          const callId = String(tc.id || tc.call_id || generateEventId("call"));
          const fn = (
            typeof tc.function === "object" && tc.function !== null ? tc.function : tc
          ) as Record<string, unknown>;
          const toolName = String(fn.name || fn.tool_name || tc.name || "unknown_tool");
          const params = parseParameters(fn.arguments || tc.parameters || tc.input);

          this.callMap.set(callId, {
            toolName,
            timestamp: normalizeTimestamp(timestamp),
          });

          const callHeader = this.nextHeader(timestamp);
          events.push({
            ...callHeader,
            type: "tool_call",
            callId,
            toolName,
            parameters: params,
            isShadow: Boolean(tc.isShadow),
          });
        }
      }

      return events;
    }

    // 5. Tool Call / Function Call
    if (
      rawType === "tool_call" ||
      rawType === "function_call" ||
      rawType === "mcp_call" ||
      rawType === "call"
    ) {
      const callId = String(p.callId || p.call_id || p.id || generateEventId("call"));
      const toolName = String(
        p.toolName ||
          p.tool_name ||
          p.name ||
          p.function_name ||
          (p.function && (p.function as Record<string, unknown>).name) ||
          "unknown_tool",
      );
      const params = parseParameters(
        p.parameters ||
          p.arguments ||
          p.args ||
          p.input ||
          (p.function && (p.function as Record<string, unknown>).arguments),
      );

      this.callMap.set(callId, {
        toolName,
        timestamp: normalizeTimestamp(timestamp),
      });

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedToolCallEvent = {
        ...header,
        type: "tool_call",
        callId,
        toolName,
        parameters: params,
        candidateRef: typeof p.candidateRef === "string" ? p.candidateRef : undefined,
        isShadow: Boolean(p.isShadow),
      };
      return [evt];
    }

    // 6. Tool Result / Function Response
    if (
      rawType === "tool_result" ||
      rawType === "function_response" ||
      rawType === "tool_response" ||
      rawType === "mcp_result" ||
      rawType === "tool"
    ) {
      const callId = String(
        p.callId || p.call_id || p.tool_call_id || p.id || generateEventId("call"),
      );
      const cached = this.callMap.get(callId);
      const toolName = String(
        p.toolName || p.tool_name || p.name || cached?.toolName || "unknown_tool",
      );

      const result =
        p.result !== undefined ? p.result : p.output !== undefined ? p.output : p.content;
      const isError = Boolean(p.isError || p.is_error || p.error);
      const durationMs =
        typeof p.executionDurationMs === "number"
          ? p.executionDurationMs
          : typeof p.durationMs === "number"
            ? p.durationMs
            : typeof p.duration_ms === "number"
              ? p.duration_ms
              : 0;

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedToolResultEvent = {
        ...header,
        type: "tool_result",
        callId,
        toolName,
        result,
        isError,
        executionDurationMs: Math.max(0, durationMs),
        outputSizeBytes:
          typeof p.outputSizeBytes === "number"
            ? p.outputSizeBytes
            : typeof result === "string"
              ? Buffer.byteLength(result, "utf8")
              : undefined,
        isShadow: Boolean(p.isShadow),
      };
      return [evt];
    }

    // 7. Shell Command Execution
    if (
      rawType === "command_exec" ||
      rawType === "exec" ||
      rawType === "shell_command" ||
      rawType === "bash" ||
      rawType === "terminal"
    ) {
      const command = String(p.command || p.cmd || "");
      const args = Array.isArray(p.args) ? (p.args as string[]) : [];
      const exitCode =
        typeof p.exitCode === "number"
          ? p.exitCode
          : typeof p.exit_code === "number"
            ? p.exit_code
            : 0;
      const stdout =
        typeof p.stdout === "string"
          ? p.stdout
          : typeof p.output === "string"
            ? p.output
            : undefined;
      const stderr = typeof p.stderr === "string" ? p.stderr : undefined;
      const durationMs =
        typeof p.durationMs === "number"
          ? p.durationMs
          : typeof p.duration_ms === "number"
            ? p.duration_ms
            : 0;

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedCommandExecEvent = {
        ...header,
        type: "command_exec",
        command,
        args,
        cwd:
          typeof p.cwd === "string"
            ? p.cwd
            : typeof p.workingDirectory === "string"
              ? p.workingDirectory
              : undefined,
        exitCode,
        stdout,
        stderr,
        durationMs: Math.max(0, durationMs),
      };
      return [evt];
    }

    // 8. File Edit
    if (
      rawType === "file_edit" ||
      rawType === "file_mutation" ||
      rawType === "edit_file" ||
      rawType === "write_file"
    ) {
      const filePath = String(p.filePath || p.file_path || p.path || "unknown_file");
      const operation = (p.operation ||
        p.action ||
        (rawType === "write_file" ? "create" : "update")) as
        | "create"
        | "update"
        | "delete"
        | "patch";

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedFileEditEvent = {
        ...header,
        type: "file_edit",
        filePath,
        operation: ["create", "update", "delete", "patch"].includes(operation)
          ? operation
          : "update",
        patch: typeof p.patch === "string" ? p.patch : undefined,
        beforeHash: typeof p.beforeHash === "string" ? p.beforeHash : undefined,
        afterHash: typeof p.afterHash === "string" ? p.afterHash : undefined,
        diffStats:
          typeof p.diffStats === "object" && p.diffStats !== null
            ? (p.diffStats as FileDiffStats)
            : undefined,
      };
      return [evt];
    }

    // 9. Context Compaction
    if (
      rawType === "compaction" ||
      rawType === "context_compaction" ||
      rawType === "truncate_context"
    ) {
      const triggerReason = (p.triggerReason || p.trigger_reason || "context_limit") as
        | "context_limit"
        | "manual"
        | "scheduled"
        | "turn_threshold";

      const tokensBefore =
        typeof p.tokensBefore === "number"
          ? p.tokensBefore
          : typeof p.tokens_before === "number"
            ? p.tokens_before
            : 0;

      const tokensAfter =
        typeof p.tokensAfter === "number"
          ? p.tokensAfter
          : typeof p.tokens_after === "number"
            ? p.tokens_after
            : 0;

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedCompactionEvent = {
        ...header,
        type: "compaction",
        triggerReason: ["context_limit", "manual", "scheduled", "turn_threshold"].includes(
          triggerReason,
        )
          ? triggerReason
          : "context_limit",
        tokensBefore,
        tokensAfter,
        preservedContextSummary:
          typeof p.preservedContextSummary === "string"
            ? p.preservedContextSummary
            : typeof p.summary === "string"
              ? p.summary
              : undefined,
      };
      return [evt];
    }

    // 10. Branch Fork
    if (rawType === "branch_fork" || rawType === "fork" || rawType === "session_branch") {
      const sourceSessionId = String(
        p.sourceSessionId || p.source_session_id || p.parentSessionId || this.sessionId,
      );
      const branchPointEventId = String(
        p.branchPointEventId ||
          p.branch_point_event_id ||
          p.forkPoint ||
          p.branchPoint ||
          "evt_root",
      );

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedBranchForkEvent = {
        ...header,
        type: "branch_fork",
        sourceSessionId,
        branchPointEventId,
        forkReason: typeof p.forkReason === "string" ? p.forkReason : undefined,
        branchName: typeof p.branchName === "string" ? p.branchName : undefined,
      };
      return [evt];
    }

    // 11. Subagent Lifecycle
    if (
      rawType === "subagent_lifecycle" ||
      rawType === "subagent_spawn" ||
      rawType === "subagent_start" ||
      rawType === "subagent_terminate"
    ) {
      const subagentId = String(
        p.subagentId || p.subagent_id || p.agentId || generateEventId("sub"),
      );
      const lifecycleType = (p.lifecycleType ||
        (rawType === "subagent_spawn"
          ? "spawn"
          : rawType === "subagent_start"
            ? "start"
            : rawType === "subagent_terminate"
              ? "terminate"
              : "spawn")) as "spawn" | "start" | "pause" | "resume" | "terminate" | "settle";

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedSubagentLifecycleEvent = {
        ...header,
        type: "subagent_lifecycle",
        subagentId,
        lifecycleType: ["spawn", "start", "pause", "resume", "terminate", "settle"].includes(
          lifecycleType,
        )
          ? lifecycleType
          : "spawn",
        parentId: typeof p.parentId === "string" ? p.parentId : this.sessionId,
        role: typeof p.role === "string" ? p.role : undefined,
        reason: typeof p.reason === "string" ? p.reason : undefined,
      };
      return [evt];
    }

    // 12. Tool Discovery
    if (rawType === "tool_discovery" || rawType === "tools_manifest" || rawType === "tools_list") {
      const rawTools = Array.isArray(p.tools) ? (p.tools as DiscoveredToolEntry[]) : [];
      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedToolDiscoveryEvent = {
        ...header,
        type: "tool_discovery",
        tools: rawTools,
        provider: typeof p.provider === "string" ? p.provider : undefined,
        source: (p.source as "mcp" | "builtin" | "dynamic" | "harness") || "mcp",
      };
      return [evt];
    }

    // 13. Error Event
    if (rawType === "error" || (p.error && typeof p.error === "object")) {
      const errorObj =
        typeof p.error === "object" && p.error !== null ? (p.error as Record<string, unknown>) : p;

      const errorType = String(
        errorObj.errorType || errorObj.type || errorObj.name || "RuntimeError",
      );
      const message = String(errorObj.message || errorObj.msg || "Unknown error occurred");
      const stack = typeof errorObj.stack === "string" ? errorObj.stack : undefined;
      const recoverable = Boolean(errorObj.recoverable ?? false);

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedErrorEvent = {
        ...header,
        type: "error",
        errorType,
        message,
        stack,
        recoverable,
        details:
          typeof errorObj.details === "object" && errorObj.details !== null
            ? (errorObj.details as Record<string, unknown>)
            : undefined,
      };
      return [evt];
    }

    // 14. Unknown Passthrough Fallback
    const header = this.nextHeader(timestamp, rawEventId);
    const unknownEvt: NormalizedUnknownPassthroughEvent = {
      ...header,
      type: "unknown_passthrough",
      rawEventType: rawType || "unknown",
      rawPayload: p,
    };
    return [unknownEvt];
  }
}

/**
 * Convenience function to decode a single Codex rollout record.
 */
export function decodeCodexRecord(
  raw: string | Record<string, unknown>,
  options?: CodexDecoderOptions,
): NormalizedSessionEvent[] {
  const decoder = new CodexSessionDecoder(options);
  return decoder.decodeRecord(raw);
}

/**
 * Convenience function to decode an entire transcript or file content.
 */
export function decodeCodexTranscript(
  transcript: string | Array<string | Record<string, unknown>>,
  options?: CodexDecoderOptions,
): NormalizedSessionEvent[] {
  const decoder = new CodexSessionDecoder(options);
  return decoder.decodeTranscript(transcript);
}
