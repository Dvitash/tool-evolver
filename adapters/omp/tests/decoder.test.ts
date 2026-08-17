import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RawHarnessRecord } from "@tool-evolver/harness-contracts";
import type {
  IntermediateBranchForkEvent,
  IntermediateCommandExecEvent,
  IntermediateCompactionEvent,
  IntermediateErrorEvent,
  IntermediateFileEditEvent,
  IntermediateMessageEvent,
  IntermediateModelReasoningEvent,
  IntermediateSessionLifecycleEvent,
  IntermediateSubagentLifecycleEvent,
  IntermediateToolCallEvent,
  IntermediateToolResultEvent,
} from "@tool-evolver/observer";
import { describe, expect, it } from "vitest";
import { OmpRecordDecoder } from "../src/decoder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../fixtures");

describe("OMP JSONL Session Decoder & Normalization", () => {
  const decoder = new OmpRecordDecoder();

  it("has correct decoder metadata and identification", () => {
    expect(decoder.harnessId).toBe("omp");
    expect(decoder.decoderVersion).toBe("1.0.0");
  });

  it("canDecode recognizes OMP records and typical JSON structures", () => {
    expect(
      decoder.canDecode({
        recordId: "r1",
        sessionId: "s1",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp: new Date().toISOString(),
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
        rawPayload: "{}",
        metadata: {},
      }),
    ).toBe(true);

    expect(
      decoder.canDecode({
        recordId: "r2",
        sessionId: "s1",
        harnessId: "other",
        sequenceNumber: 1,
        recordType: "prompt",
        timestamp: new Date().toISOString(),
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
        rawPayload: JSON.stringify({ type: "message", role: "user", content: "hi" }),
        metadata: {},
      }),
    ).toBe(true);
  });

  it("decodes entire golden session-full.jsonl fixture into typed intermediate events", async () => {
    const filePath = path.join(fixturesDir, "session-full.jsonl");
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const decodedEvents = lines.map((line, idx) => {
      const record: RawHarnessRecord = {
        recordId: `rec-${idx + 1}`,
        sessionId: "session-golden-1",
        harnessId: "omp",
        sequenceNumber: idx + 1,
        recordType: "transcript_line",
        timestamp: "2026-08-17T10:00:00.000Z",
        cursor: {
          offset: idx * 100,
          line: idx + 1,
          sequence: idx + 1,
          timestamp: "2026-08-17T10:00:00.000Z",
        },
        rawPayload: line,
        metadata: {},
      };
      return decoder.decode(record);
    });

    expect(decodedEvents.length).toBe(14);

    // 0: session_lifecycle (start)
    const ev0 = decodedEvents[0] as IntermediateSessionLifecycleEvent;
    expect(ev0.type).toBe("session_lifecycle");
    expect(ev0.lifecycleType).toBe("start");
    expect(ev0.harnessName).toBe("omp");

    // 1: message (user)
    const ev1 = decodedEvents[1] as IntermediateMessageEvent;
    expect(ev1.type).toBe("message");
    expect(ev1.role).toBe("user");
    expect(ev1.content).toContain("Inspect the repository");

    // 2: model_reasoning
    const ev2 = decodedEvents[2] as IntermediateModelReasoningEvent;
    expect(ev2.type).toBe("model_reasoning");
    expect(ev2.reasoningContent).toContain("I will start by checking");
    expect(ev2.model).toBe("gemini-3.7-flash");

    // 3: tool_call
    const ev3 = decodedEvents[3] as IntermediateToolCallEvent;
    expect(ev3.type).toBe("tool_call");
    expect(ev3.toolName).toBe("read");
    expect(ev3.callId).toBe("call_101");
    expect(ev3.parameters).toEqual({ path: "src/auth.ts" });

    // 4: tool_result
    const ev4 = decodedEvents[4] as IntermediateToolResultEvent;
    expect(ev4.type).toBe("tool_result");
    expect(ev4.toolName).toBe("read");
    expect(ev4.callId).toBe("call_101");
    expect(ev4.isError).toBe(false);
    expect(ev4.executionDurationMs).toBe(15);

    // 5: command_exec
    const ev5 = decodedEvents[5] as IntermediateCommandExecEvent;
    expect(ev5.type).toBe("command_exec");
    expect(ev5.command).toBe("pnpm test");
    expect(ev5.exitCode).toBe(0);
    expect(ev5.durationMs).toBe(340);
    expect(ev5.stdout).toContain("PASS src/auth.test.ts");

    // 6: file_edit
    const ev6 = decodedEvents[6] as IntermediateFileEditEvent;
    expect(ev6.type).toBe("file_edit");
    expect(ev6.filePath).toBe("src/auth.ts");
    expect(ev6.operation).toBe("patch");
    expect(ev6.diffStats).toEqual({ additions: 1, deletions: 1, modifications: 0 });

    // 7: subagent_lifecycle (spawn)
    const ev7 = decodedEvents[7] as IntermediateSubagentLifecycleEvent;
    expect(ev7.type).toBe("subagent_lifecycle");
    expect(ev7.subagentId).toBe("subagent-scout-99");
    expect(ev7.lifecycleType).toBe("spawn");
    expect(ev7.parentId).toBe("session-golden-1");
    expect(ev7.role).toBe("scout");

    // 8: subagent_lifecycle (settle)
    const ev8 = decodedEvents[8] as IntermediateSubagentLifecycleEvent;
    expect(ev8.type).toBe("subagent_lifecycle");
    expect(ev8.subagentId).toBe("subagent-scout-99");
    expect(ev8.lifecycleType).toBe("settle");

    // 9: compaction
    const ev9 = decodedEvents[9] as IntermediateCompactionEvent;
    expect(ev9.type).toBe("compaction");
    expect(ev9.triggerReason).toBe("context_limit");
    expect(ev9.tokensBefore).toBe(128000);
    expect(ev9.tokensAfter).toBe(24000);
    expect(ev9.preservedContextSummary).toContain("Summarized initial inspection");

    // 10: branch_fork
    const ev10 = decodedEvents[10] as IntermediateBranchForkEvent;
    expect(ev10.type).toBe("branch_fork");
    expect(ev10.sourceSessionId).toBe("session-golden-1");
    expect(ev10.branchName).toBe("alt-auth-branch");

    // 11: error
    const ev11 = decodedEvents[11] as IntermediateErrorEvent;
    expect(ev11.type).toBe("error");
    expect(ev11.errorType).toBe("ValidationError");
    expect(ev11.message).toBe("Token string cannot be empty");
    expect(ev11.recoverable).toBe(true);

    // 12: message (assistant)
    const ev12 = decodedEvents[12] as IntermediateMessageEvent;
    expect(ev12.type).toBe("message");
    expect(ev12.role).toBe("assistant");
    expect(ev12.content).toContain("Successfully refactored authenticate");

    // 13: session_lifecycle (end)
    const ev13 = decodedEvents[13] as IntermediateSessionLifecycleEvent;
    expect(ev13.type).toBe("session_lifecycle");
    expect(ev13.lifecycleType).toBe("end");
    expect(ev13.exitReason).toBe("task_completed");
  });

  it("decodes subagents session fixture with hierarchical parentId and roles", async () => {
    const filePath = path.join(fixturesDir, "session-subagents.jsonl");
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const subagentEvents = lines
      .map((line, idx) => {
        return decoder.decode({
          recordId: `r-${idx}`,
          sessionId: "session-subagents-1",
          harnessId: "omp",
          sequenceNumber: idx + 1,
          recordType: "transcript_line",
          timestamp: new Date().toISOString(),
          cursor: {
            offset: 0,
            line: idx + 1,
            sequence: idx + 1,
            timestamp: new Date().toISOString(),
          },
          rawPayload: line,
          metadata: {},
        });
      })
      .filter((ev): ev is IntermediateSubagentLifecycleEvent => ev?.type === "subagent_lifecycle");

    expect(subagentEvents.length).toBe(6);
    expect(subagentEvents.map((s) => s.subagentId)).toEqual([
      "scout-01",
      "scout-01",
      "scout-01",
      "writer-01",
      "writer-01",
      "writer-01",
    ]);
    expect(subagentEvents.map((s) => s.lifecycleType)).toEqual([
      "spawn",
      "start",
      "settle",
      "spawn",
      "start",
      "settle",
    ]);
  });

  it("decodes compaction session fixture with token differential", async () => {
    const filePath = path.join(fixturesDir, "session-compaction.jsonl");
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const events = lines.map((line, idx) =>
      decoder.decode({
        recordId: `r-${idx}`,
        sessionId: "session-compaction-1",
        harnessId: "omp",
        sequenceNumber: idx + 1,
        recordType: "transcript_line",
        timestamp: new Date().toISOString(),
        cursor: {
          offset: 0,
          line: idx + 1,
          sequence: idx + 1,
          timestamp: new Date().toISOString(),
        },
        rawPayload: line,
        metadata: {},
      }),
    );

    const compaction = events.find(
      (e): e is IntermediateCompactionEvent => e?.type === "compaction",
    );
    expect(compaction).toBeDefined();
    expect(compaction?.tokensBefore).toBe(195000);
    expect(compaction?.tokensAfter).toBe(15000);
    expect(compaction?.preservedContextSummary).toContain("Log contained 4 error lines");
  });

  it("handles snake_case and alternative field names gracefully", () => {
    const toolCallRecord: RawHarnessRecord = {
      recordId: "tc1",
      sessionId: "s1",
      harnessId: "omp",
      sequenceNumber: 1,
      recordType: "tool_call",
      timestamp: new Date().toISOString(),
      cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
      rawPayload: JSON.stringify({
        type: "tool_call",
        tool_name: "custom_grep",
        call_id: "call_999",
        args: { pattern: "regex" },
      }),
      metadata: {},
    };

    const decoded = decoder.decode(toolCallRecord) as IntermediateToolCallEvent;
    expect(decoded.type).toBe("tool_call");
    expect(decoded.toolName).toBe("custom_grep");
    expect(decoded.callId).toBe("call_999");
    expect(decoded.parameters).toEqual({ pattern: "regex" });
  });

  it("falls back to unknown_passthrough for unrecognized event structures", () => {
    const unknownRecord: RawHarnessRecord = {
      recordId: "u1",
      sessionId: "s1",
      harnessId: "omp",
      sequenceNumber: 1,
      recordType: "custom",
      timestamp: new Date().toISOString(),
      cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
      rawPayload: JSON.stringify({
        type: "custom_telemetry_event",
        metricName: "cpu_usage",
        value: 42,
      }),
      metadata: {},
    };

    const decoded = decoder.decode(unknownRecord);
    expect(decoded?.type).toBe("unknown_passthrough");
  });
});
