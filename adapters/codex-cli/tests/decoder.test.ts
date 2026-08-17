import {
  NormalizedSessionEventSchema,
} from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import {
  MULTI_TURN_TOOLS_ROLLOUT_PATH,
  STANDARD_SESSION_ROLLOUT_PATH,
  SUBAGENTS_AND_FORKS_ROLLOUT_PATH,
  readFixture,
} from "../fixtures/index.js";
import {
  CodexSessionDecoder,
  decodeCodexRecord,
  decodeCodexTranscript,
} from "../src/decoder.js";

describe("Codex CLI Session Decoder", () => {
  describe("Golden Fixture: standard-session.jsonl", () => {
    it("decodes all event types and passes strict schema validation", async () => {
      const rawContent = await readFixture(STANDARD_SESSION_ROLLOUT_PATH);
      const decoder = new CodexSessionDecoder({ sessionId: "sess_golden_01" });
      const events = decoder.decodeTranscript(rawContent);

      expect(events).toHaveLength(10);

      // Validate every event against official NormalizedSessionEvent schema
      for (const event of events) {
        const validated = NormalizedSessionEventSchema.safeParse(event);
        if (!validated.success) {
          console.error("Validation error:", validated.error);
        }
        expect(validated.success).toBe(true);
      }

      // Check event types in order
      expect(events[0]?.type).toBe("session_lifecycle");
      expect(events[0]).toMatchObject({
        type: "session_lifecycle",
        lifecycleType: "start",
        harnessName: "codex-cli",
        workspaceId: "ws_codex_01",
      });

      expect(events[1]?.type).toBe("message");
      expect(events[1]).toMatchObject({
        type: "message",
        role: "user",
        content: "Please check git status and read src/index.ts",
      });

      expect(events[2]?.type).toBe("model_reasoning");
      expect(events[2]).toMatchObject({
        type: "model_reasoning",
        reasoningContent: "I need to execute git status and read the source file index.ts to fulfill the user request.",
      });

      expect(events[3]?.type).toBe("command_exec");
      expect(events[3]).toMatchObject({
        type: "command_exec",
        command: "git status",
        args: ["status"],
        exitCode: 0,
        stdout: "On branch main\nnothing to commit, working tree clean",
      });

      expect(events[4]?.type).toBe("tool_call");
      expect(events[4]).toMatchObject({
        type: "tool_call",
        callId: "call_read_01",
        toolName: "read_file",
        parameters: { path: "src/index.ts" },
      });

      expect(events[5]?.type).toBe("tool_result");
      expect(events[5]).toMatchObject({
        type: "tool_result",
        callId: "call_read_01",
        toolName: "read_file",
        result: "export const version = '1.0.0';\n",
        isError: false,
      });

      expect(events[6]?.type).toBe("file_edit");
      expect(events[6]).toMatchObject({
        type: "file_edit",
        filePath: "src/index.ts",
        operation: "update",
        diffStats: { linesAdded: 1, linesRemoved: 0, filesChanged: 1 },
      });

      expect(events[7]?.type).toBe("compaction");
      expect(events[7]).toMatchObject({
        type: "compaction",
        triggerReason: "context_limit",
        tokensBefore: 95000,
        tokensAfter: 12000,
        preservedContextSummary: "Verified git status clean and read version from src/index.ts",
      });

      expect(events[8]?.type).toBe("message");
      expect(events[8]).toMatchObject({
        type: "message",
        role: "assistant",
        content: "I have verified git status and updated src/index.ts with ready flag.",
      });

      expect(events[9]?.type).toBe("session_lifecycle");
      expect(events[9]).toMatchObject({
        type: "session_lifecycle",
        lifecycleType: "end",
        exitReason: "completed",
      });
    });

    it("maintains strictly increasing causal sequence and parentId linking", async () => {
      const rawContent = await readFixture(STANDARD_SESSION_ROLLOUT_PATH);
      const events = decodeCodexTranscript(rawContent, { sessionId: "sess_causal" });

      for (let i = 0; i < events.length; i++) {
        const current = events[i]!;
        expect(current.causalRef.causalSequence).toBe(i + 1);

        if (i > 0) {
          const prev = events[i - 1]!;
          expect(current.causalRef.parentId).toBe(prev.eventId);
        } else {
          expect(current.causalRef.parentId).toBeUndefined();
        }
      }
    });
  });

  describe("Golden Fixture: multi-turn-tools.jsonl", () => {
    it("decodes inline tool calls and correlates tool results with toolName", async () => {
      const rawContent = await readFixture(MULTI_TURN_TOOLS_ROLLOUT_PATH);
      const events = decodeCodexTranscript(rawContent);

      expect(events.length).toBeGreaterThanOrEqual(5);

      for (const event of events) {
        expect(NormalizedSessionEventSchema.safeParse(event).success).toBe(true);
      }

      // Check tool call
      const toolCall = events.find((e) => e.type === "tool_call");
      expect(toolCall).toBeDefined();
      expect(toolCall).toMatchObject({
        type: "tool_call",
        callId: "call_mcp_01",
        toolName: "mcp__tool_evolver__evaluate",
        parameters: { code: "process.memoryUsage()", language: "js" },
      });

      // Check tool result receives inferred toolName from previous tool call
      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toBeDefined();
      expect(toolResult).toMatchObject({
        type: "tool_result",
        callId: "call_mcp_01",
        toolName: "mcp__tool_evolver__evaluate",
        isError: false,
      });

      // Check error event
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent).toMatchObject({
        type: "error",
        errorType: "NetworkWarning",
        message: "Telemetry ping timed out (non-fatal)",
        recoverable: true,
      });
    });
  });

  describe("Golden Fixture: subagents-and-forks.jsonl", () => {
    it("decodes subagent lifecycle transitions and session branch forks", async () => {
      const rawContent = await readFixture(SUBAGENTS_AND_FORKS_ROLLOUT_PATH);
      const events = decodeCodexTranscript(rawContent);

      for (const event of events) {
        expect(NormalizedSessionEventSchema.safeParse(event).success).toBe(true);
      }

      const spawnEvent = events.find(
        (e) => e.type === "subagent_lifecycle" && e.lifecycleType === "spawn",
      );
      expect(spawnEvent).toBeDefined();
      expect(spawnEvent).toMatchObject({
        type: "subagent_lifecycle",
        subagentId: "sub_scout_01",
        role: "code_explorer",
      });

      const terminateEvent = events.find(
        (e) => e.type === "subagent_lifecycle" && e.lifecycleType === "terminate",
      );
      expect(terminateEvent).toBeDefined();
      expect(terminateEvent).toMatchObject({
        type: "subagent_lifecycle",
        subagentId: "sub_scout_01",
        reason: "exploration_complete",
      });

      const forkEvent = events.find((e) => e.type === "branch_fork");
      expect(forkEvent).toBeDefined();
      expect(forkEvent).toMatchObject({
        type: "branch_fork",
        sourceSessionId: "sess_root_01",
        branchPointEventId: "evt_sub_01",
        branchName: "experiment_branch",
      });
    });
  });

  describe("Edge cases and resilience", () => {
    it("decodes unparseable JSON as unknown_passthrough without crashing", () => {
      const events = decodeCodexRecord("MALFORMED JSON {{{");
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("unknown_passthrough");
      expect(NormalizedSessionEventSchema.safeParse(events[0]).success).toBe(true);
    });

    it("ignores blank lines gracefully", () => {
      const events = decodeCodexTranscript("\n  \n\t\n");
      expect(events).toHaveLength(0);
    });
  });
});
