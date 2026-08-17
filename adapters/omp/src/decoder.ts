import type {
  DiscoveredToolEntry,
  FileDiffStats,
  MessageContentPart,
} from "@tool-evolver/contracts";
import type { RawHarnessRecord } from "@tool-evolver/harness-contracts";
import type {
  HarnessRecordDecoder,
  IntermediateBranchForkEvent,
  IntermediateCommandExecEvent,
  IntermediateCompactionEvent,
  IntermediateErrorEvent,
  IntermediateFileEditEvent,
  IntermediateMessageEvent,
  IntermediateModelReasoningEvent,
  IntermediateSessionEvent,
  IntermediateSessionLifecycleEvent,
  IntermediateSubagentLifecycleEvent,
  IntermediateToolCallEvent,
  IntermediateToolDiscoveryEvent,
  IntermediateToolResultEvent,
  IntermediateUnknownPassthroughEvent,
  RecordDecoderContext,
} from "@tool-evolver/observer";

/**
 * Decoder mapping Oh My Pi raw records and JSONL log lines to typed intermediate session events.
 */
export class OmpRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "omp";
  readonly decoderVersion = "1.0.0";

  canDecode(record: RawHarnessRecord): boolean {
    if (!record) {
      return false;
    }
    if (record.harnessId === "omp" || record.harnessId === "*") {
      return true;
    }

    // Try inspecting payload structure
    const payload = this.extractPayload(record);
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const rec = payload as Record<string, unknown>;
    return (
      rec.harness === "omp" ||
      rec.harnessName === "omp" ||
      typeof rec.type === "string" ||
      typeof rec.event === "string" ||
      typeof rec.role === "string"
    );
  }

  decode(
    record: RawHarnessRecord,
    context?: RecordDecoderContext,
  ): IntermediateSessionEvent | IntermediateSessionEvent[] | null {
    if (!record) {
      return null;
    }

    const payload = this.extractPayload(record);
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const obj = payload as Record<string, unknown>;
    const sessionId = String(
      obj.sessionId ?? obj.session_id ?? record.sessionId ?? context?.sessionId ?? "omp-session",
    );

    const timestamp = String(
      obj.timestamp ?? obj.time ?? obj.ts ?? record.timestamp ?? new Date().toISOString(),
    );

    const causalRef = {
      parentEventId: (obj.parentEventId ?? obj.parent_event_id ?? context?.parentEventId) as
        | string
        | undefined,
      causalSequence: (obj.causalSequence ?? obj.seq ?? context?.lastCausalSequence) as
        | number
        | undefined,
    };

    const metadata: Record<string, unknown> = {
      ...(typeof obj.metadata === "object" && obj.metadata !== null
        ? (obj.metadata as Record<string, unknown>)
        : {}),
      ...(record.metadata ?? {}),
      rawType: obj.type ?? obj.event ?? obj.kind,
    };

    const eventType = String(obj.type ?? obj.event ?? obj.kind ?? "").toLowerCase();

    // 1. Messages (user, assistant, system, tool)
    if (
      eventType === "message" ||
      eventType === "user_message" ||
      eventType === "assistant_message" ||
      eventType === "system_message" ||
      (typeof obj.role === "string" && typeof obj.content !== "undefined")
    ) {
      return this.decodeMessage(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 2. Model Reasoning / Thoughts
    if (
      eventType === "model_reasoning" ||
      eventType === "reasoning" ||
      eventType === "thought" ||
      eventType === "thinking"
    ) {
      return this.decodeReasoning(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 3. Tool Calls
    if (
      eventType === "tool_call" ||
      eventType === "tool_use" ||
      eventType === "tool_invocation" ||
      eventType === "call" ||
      (typeof obj.toolCall === "object" && obj.toolCall !== null) ||
      (typeof obj.tool_call === "object" && obj.tool_call !== null)
    ) {
      return this.decodeToolCall(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 4. Tool Results
    if (
      eventType === "tool_result" ||
      eventType === "tool_response" ||
      eventType === "tool_output" ||
      eventType === "result" ||
      (typeof obj.toolResult === "object" && obj.toolResult !== null) ||
      (typeof obj.tool_result === "object" && obj.tool_result !== null)
    ) {
      return this.decodeToolResult(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 5. Command Executions (bash / exec / command)
    if (
      eventType === "command_exec" ||
      eventType === "command" ||
      eventType === "bash" ||
      eventType === "exec" ||
      eventType === "shell"
    ) {
      return this.decodeCommandExec(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 6. File Edits (edit / patch / write / file_edit)
    if (
      eventType === "file_edit" ||
      eventType === "edit" ||
      eventType === "file_write" ||
      eventType === "write" ||
      eventType === "patch"
    ) {
      return this.decodeFileEdit(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 7. Subagent Lifecycle (spawn / delegate / settle / terminate)
    if (
      eventType === "subagent_lifecycle" ||
      eventType === "subagent" ||
      eventType === "task" ||
      eventType === "task_spawn" ||
      eventType === "delegate" ||
      eventType === "subagent_spawn"
    ) {
      return this.decodeSubagentLifecycle(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 8. Context Compaction (compaction / summarize)
    if (
      eventType === "compaction" ||
      eventType === "context_compaction" ||
      eventType === "summarize" ||
      eventType === "context_compact"
    ) {
      return this.decodeCompaction(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 9. Branch Fork
    if (
      eventType === "branch_fork" ||
      eventType === "branch" ||
      eventType === "fork" ||
      eventType === "session_fork"
    ) {
      return this.decodeBranchFork(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 10. Errors
    if (
      eventType === "error" ||
      eventType === "exception" ||
      eventType === "fault" ||
      eventType === "crash"
    ) {
      return this.decodeError(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 11. Session Lifecycle
    if (
      eventType === "session_lifecycle" ||
      eventType === "lifecycle" ||
      eventType === "session_start" ||
      eventType === "session_end"
    ) {
      return this.decodeSessionLifecycle(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 12. Tool Discovery
    if (
      eventType === "tool_discovery" ||
      eventType === "discovery" ||
      eventType === "tools_discovered"
    ) {
      return this.decodeToolDiscovery(obj, sessionId, timestamp, causalRef, metadata);
    }

    // Fallback passthrough
    const fallback: IntermediateUnknownPassthroughEvent = {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "unknown_passthrough",
      rawEventType: eventType || "unknown",
      rawPayload: obj,
    };
    return fallback;
  }

  private extractPayload(record: RawHarnessRecord): unknown {
    if (typeof record.rawPayload === "string") {
      try {
        return JSON.parse(record.rawPayload);
      } catch {
        return { text: record.rawPayload };
      }
    }
    return record.rawPayload;
  }

  private decodeMessage(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateMessageEvent {
    let role: "user" | "assistant" | "system" | "tool" = "user";
    const rawRole = String(obj.role ?? "").toLowerCase();
    if (rawRole === "assistant" || rawRole === "model") {
      role = "assistant";
    } else if (rawRole === "system") {
      role = "system";
    } else if (rawRole === "tool" || rawRole === "tool_response") {
      role = "tool";
    }

    let content = "";
    let contentParts: MessageContentPart[] | undefined;

    if (typeof obj.content === "string") {
      content = obj.content;
    } else if (Array.isArray(obj.content)) {
      contentParts = obj.content as MessageContentPart[];
      content = obj.content
        .map((part) =>
          typeof part === "string" ? part : (part?.text ?? part?.content ?? JSON.stringify(part)),
        )
        .join("\n");
    } else if (typeof obj.text === "string") {
      content = obj.text;
    } else if (typeof obj.message === "string") {
      content = obj.message;
    } else if (typeof obj.content !== "undefined") {
      content = JSON.stringify(obj.content);
    }

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "message",
      role,
      content,
      contentParts,
      model: typeof obj.model === "string" ? obj.model : undefined,
    };
  }

  private decodeReasoning(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateModelReasoningEvent {
    const reasoningContent = String(
      obj.reasoningContent ?? obj.reasoning_content ?? obj.thought ?? obj.text ?? obj.content ?? "",
    );

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "model_reasoning",
      reasoningContent,
      model: typeof obj.model === "string" ? obj.model : undefined,
      signature: typeof obj.signature === "string" ? obj.signature : undefined,
      tokenCount:
        typeof obj.tokenCount === "number"
          ? obj.tokenCount
          : (obj.token_count as number | undefined),
      durationMs:
        typeof obj.durationMs === "number"
          ? obj.durationMs
          : (obj.duration_ms as number | undefined),
    };
  }

  private decodeToolCall(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateToolCallEvent {
    const nested = (obj.toolCall ?? obj.tool_call ?? {}) as Record<string, unknown>;

    const toolName = String(
      obj.toolName ??
        obj.tool_name ??
        obj.tool ??
        obj.name ??
        nested.name ??
        nested.toolName ??
        "unknown_tool",
    );

    const callId = String(
      obj.callId ??
        obj.call_id ??
        obj.id ??
        nested.id ??
        nested.callId ??
        `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );

    let parameters: Record<string, unknown> = {};
    const rawParams =
      obj.parameters ??
      obj.params ??
      obj.arguments ??
      obj.args ??
      obj.input ??
      nested.parameters ??
      nested.params ??
      nested.arguments ??
      nested.args ??
      nested.input;

    if (typeof rawParams === "string") {
      try {
        parameters = JSON.parse(rawParams) as Record<string, unknown>;
      } catch {
        parameters = { raw: rawParams };
      }
    } else if (typeof rawParams === "object" && rawParams !== null) {
      parameters = rawParams as Record<string, unknown>;
    }

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "tool_call",
      toolName,
      callId,
      parameters,
      candidateRef: typeof obj.candidateRef === "string" ? obj.candidateRef : undefined,
    };
  }

  private decodeToolResult(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateToolResultEvent {
    const nested = (obj.toolResult ?? obj.tool_result ?? {}) as Record<string, unknown>;

    const toolName = String(
      obj.toolName ??
        obj.tool_name ??
        obj.tool ??
        obj.name ??
        nested.name ??
        nested.toolName ??
        "unknown_tool",
    );

    const callId = String(
      obj.callId ?? obj.call_id ?? obj.id ?? nested.id ?? nested.callId ?? `call_${Date.now()}`,
    );

    const result =
      obj.result ??
      obj.output ??
      obj.response ??
      obj.data ??
      nested.result ??
      nested.output ??
      nested.data ??
      null;

    const isError = Boolean(
      obj.isError ?? obj.is_error ?? obj.error ?? nested.isError ?? nested.is_error ?? nested.error,
    );

    const executionDurationMs =
      typeof obj.executionDurationMs === "number"
        ? obj.executionDurationMs
        : typeof obj.duration_ms === "number"
          ? obj.duration_ms
          : typeof obj.durationMs === "number"
            ? obj.durationMs
            : 0;

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "tool_result",
      toolName,
      callId,
      result,
      isError,
      executionDurationMs,
      outputSizeBytes:
        typeof obj.outputSizeBytes === "number"
          ? obj.outputSizeBytes
          : typeof result === "string"
            ? Buffer.byteLength(result)
            : undefined,
      isShadow: Boolean(obj.isShadow ?? obj.is_shadow),
    };
  }

  private decodeCommandExec(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateCommandExecEvent {
    const command = String(obj.command ?? obj.cmd ?? "");
    const args = Array.isArray(obj.args) ? (obj.args as string[]) : [];
    const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
    const exitCode =
      typeof obj.exitCode === "number" ? obj.exitCode : ((obj.exit_code as number) ?? 0);
    const stdout = typeof obj.stdout === "string" ? obj.stdout : undefined;
    const stderr = typeof obj.stderr === "string" ? obj.stderr : undefined;
    const durationMs =
      typeof obj.durationMs === "number"
        ? obj.durationMs
        : ((obj.duration_ms as number) ?? (obj.duration as number) ?? 0);

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "command_exec",
      command,
      args,
      cwd,
      exitCode,
      stdout,
      stderr,
      durationMs,
    };
  }

  private decodeFileEdit(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateFileEditEvent {
    const filePath = String(
      obj.filePath ?? obj.file_path ?? obj.path ?? obj.file ?? "unknown_file",
    );
    let operation: "create" | "update" | "delete" | "patch" = "update";
    const rawOp = String(obj.operation ?? obj.action ?? obj.op ?? "").toLowerCase();

    if (rawOp === "create" || rawOp === "add" || rawOp === "new") {
      operation = "create";
    } else if (rawOp === "delete" || rawOp === "remove" || rawOp === "rm") {
      operation = "delete";
    } else if (rawOp === "patch") {
      operation = "patch";
    }

    const patch = typeof obj.patch === "string" ? obj.patch : (obj.diff as string | undefined);
    const beforeHash =
      typeof obj.beforeHash === "string" ? obj.beforeHash : (obj.before_hash as string | undefined);
    const afterHash =
      typeof obj.afterHash === "string" ? obj.afterHash : (obj.after_hash as string | undefined);
    const diffStats =
      typeof obj.diffStats === "object" ? (obj.diffStats as FileDiffStats) : undefined;

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "file_edit",
      filePath,
      operation,
      patch,
      beforeHash,
      afterHash,
      diffStats,
    };
  }

  private decodeSubagentLifecycle(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateSubagentLifecycleEvent {
    const subagentId = String(
      obj.subagentId ??
        obj.subagent_id ??
        obj.taskId ??
        obj.task_id ??
        obj.id ??
        `subagent-${Date.now()}`,
    );

    let lifecycleType: "spawn" | "start" | "pause" | "resume" | "terminate" | "settle" = "spawn";
    const rawAction = String(
      obj.lifecycleType ?? obj.lifecycle_type ?? obj.action ?? obj.state ?? obj.event ?? "spawn",
    ).toLowerCase();

    if (rawAction === "spawn" || rawAction === "create" || rawAction === "delegated") {
      lifecycleType = "spawn";
    } else if (rawAction === "start" || rawAction === "running" || rawAction === "run") {
      lifecycleType = "start";
    } else if (rawAction === "pause" || rawAction === "park" || rawAction === "parked") {
      lifecycleType = "pause";
    } else if (rawAction === "resume" || rawAction === "wake") {
      lifecycleType = "resume";
    } else if (
      rawAction === "terminate" ||
      rawAction === "kill" ||
      rawAction === "cancel" ||
      rawAction === "aborted"
    ) {
      lifecycleType = "terminate";
    } else if (
      rawAction === "settle" ||
      rawAction === "complete" ||
      rawAction === "completed" ||
      rawAction === "done"
    ) {
      lifecycleType = "settle";
    }

    const parentId =
      typeof obj.parentId === "string" ? obj.parentId : (obj.parent_id as string | undefined);
    const role =
      typeof obj.role === "string"
        ? obj.role
        : ((obj.agent ?? obj.agentType ?? obj.agent_type) as string | undefined);
    const reason =
      typeof obj.reason === "string"
        ? obj.reason
        : ((obj.prompt ?? obj.description) as string | undefined);

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "subagent_lifecycle",
      subagentId,
      lifecycleType,
      parentId,
      role,
      reason,
    };
  }

  private decodeCompaction(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateCompactionEvent {
    let triggerReason: "context_limit" | "manual" | "scheduled" | "turn_threshold" =
      "context_limit";
    const rawReason = String(
      obj.triggerReason ?? obj.trigger_reason ?? obj.reason ?? "",
    ).toLowerCase();

    if (rawReason === "manual") {
      triggerReason = "manual";
    } else if (rawReason === "scheduled") {
      triggerReason = "scheduled";
    } else if (rawReason === "turn_threshold" || rawReason === "turns") {
      triggerReason = "turn_threshold";
    }

    const tokensBefore =
      typeof obj.tokensBefore === "number"
        ? obj.tokensBefore
        : ((obj.tokens_before as number) ?? (obj.before_tokens as number) ?? 0);

    const tokensAfter =
      typeof obj.tokensAfter === "number"
        ? obj.tokensAfter
        : ((obj.tokens_after as number) ?? (obj.after_tokens as number) ?? 0);

    const preservedContextSummary =
      typeof obj.preservedContextSummary === "string"
        ? obj.preservedContextSummary
        : ((obj.summary ?? obj.preserved_summary) as string | undefined);

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "compaction",
      triggerReason,
      tokensBefore,
      tokensAfter,
      preservedContextSummary,
    };
  }

  private decodeBranchFork(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateBranchForkEvent {
    const sourceSessionId = String(
      obj.sourceSessionId ??
        obj.source_session_id ??
        obj.parentSessionId ??
        obj.parent_session_id ??
        sessionId,
    );

    const branchPointEventId = String(
      obj.branchPointEventId ??
        obj.branch_point_event_id ??
        obj.forkPoint ??
        obj.fork_point ??
        "event-0",
    );

    const forkReason =
      typeof obj.forkReason === "string" ? obj.forkReason : (obj.reason as string | undefined);
    const branchName =
      typeof obj.branchName === "string"
        ? obj.branchName
        : ((obj.name ?? obj.branch) as string | undefined);

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "branch_fork",
      sourceSessionId,
      branchPointEventId,
      forkReason,
      branchName,
    };
  }

  private decodeError(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateErrorEvent {
    const errorType = String(
      obj.errorType ??
        obj.error_type ??
        obj.name ??
        obj.errorClass ??
        obj.error_class ??
        "UnknownError",
    );

    const message = String(obj.message ?? obj.error ?? obj.description ?? "An error occurred");
    const stackTrace =
      typeof obj.stackTrace === "string" ? obj.stackTrace : (obj.stack as string | undefined);
    const recoverable = Boolean(obj.recoverable);

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "error",
      errorType,
      message,
      stackTrace,
      recoverable,
    };
  }

  private decodeSessionLifecycle(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateSessionLifecycleEvent {
    let lifecycleType: "start" | "pause" | "resume" | "end" | "crash" = "start";
    const rawAction = String(
      obj.lifecycleType ?? obj.lifecycle_type ?? obj.action ?? obj.state ?? obj.event ?? "start",
    ).toLowerCase();

    if (rawAction === "start" || rawAction === "init" || rawAction === "begin") {
      lifecycleType = "start";
    } else if (rawAction === "pause" || rawAction === "suspend") {
      lifecycleType = "pause";
    } else if (rawAction === "resume") {
      lifecycleType = "resume";
    } else if (
      rawAction === "end" ||
      rawAction === "finish" ||
      rawAction === "completed" ||
      rawAction === "close"
    ) {
      lifecycleType = "end";
    } else if (rawAction === "crash" || rawAction === "error" || rawAction === "fatal") {
      lifecycleType = "crash";
    }

    const exitReason =
      typeof obj.exitReason === "string" ? obj.exitReason : (obj.reason as string | undefined);
    const harnessName = typeof obj.harnessName === "string" ? obj.harnessName : "omp";
    const workspaceId =
      typeof obj.workspaceId === "string"
        ? obj.workspaceId
        : (obj.workspace_id as string | undefined);

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "session_lifecycle",
      lifecycleType,
      exitReason,
      harnessName,
      workspaceId,
    };
  }

  private decodeToolDiscovery(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateToolDiscoveryEvent {
    const rawTools = Array.isArray(obj.tools) ? (obj.tools as unknown[]) : [];
    const tools: DiscoveredToolEntry[] = rawTools.map((t) => {
      const toolObj = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
      return {
        name: String(toolObj.name ?? toolObj.toolName ?? toolObj.tool ?? "unknown_tool"),
        description: typeof toolObj.description === "string" ? toolObj.description : undefined,
        inputSchema:
          typeof toolObj.inputSchema === "object" && toolObj.inputSchema !== null
            ? (toolObj.inputSchema as Record<string, unknown>)
            : undefined,
      };
    });

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "tool_discovery",
      tools,
      provider: typeof obj.provider === "string" ? obj.provider : undefined,
      source: (obj.source as "mcp" | "builtin" | "dynamic" | "harness") ?? "harness",
    };
  }
}
