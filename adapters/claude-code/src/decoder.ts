import type {
  CausalRef,
  DiscoveredToolEntry,
  FileDiffStats,
  MessageContentPart,
  RedactionMeta,
} from "@tool-evolver/contracts";
import type { RawHarnessRecord } from "@tool-evolver/harness-contracts";
import type {
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  RecordDecoderContext,
} from "@tool-evolver/observer";

/**
 * Parses raw input payload into a structured JSON record object.
 */
function parseRawPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null ? parsed : { text: payload };
    } catch {
      return { text: payload };
    }
  }
  if (typeof payload === "object" && payload !== null) {
    return payload as Record<string, unknown>;
  }
  return null;
}

/**
 * Base helper to attach causalRef and common fields to intermediate events.
 */
function withBaseFields(
  event: Record<string, unknown>,
  sessionId: string,
  timestamp: string,
  causalSequence = 0,
): IntermediateSessionEvent {
  const finalSessionId =
    typeof event.sessionId === "string" && event.sessionId ? event.sessionId : sessionId;
  const finalTimestamp =
    typeof event.timestamp === "string" && event.timestamp ? event.timestamp : timestamp;

  return {
    ...event,
    sessionId: finalSessionId,
    timestamp: finalTimestamp,
    causalRef: { causalSequence },
  } as IntermediateSessionEvent;
}

/**
 * Decodes a Claude Code transcript line or JSON object into a list of intermediate events.
 */
export function decodeClaudeTranscriptLine(
  lineOrPayload: string | Record<string, unknown>,
  sessionId: string,
  sequenceNumber = 0,
  timestamp = new Date().toISOString(),
): IntermediateSessionEvent[] {
  const payload =
    typeof lineOrPayload === "string" ? parseRawPayload(lineOrPayload) : lineOrPayload;
  if (!payload) {
    return [
      withBaseFields(
        {
          type: "unknown_passthrough",
          rawEventType: "empty_payload",
          rawPayload: {},
        },
        sessionId,
        timestamp,
        sequenceNumber,
      ),
    ];
  }

  const recordTime =
    (typeof payload.timestamp === "string" ? payload.timestamp : timestamp) || timestamp;
  const events: IntermediateSessionEvent[] = [];

  // 1. If payload already matches a fully typed intermediate event
  if (
    (payload.type === "message" &&
      typeof payload.role === "string" &&
      typeof payload.content === "string") ||
    (payload.type === "model_reasoning" && typeof payload.thought === "string") ||
    (payload.type === "tool_call" &&
      typeof payload.toolCallId === "string" &&
      typeof payload.toolName === "string") ||
    (payload.type === "tool_result" && typeof payload.toolCallId === "string") ||
    (payload.type === "command_exec" && typeof payload.command === "string") ||
    (payload.type === "file_edit" &&
      typeof payload.filePath === "string" &&
      typeof payload.editType === "string") ||
    (payload.type === "error" &&
      typeof payload.errorCode === "string" &&
      typeof payload.fatal === "boolean") ||
    (payload.type === "compaction" &&
      typeof payload.originalTokenCount === "number" &&
      typeof payload.compactedTokenCount === "number") ||
    (payload.type === "branch_fork" && typeof payload.branchPointEventId === "string") ||
    (payload.type === "subagent_lifecycle" &&
      typeof payload.subagentId === "string" &&
      typeof payload.lifecycleType === "string") ||
    (payload.type === "session_lifecycle" && typeof payload.lifecycleType === "string")
  ) {
    events.push(withBaseFields(payload, sessionId, recordTime, sequenceNumber));
    return events;
  }

  const rawType = String(payload.type || payload.event || payload.role || "");

  // 2. Session Lifecycle Events
  if (rawType === "session_start" || rawType === "session_init" || rawType === "start") {
    events.push(
      withBaseFields(
        {
          type: "session_lifecycle",
          lifecycleType: "start",
          harnessName: String(payload.harness || "claude-code"),
          workspaceId: payload.workspaceId ? String(payload.workspaceId) : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  if (
    rawType === "session_end" ||
    rawType === "session_exit" ||
    rawType === "end" ||
    rawType === "exit"
  ) {
    events.push(
      withBaseFields(
        {
          type: "session_lifecycle",
          lifecycleType: "end",
          exitReason: payload.exitReason ? String(payload.exitReason) : "normal",
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 3. Subagent & Branch Events
  if (rawType === "subagent" || rawType === "subagent_spawn" || rawType === "subagent_lifecycle") {
    events.push(
      withBaseFields(
        {
          type: "subagent_lifecycle",
          subagentId: String(payload.subagentId || payload.id || "subagent-1"),
          lifecycleType:
            (payload.lifecycleType as
              | "spawn"
              | "start"
              | "pause"
              | "resume"
              | "terminate"
              | "settle") || "spawn",
          parentId: payload.parentId ? String(payload.parentId) : undefined,
          role: payload.role ? String(payload.role) : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  if (rawType === "branch_fork" || rawType === "fork") {
    events.push(
      withBaseFields(
        {
          type: "branch_fork",
          sourceSessionId: String(payload.sourceSessionId || sessionId),
          branchPointEventId: String(payload.branchPointEventId || "root"),
          forkReason: payload.forkReason ? String(payload.forkReason) : undefined,
          branchName: payload.branchName ? String(payload.branchName) : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 4. Compaction & Summarization Events
  if (
    rawType === "compaction" ||
    rawType === "context_compaction" ||
    rawType === "summary" ||
    payload.action === "compact"
  ) {
    events.push(
      withBaseFields(
        {
          type: "compaction",
          originalTokenCount: Number(payload.originalTokenCount || payload.originalTokens || 0),
          compactedTokenCount: Number(payload.compactedTokenCount || payload.compactedTokens || 0),
          summary: payload.summary
            ? String(payload.summary)
            : payload.text
              ? String(payload.text)
              : undefined,
          compactedRangeStart: payload.rangeStart ? String(payload.rangeStart) : undefined,
          compactedRangeEnd: payload.rangeEnd ? String(payload.rangeEnd) : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 5. Error Events
  if (rawType === "error" || rawType === "rate_limit" || payload.is_error === true) {
    events.push(
      withBaseFields(
        {
          type: "error",
          errorCode: String(payload.code || payload.errorCode || "CLAUDE_ERROR"),
          message: String(payload.message || payload.error || "Claude Code execution error"),
          fatal: Boolean(payload.fatal),
          details:
            typeof payload.details === "object" && payload.details !== null
              ? (payload.details as Record<string, unknown>)
              : undefined,
          stackTrace: payload.stack
            ? String(payload.stack)
            : payload.stackTrace
              ? String(payload.stackTrace)
              : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 6. User Messages & Tool Results
  if (rawType === "user" || rawType === "user_message" || payload.role === "user") {
    const rawContent =
      (payload.message as Record<string, unknown>)?.content ??
      payload.content ??
      payload.text ??
      "";

    if (typeof rawContent === "string") {
      events.push(
        withBaseFields(
          {
            type: "message",
            role: "user",
            content: rawContent,
            model: payload.model ? String(payload.model) : undefined,
          },
          sessionId,
          recordTime,
          sequenceNumber,
        ),
      );
    } else if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (typeof part === "object" && part !== null) {
          const block = part as Record<string, unknown>;
          if (block.type === "tool_result") {
            const toolCallId = String(block.tool_use_id || block.id || "tool-call-1");
            const toolName = String(block.tool_name || block.name || "unknown");
            const output = block.content ?? block.output ?? "";
            const isError = Boolean(block.is_error);

            events.push(
              withBaseFields(
                {
                  type: "tool_result",
                  toolCallId,
                  toolName,
                  output,
                  isError,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          } else if (block.type === "text" && typeof block.text === "string") {
            events.push(
              withBaseFields(
                {
                  type: "message",
                  role: "user",
                  content: block.text,
                  model: payload.model ? String(payload.model) : undefined,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          }
        }
      }
    }
    if (events.length > 0) return events;
  }

  // 7. Assistant Messages, Reasoning & Tool Calls
  if (rawType === "assistant" || rawType === "assistant_message" || payload.role === "assistant") {
    const rawContent =
      (payload.message as Record<string, unknown>)?.content ??
      payload.content ??
      payload.text ??
      "";

    if (typeof rawContent === "string") {
      events.push(
        withBaseFields(
          {
            type: "message",
            role: "assistant",
            content: rawContent,
            model: payload.model ? String(payload.model) : undefined,
          },
          sessionId,
          recordTime,
          sequenceNumber,
        ),
      );
    } else if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (typeof part === "object" && part !== null) {
          const block = part as Record<string, unknown>;

          if (block.type === "text" && typeof block.text === "string") {
            events.push(
              withBaseFields(
                {
                  type: "message",
                  role: "assistant",
                  content: block.text,
                  model: payload.model ? String(payload.model) : undefined,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          } else if (block.type === "thinking" || block.type === "thought") {
            const thought = String(block.thinking || block.thought || "");
            events.push(
              withBaseFields(
                {
                  type: "model_reasoning",
                  thought,
                  signature: block.signature ? String(block.signature) : undefined,
                  model: payload.model ? String(payload.model) : undefined,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          } else if (block.type === "tool_use") {
            const toolCallId = String(block.id || `call_${sequenceNumber}`);
            const toolName = String(block.name || "unknown");
            const input = (
              typeof block.input === "object" && block.input !== null ? block.input : {}
            ) as Record<string, unknown>;

            events.push(
              withBaseFields(
                {
                  type: "tool_call",
                  toolCallId,
                  toolName,
                  input,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );

            // Specialization for Bash command tool
            if (toolName.toLowerCase() === "bash" && typeof input.command === "string") {
              events.push(
                withBaseFields(
                  {
                    type: "command_exec",
                    command: input.command,
                    workingDirectory: typeof input.cwd === "string" ? input.cwd : undefined,
                    metadata: { toolCallId },
                  },
                  sessionId,
                  recordTime,
                  sequenceNumber,
                ),
              );
            }

            // Specialization for Edit/Write tools
            const lowerName = toolName.toLowerCase();
            if (
              [
                "edit",
                "write",
                "file_edit",
                "file_editor",
                "str_replace_editor",
                "strreplaceeditor",
                "multiedit",
              ].includes(lowerName)
            ) {
              const filePath = String(input.file_path || input.path || "unknown");
              let editType: "create" | "modify" | "delete" | "rename" = "modify";
              if (
                lowerName === "write" ||
                input.command === "create" ||
                input.command === "write"
              ) {
                editType = "create";
              } else if (input.command === "delete") {
                editType = "delete";
              } else if (input.command === "rename") {
                editType = "rename";
              }

              let diff: string | undefined;
              if (typeof input.diff === "string") {
                diff = input.diff;
              } else if (input.old_str !== undefined && input.new_str !== undefined) {
                diff = `--- old\n+++ new\n@@ -1 +1 @@\n-${String(input.old_str)}\n+${String(input.new_str)}`;
              }

              events.push(
                withBaseFields(
                  {
                    type: "file_edit",
                    filePath,
                    editType,
                    diff,
                    oldPath: input.old_path ? String(input.old_path) : undefined,
                    metadata: { toolCallId },
                  },
                  sessionId,
                  recordTime,
                  sequenceNumber,
                ),
              );
            }
          }
        }
      }
    }
    if (events.length > 0) return events;
  }

  // 8. Standalone Tool Use & Result Records
  if (rawType === "tool_use") {
    const toolCallId = String(payload.id || `call_${sequenceNumber}`);
    const toolName = String(payload.name || "unknown");
    const input = (
      typeof payload.input === "object" && payload.input !== null ? payload.input : {}
    ) as Record<string, unknown>;

    events.push(
      withBaseFields(
        {
          type: "tool_call",
          toolCallId,
          toolName,
          input,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );

    if (toolName.toLowerCase() === "bash" && typeof input.command === "string") {
      events.push(
        withBaseFields(
          {
            type: "command_exec",
            command: input.command,
            workingDirectory: typeof input.cwd === "string" ? input.cwd : undefined,
            metadata: { toolCallId },
          },
          sessionId,
          recordTime,
          sequenceNumber,
        ),
      );
    }
    return events;
  }

  if (rawType === "tool_result") {
    events.push(
      withBaseFields(
        {
          type: "tool_result",
          toolCallId: String(payload.tool_use_id || payload.id || "tool-call-1"),
          toolName: String(payload.name || payload.tool_name || "unknown"),
          output: payload.content ?? payload.output ?? "",
          isError: Boolean(payload.is_error),
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 9. Passthrough for Unrecognized Events
  events.push(
    withBaseFields(
      {
        type: "unknown_passthrough",
        rawEventType: rawType || "unknown",
        rawPayload: payload,
      },
      sessionId,
      recordTime,
      sequenceNumber,
    ),
  );

  return events;
}

/**
 * HarnessRecordDecoder implementation for Claude Code JSONL transcripts.
 */
export class ClaudeRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "claude-code";
  readonly decoderVersion = "1.0.0";

  canDecode(record: RawHarnessRecord): boolean {
    return record.harnessId === "claude-code" || record.harnessId === "claude";
  }

  decode(record: RawHarnessRecord, context?: RecordDecoderContext): IntermediateSessionEvent[] {
    const sessionId = record.sessionId || context?.sessionId || "session-1";
    const sequenceNumber = record.sequenceNumber ?? record.cursor?.sequence ?? 0;
    const timestamp = record.timestamp || new Date().toISOString();

    return decodeClaudeTranscriptLine(
      record.rawPayload as string | Record<string, unknown>,
      sessionId,
      sequenceNumber,
      timestamp,
    );
  }
}
