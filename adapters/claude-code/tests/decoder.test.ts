import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeRecordDecoder, decodeClaudeTranscriptLine } from "../src/decoder.js";

describe("Claude Code Transcript Decoder", () => {
  const sessionId = "test-session-123";

  it("decodes session start and end lifecycle events", () => {
    const startLine = JSON.stringify({
      type: "session_start",
      harness: "claude-code",
      workspaceId: "ws-1",
      timestamp: "2026-08-17T12:00:00.000Z",
    });

    const startEvents = decodeClaudeTranscriptLine(startLine, sessionId, 1);
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].type).toBe("session_lifecycle");
    if (startEvents[0].type === "session_lifecycle") {
      expect(startEvents[0].lifecycleType).toBe("start");
      expect(startEvents[0].harnessName).toBe("claude-code");
      expect(startEvents[0].workspaceId).toBe("ws-1");
    }

    const endLine = JSON.stringify({
      type: "session_end",
      exitReason: "user_completed",
      timestamp: "2026-08-17T12:05:00.000Z",
    });

    const endEvents = decodeClaudeTranscriptLine(endLine, sessionId, 2);
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].type).toBe("session_lifecycle");
    if (endEvents[0].type === "session_lifecycle") {
      expect(endEvents[0].lifecycleType).toBe("end");
      expect(endEvents[0].exitReason).toBe("user_completed");
    }
  });

  it("decodes subagents and branch fork events", () => {
    const subagentLine = JSON.stringify({
      type: "subagent_spawn",
      subagentId: "sub-123",
      parentId: "session-root",
      role: "code_reviewer",
    });

    const subEvents = decodeClaudeTranscriptLine(subagentLine, sessionId, 1);
    expect(subEvents).toHaveLength(1);
    expect(subEvents[0].type).toBe("subagent_lifecycle");
    if (subEvents[0].type === "subagent_lifecycle") {
      expect(subEvents[0].subagentId).toBe("sub-123");
      expect(subEvents[0].lifecycleType).toBe("spawn");
      expect(subEvents[0].role).toBe("code_reviewer");
    }

    const forkLine = JSON.stringify({
      type: "branch_fork",
      sourceSessionId: sessionId,
      branchPointEventId: "ev-5",
      branchName: "experiment-1",
      forkReason: "testing alternate prompt",
    });

    const forkEvents = decodeClaudeTranscriptLine(forkLine, sessionId, 2);
    expect(forkEvents).toHaveLength(1);
    expect(forkEvents[0].type).toBe("branch_fork");
    if (forkEvents[0].type === "branch_fork") {
      expect(forkEvents[0].branchPointEventId).toBe("ev-5");
      expect(forkEvents[0].branchName).toBe("experiment-1");
    }
  });

  it("decodes user messages and tool results", () => {
    const userLine = JSON.stringify({
      type: "user",
      content: "Please check all TypeScript files.",
      model: "claude-3-7-sonnet",
    });

    const userEvents = decodeClaudeTranscriptLine(userLine, sessionId, 1);
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].type).toBe("message");
    if (userEvents[0].type === "message") {
      expect(userEvents[0].role).toBe("user");
      expect(userEvents[0].content).toBe("Please check all TypeScript files.");
    }

    const toolResultLine = JSON.stringify({
      type: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_123",
          name: "grep",
          content: "file1.ts\nfile2.ts",
          is_error: false,
        },
      ],
    });

    const toolResultEvents = decodeClaudeTranscriptLine(toolResultLine, sessionId, 2);
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0].type).toBe("tool_result");
    if (toolResultEvents[0].type === "tool_result") {
      expect(toolResultEvents[0].toolCallId).toBe("toolu_123");
      expect(toolResultEvents[0].toolName).toBe("grep");
      expect(toolResultEvents[0].output).toBe("file1.ts\nfile2.ts");
      expect(toolResultEvents[0].isError).toBe(false);
    }
  });

  it("decodes assistant messages with text, reasoning, and tool calls", () => {
    const assistantLine = JSON.stringify({
      type: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "I will check the build status first using Bash.",
          signature: "sig_abc",
        },
        {
          type: "text",
          text: "Running build check now...",
        },
        {
          type: "tool_use",
          id: "toolu_bash_99",
          name: "Bash",
          input: { command: "pnpm build", cwd: "/root" },
        },
      ],
      model: "claude-3-7-sonnet",
    });

    const events = decodeClaudeTranscriptLine(assistantLine, sessionId, 1);
    // Should emit reasoning, text message, tool call, and specialized command exec
    expect(events.length).toBeGreaterThanOrEqual(3);

    const reasoning = events.find((e) => e.type === "model_reasoning");
    expect(reasoning).toBeDefined();
    if (reasoning && reasoning.type === "model_reasoning") {
      expect(reasoning.thought).toBe("I will check the build status first using Bash.");
      expect(reasoning.signature).toBe("sig_abc");
    }

    const message = events.find((e) => e.type === "message");
    expect(message).toBeDefined();
    if (message && message.type === "message") {
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("Running build check now...");
    }

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall && toolCall.type === "tool_call") {
      expect(toolCall.toolCallId).toBe("toolu_bash_99");
      expect(toolCall.toolName).toBe("Bash");
    }

    const commandExec = events.find((e) => e.type === "command_exec");
    expect(commandExec).toBeDefined();
    if (commandExec && commandExec.type === "command_exec") {
      expect(commandExec.command).toBe("pnpm build");
      expect(commandExec.workingDirectory).toBe("/root");
    }
  });

  it("decodes file edits with modify and create types", () => {
    const editLine = JSON.stringify({
      type: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_edit_1",
          name: "Edit",
          input: {
            file_path: "src/index.ts",
            command: "modify",
            old_str: "const a = 1;",
            new_str: "const a = 2;",
          },
        },
      ],
    });

    const events = decodeClaudeTranscriptLine(editLine, sessionId, 1);
    const fileEdit = events.find((e) => e.type === "file_edit");
    expect(fileEdit).toBeDefined();
    if (fileEdit && fileEdit.type === "file_edit") {
      expect(fileEdit.filePath).toBe("src/index.ts");
      expect(fileEdit.editType).toBe("modify");
      expect(fileEdit.diff).toContain("-const a = 1;");
      expect(fileEdit.diff).toContain("+const a = 2;");
    }
  });

  it("decodes compaction events and errors", () => {
    const compactionLine = JSON.stringify({
      type: "compaction",
      originalTokenCount: 100000,
      compactedTokenCount: 15000,
      summary: "Summary of earlier discussion",
      rangeStart: "event-1",
      rangeEnd: "event-50",
    });

    const compEvents = decodeClaudeTranscriptLine(compactionLine, sessionId, 1);
    expect(compEvents).toHaveLength(1);
    expect(compEvents[0].type).toBe("compaction");
    if (compEvents[0].type === "compaction") {
      expect(compEvents[0].originalTokenCount).toBe(100000);
      expect(compEvents[0].compactedTokenCount).toBe(15000);
      expect(compEvents[0].summary).toBe("Summary of earlier discussion");
    }

    const errorLine = JSON.stringify({
      type: "error",
      code: "API_TIMEOUT",
      message: "Gateway connection timed out",
      fatal: true,
    });

    const errorEvents = decodeClaudeTranscriptLine(errorLine, sessionId, 2);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].type).toBe("error");
    if (errorEvents[0].type === "error") {
      expect(errorEvents[0].errorCode).toBe("API_TIMEOUT");
      expect(errorEvents[0].message).toBe("Gateway connection timed out");
      expect(errorEvents[0].fatal).toBe(true);
    }
  });

  it("emits unknown passthrough on unrecognized records", () => {
    const unknownLine = JSON.stringify({
      type: "custom_unsupported_claude_event",
      foo: "bar",
    });

    const events = decodeClaudeTranscriptLine(unknownLine, sessionId, 1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("unknown_passthrough");
    if (events[0].type === "unknown_passthrough") {
      expect(events[0].rawEventType).toBe("custom_unsupported_claude_event");
      expect(events[0].rawPayload).toEqual({
        type: "custom_unsupported_claude_event",
        foo: "bar",
      });
    }
  });

  it("decodes all golden fixture files successfully via ClaudeRecordDecoder", () => {
    const decoder = new ClaudeRecordDecoder();
    const fixturesDir = path.join(__dirname, "..", "fixtures");
    const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".jsonl"));

    expect(fixtureFiles.length).toBeGreaterThanOrEqual(5);

    for (const file of fixtureFiles) {
      const filePath = path.join(fixturesDir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      expect(lines.length).toBeGreaterThan(0);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const record = {
          recordId: `rec-${i}`,
          sessionId: "session-golden-test",
          harnessId: "claude-code",
          sequenceNumber: i + 1,
          timestamp: new Date().toISOString(),
          recordType: "transcript_line" as const,
          rawPayload: line,
          cursor: {
            offset: i * 100,
            line: i + 1,
            sequence: i + 1,
            timestamp: new Date().toISOString(),
          },
          metadata: {},
        };

        expect(decoder.canDecode(record)).toBe(true);
        const decoded = decoder.decode(record);
        expect(decoded.length).toBeGreaterThan(0);
        for (const ev of decoded) {
          expect(ev.sessionId).toBeTruthy();
          expect(ev.type).toBeTruthy();
          expect(ev.timestamp).toBeTruthy();
        }
      }
    }
  });
});
