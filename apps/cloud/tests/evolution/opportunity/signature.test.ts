import { describe, expect, it } from "vitest";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import {
  SignatureExtractor,
  classifyToolOrCommand,
  normalizeCommandProfile,
  normalizePathAlias,
  splitCompositeCommand,
} from "../../../src/evolution/opportunity/signature.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createToolCallEvent,
  createToolResultEvent,
} from "./helpers.js";

describe("SignatureExtractor", () => {
  it("should normalize path aliases into semantic placeholders", () => {
    expect(normalizePathAlias("src/components/Button.tsx")).toBe("$SRC_FILE");
    expect(normalizePathAlias("apps/cloud/src/index.ts")).toBe("$SRC_FILE");
    expect(normalizePathAlias("tests/storage/evidence.test.ts")).toBe("$TEST_FILE");
    expect(normalizePathAlias("package.json")).toBe("$CONFIG_FILE");
    expect(normalizePathAlias("tsconfig.base.json")).toBe("$CONFIG_FILE");
    expect(normalizePathAlias("docs/architecture.md")).toBe("$DOC_FILE");
    expect(normalizePathAlias("dist/bundle.js")).toBe("$BUILD_DIR");
    expect(normalizePathAlias("/tmp/scratch.log")).toBe("$TMP_DIR");
  });

  it("should classify tools and commands into high-level ToolClasses", () => {
    expect(classifyToolOrCommand("read_file")).toBe("file_read");
    expect(classifyToolOrCommand("edit_script_lines")).toBe("file_edit");
    expect(classifyToolOrCommand("grep_scripts")).toBe("search");
    expect(classifyToolOrCommand("pnpm", "pnpm test --run")).toBe("test_runner");
    expect(classifyToolOrCommand("vitest")).toBe("test_runner");
    expect(classifyToolOrCommand("git", "git status")).toBe("vcs");
    expect(classifyToolOrCommand("bash")).toBe("shell_exec");
    expect(classifyToolOrCommand("bash", "git status --porcelain")).toBe("vcs");
    expect(normalizeCommandProfile("/usr/bin/git   status --porcelain")).toBe(
      "git status --porcelain",
    );
    expect(classifyToolOrCommand("agent")).toBe("subagent");
  });

  it("should extract identical structural hashes for isomorphic workflows with different filenames", () => {
    const segmenter = new EpisodeSegmenter();
    const extractor = new SignatureExtractor();

    // Workflow A: read source file, edit source file, run vitest
    const eventsA = [
      createToolCallEvent({
        eventId: "a1",
        sessionId: "sess-a",
        toolName: "read_file",
        parameters: { path: "src/auth/service.ts" },
      }),
      createToolResultEvent({
        eventId: "a2",
        sessionId: "sess-a",
        toolCallId: "a1",
        result: "...",
      }),
      createFileEditEvent({ eventId: "a3", sessionId: "sess-a", filePath: "src/auth/service.ts" }),
      createCommandExecEvent({
        eventId: "a4",
        sessionId: "sess-a",
        command: "vitest run tests/auth.test.ts",
      }),
    ];

    // Workflow B: read another source file, edit another source file, run vitest (different session & concrete paths)
    const eventsB = [
      createToolCallEvent({
        eventId: "b1",
        sessionId: "sess-b",
        toolName: "read_file",
        parameters: { path: "src/storage/store.ts" },
      }),
      createToolResultEvent({
        eventId: "b2",
        sessionId: "sess-b",
        toolCallId: "b1",
        result: "...",
      }),
      createFileEditEvent({ eventId: "b3", sessionId: "sess-b", filePath: "src/storage/store.ts" }),
      createCommandExecEvent({
        eventId: "b4",
        sessionId: "sess-b",
        command: "vitest run tests/storage.test.ts",
      }),
    ];

    const [epA] = segmenter.segmentEvents(eventsA);
    const [epB] = segmenter.segmentEvents(eventsB);

    const sigA = extractor.extractSignature(epA);
    const sigB = extractor.extractSignature(epB);

    expect(sigA.structuralHash).toBe(sigB.structuralHash);
    expect(sigA.operationSequence).toEqual(sigB.operationSequence);
    expect(sigA.toolClasses).toEqual(sigB.toolClasses);
  });
});

describe("splitCompositeCommand", () => {
  it("splits composite shell strings on control operators", () => {
    expect(splitCompositeCommand("git log --oneline -5 && git status --porcelain")).toEqual([
      "git log --oneline -5",
      "git status --porcelain",
    ]);
    expect(splitCompositeCommand("git diff || git branch; git rev-parse HEAD")).toEqual([
      "git diff",
      "git branch",
      "git rev-parse HEAD",
    ]);
    expect(splitCompositeCommand("cat out.txt | wc -l")).toEqual(["cat out.txt", "wc -l"]);
  });

  it("returns a single segment for simple commands", () => {
    expect(splitCompositeCommand("git status --porcelain")).toEqual(["git status --porcelain"]);
    expect(splitCompositeCommand("")).toEqual([]);
  });
});

describe("SignatureExtractor composite commands", () => {
  it("derives one command pattern per simple command in composite tool_call strings", () => {
    const segmenter = new EpisodeSegmenter();
    const extractor = new SignatureExtractor();
    const events = [
      createToolCallEvent({
        eventId: "c1",
        sessionId: "sess-c",
        toolName: "bash",
        parameters: { command: "git log --oneline -5 && git status --porcelain" },
      }),
      createToolCallEvent({
        eventId: "c2",
        sessionId: "sess-c",
        toolName: "bash",
        parameters: { command: "wc -l README.md | head -5" },
      }),
    ];
    const [episode] = segmenter.segmentEvents(events);
    const sig = extractor.extractSignature(episode);
    expect(sig.commandPatterns).toContain("git log --oneline -5");
    expect(sig.commandPatterns).toContain("git status --porcelain");
    expect(sig.commandPatterns).toContain("wc -l $DOC_FILE");
    expect(sig.commandPatterns).toContain("head -5");
    expect(sig.commandPatterns).not.toContain("git log --oneline -5 && git status --porcelain");
  });

  it("splits composite command_exec events into per-segment profiles", () => {
    const segmenter = new EpisodeSegmenter();
    const extractor = new SignatureExtractor();
    const events = [
      createCommandExecEvent({
        eventId: "d1",
        sessionId: "sess-d",
        command: "git diff --stat && git branch --show-current",
      }),
    ];
    const [episode] = segmenter.segmentEvents(events);
    const sig = extractor.extractSignature(episode);
    expect(sig.commandPatterns).toContain("git diff --stat");
    expect(sig.commandPatterns).toContain("git branch --show-current");
  });
});
