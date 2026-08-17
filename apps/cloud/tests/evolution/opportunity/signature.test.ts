import { describe, expect, it } from "vitest";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import {
  classifyToolOrCommand,
  normalizePathAlias,
  SignatureExtractor,
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
    expect(classifyToolOrCommand("agent")).toBe("subagent");
  });

  it("should extract identical structural hashes for isomorphic workflows with different filenames", () => {
    const segmenter = new EpisodeSegmenter();
    const extractor = new SignatureExtractor();

    // Workflow A: read source file, edit source file, run vitest
    const eventsA = [
      createToolCallEvent({ eventId: "a1", sessionId: "sess-a", toolName: "read_file", parameters: { path: "src/auth/service.ts" } }),
      createToolResultEvent({ eventId: "a2", sessionId: "sess-a", toolCallId: "a1", result: "..." }),
      createFileEditEvent({ eventId: "a3", sessionId: "sess-a", filePath: "src/auth/service.ts" }),
      createCommandExecEvent({ eventId: "a4", sessionId: "sess-a", command: "vitest run tests/auth.test.ts" }),
    ];

    // Workflow B: read another source file, edit another source file, run vitest (different session & concrete paths)
    const eventsB = [
      createToolCallEvent({ eventId: "b1", sessionId: "sess-b", toolName: "read_file", parameters: { path: "src/storage/store.ts" } }),
      createToolResultEvent({ eventId: "b2", sessionId: "sess-b", toolCallId: "b1", result: "..." }),
      createFileEditEvent({ eventId: "b3", sessionId: "sess-b", filePath: "src/storage/store.ts" }),
      createCommandExecEvent({ eventId: "b4", sessionId: "sess-b", command: "vitest run tests/storage.test.ts" }),
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
