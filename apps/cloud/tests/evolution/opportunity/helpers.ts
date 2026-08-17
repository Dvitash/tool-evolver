import {
  NormalizedCommandExecEvent,
  NormalizedErrorEvent,
  NormalizedFileEditEvent,
  NormalizedMessageEvent,
  NormalizedSessionEvent,
  NormalizedToolCallEvent,
  NormalizedToolResultEvent,
} from "@tool-evolver/contracts";

export function createMessageEvent(options: {
  eventId: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  causalSequence?: number;
}): NormalizedMessageEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "message",
    role: options.role,
    content: options.content,
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 1,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createToolCallEvent(options: {
  eventId: string;
  sessionId: string;
  toolName: string;
  parameters?: Record<string, unknown>;
  timestamp?: string;
  causalSequence?: number;
}): NormalizedToolCallEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "tool_call",
    toolName: options.toolName,
    parameters: options.parameters ?? {},
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 2,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createToolResultEvent(options: {
  eventId: string;
  sessionId: string;
  toolCallId: string;
  result: unknown;
  isError?: boolean;
  timestamp?: string;
  durationMs?: number;
  causalSequence?: number;
}): NormalizedToolResultEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "tool_result",
    toolCallId: options.toolCallId,
    result: options.result,
    isError: options.isError ?? false,
    durationMs: options.durationMs ?? 100,
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 3,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createCommandExecEvent(options: {
  eventId: string;
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  timestamp?: string;
  causalSequence?: number;
}): NormalizedCommandExecEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "command_exec",
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd,
    exitCode: options.exitCode ?? 0,
    durationMs: options.durationMs ?? 200,
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 4,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createFileEditEvent(options: {
  eventId: string;
  sessionId: string;
  filePath: string;
  operation?: "create" | "update" | "delete" | "patch";
  timestamp?: string;
  causalSequence?: number;
}): NormalizedFileEditEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "file_edit",
    filePath: options.filePath,
    operation: options.operation ?? "update",
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 5,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}

export function createErrorEvent(options: {
  eventId: string;
  sessionId: string;
  message: string;
  code?: string;
  isFatal?: boolean;
  timestamp?: string;
  causalSequence?: number;
}): NormalizedErrorEvent {
  return {
    eventId: options.eventId,
    sessionId: options.sessionId,
    type: "error",
    message: options.message,
    code: options.code ?? "EXEC_ERROR",
    isFatal: options.isFatal ?? false,
    schemaVersion: "1.0.0",
    timestamp: options.timestamp ?? new Date().toISOString(),
    causalRef: {
      causalSequence: options.causalSequence ?? 6,
    },
    redaction: { isRedacted: false, rulesApplied: [] },
  };
}
