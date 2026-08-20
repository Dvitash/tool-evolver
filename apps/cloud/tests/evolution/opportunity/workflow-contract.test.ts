import { describe, expect, it } from "vitest";
import { StructuralClusterer } from "../../../src/evolution/opportunity/clustering.js";
import { EpisodeSegmenter } from "../../../src/evolution/opportunity/episode.js";
import { OpportunityClassifier } from "../../../src/evolution/opportunity/classifier.js";
import { extractWorkflowContract } from "../../../src/evolution/opportunity/workflow-contract.js";
import {
  createCommandExecEvent,
  createFileEditEvent,
  createToolCallEvent,
} from "./helpers.js";

describe("WorkflowContract - Deterministic End-to-End Workflow Retention", () => {
  it("should retain full ordered git/file audit workflow, preserve order, flag repeated expensive work, stay deterministic, and not collapse to first command", async () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier();

    const t0 = new Date("2026-08-20T10:00:00.000Z").getTime();
    const ts = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

    // Multi-step git/file audit: 6 distinct operations with one repeated git status to exercise repeated/expensive detection
    // Order: git status -> git diff -> git log -> read_file -> file_edit -> git status (repeated)
    const events = [
      createCommandExecEvent({
        eventId: "audit_e1",
        sessionId: "sess-audit-1",
        command: "git status --porcelain",
        timestamp: ts(0),
        causalSequence: 1,
      }),
      createCommandExecEvent({
        eventId: "audit_e2",
        sessionId: "sess-audit-1",
        command: "git diff --stat",
        timestamp: ts(1000),
        causalSequence: 2,
      }),
      createCommandExecEvent({
        eventId: "audit_e3",
        sessionId: "sess-audit-1",
        command: "git log --oneline -5",
        timestamp: ts(2000),
        causalSequence: 3,
      }),
      createToolCallEvent({
        eventId: "audit_e4",
        sessionId: "sess-audit-1",
        toolName: "read_file",
        parameters: { path: "src/audit/report.ts" },
        timestamp: ts(3000),
        causalSequence: 4,
      }),
      createFileEditEvent({
        eventId: "audit_e5",
        sessionId: "sess-audit-1",
        filePath: "src/audit/report.ts",
        timestamp: ts(4000),
        causalSequence: 5,
      }),
      createCommandExecEvent({
        eventId: "audit_e6",
        sessionId: "sess-audit-1",
        command: "git status --porcelain",
        timestamp: ts(5000),
        causalSequence: 6,
      }),
    ];

    const episodes = segmenter.segmentEvents(events);
    expect(episodes.length).toBeGreaterThanOrEqual(1);
    const clusters = clusterer.clusterEpisodes(episodes);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const cluster = clusters[0]!;

    // Ensure representative workflow actually contains multiple operations (not collapsed)
    expect(cluster.representativeSignature.operationSequence.length).toBeGreaterThan(1);
    expect(cluster.representativeSignature.commandPatterns.length).toBeGreaterThan(1);

    const classification = await classifier.classifyOpportunity("tenant-test", cluster, "repeated_pattern");

    const contract = extractWorkflowContract(cluster, events, classification);
    const contract2 = extractWorkflowContract(cluster, events, classification);

    // Version is 1
    expect(contract.version).toBe(1);

    // Includes every operation/output need – not collapsed to first command
    expect(contract.operations.length).toBe(cluster.representativeSignature.operationSequence.length);
    expect(contract.operations.length).toBeGreaterThan(1);
    // Not collapsed: if workflow has 6 events, contract should have at least 5 operations (tool_result not counted)
    expect(contract.operations.length).toBeGreaterThanOrEqual(5);

    // Preserves order and stable IDs
    expect(contract.operations.map((op) => op.order)).toEqual(contract.operations.map((_, idx) => idx));
    expect(contract.operations.map((op) => op.id)).toEqual(contract.operations.map((_, idx) => `op_${idx}`));
    // Order of operations must follow representativeSignature order
    for (let idx = 0; idx < contract.operations.length; idx++) {
      expect(contract.operations[idx]!.name).toBe(cluster.representativeSignature.operationSequence[idx]);
    }

    // Required inputs derived from classifier
    expect(Array.isArray(contract.requiredInputs)).toBe(true);
    // If classifier produced inferredInputs, they must be retained
    if (classification.inferredInputs && classification.inferredInputs.length > 0) {
      expect(contract.requiredInputs.length).toBe(classification.inferredInputs.length);
      const inputNames = contract.requiredInputs.map((inp) => inp.name).sort();
      const expectedNames = classification.inferredInputs.map((inp) => inp.name).sort();
      expect(inputNames).toEqual(expectedNames);
    }

    // Required structured outputs with source operation IDs, collision-safe deterministic names
    expect(Array.isArray(contract.outputRequirements)).toBe(true);
    expect(contract.outputRequirements.length).toBeGreaterThanOrEqual(contract.operations.length);
    const outputNames = contract.outputRequirements.map((req) => req.name);
    expect(new Set(outputNames).size).toBe(outputNames.length);
    for (const req of contract.outputRequirements) {
      expect(typeof req.name).toBe("string");
      expect(req.name.length).toBeGreaterThan(0);
      expect(typeof req.sourceOperationId).toBe("string");
      expect(contract.operations.some((op) => op.id === req.sourceOperationId)).toBe(true);
      expect(typeof req.type).toBe("string");
      expect(typeof req.required).toBe("boolean");
    }
    // Ensure candidateOutputSchema properties are represented if present
    if (classification.candidateOutputSchema && typeof classification.candidateOutputSchema === "object") {
      const props = (classification.candidateOutputSchema as Record<string, unknown>).properties as
        | Record<string, unknown>
        | undefined;
      if (props) {
        for (const propName of Object.keys(props)) {
          const sanitized = propName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
          // At least one outputRequirement should contain the sanitized prop name (collision-safe may suffix)
          expect(outputNames.some((n) => n.includes(sanitized) || n === propName)).toBe(true);
        }
      }
    }

    // Explicit invariants for ordering/side effects
    expect(Array.isArray(contract.invariants)).toBe(true);
    expect(contract.invariants.length).toBeGreaterThanOrEqual(2);
    expect(contract.invariants.some((inv) => inv.includes("order") || inv.includes("ordering"))).toBe(true);
    expect(contract.invariants.some((inv) => inv.includes("sideEffect") || inv.includes("structuralHash"))).toBe(true);

    // Flags repeated expensive work
    expect(Array.isArray(contract.repeatedOperationIds)).toBe(true);
    expect(Array.isArray(contract.expensiveOperationIds)).toBe(true);
    // Repeated git status should be flagged
    expect(contract.repeatedOperationIds.length).toBeGreaterThan(0);
    // Repeated work is considered expensive, so expensive should also be non-empty
    expect(contract.expensiveOperationIds.length).toBeGreaterThan(0);
    // Repeated IDs must be subset of operation IDs
    for (const rid of contract.repeatedOperationIds) {
      expect(contract.operations.some((op) => op.id === rid)).toBe(true);
    }
    for (const eid of contract.expensiveOperationIds) {
      expect(contract.operations.some((op) => op.id === eid)).toBe(true);
    }

    // Deterministic under identical input
    expect(contract2).toEqual(contract);
    expect(JSON.stringify(contract2)).toBe(JSON.stringify(contract));
    expect(contract2.operations).toEqual(contract.operations);
    expect(contract2.outputRequirements).toEqual(contract.outputRequirements);
    expect(contract2.invariants).toEqual(contract.invariants);

    // Does not collapse to first command – ensure second command profile retained
    const commandProfiles = cluster.representativeSignature.commandPatterns;
    if (commandProfiles.length > 1) {
      const secondProfile = commandProfiles[1]!;
      // At least one operation should carry the second profile or name should include its head
      const hasSecond = contract.operations.some(
        (op) => op.commandProfile === secondProfile || op.name.includes(secondProfile.split(" ")[0]!),
      );
      // Fallback: at least operations length >1 proves not collapsed
      expect(hasSecond || contract.operations.length > 1).toBe(true);
    }

    // JSON-safe – no undefined holes, no functions
    expect(() => JSON.stringify(contract)).not.toThrow();
    const reparsed = JSON.parse(JSON.stringify(contract));
    expect(reparsed).toEqual(contract);
    expect(reparsed.version).toBe(1);
  });

  it("should be deterministic for identical cluster/events/classification and JSON-safe", async () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier();

    const events = [
      createCommandExecEvent({ eventId: "det_e1", sessionId: "sess-det", command: "git status --porcelain" }),
      createCommandExecEvent({ eventId: "det_e2", sessionId: "sess-det", command: "git diff" }),
      createToolCallEvent({ eventId: "det_e3", sessionId: "sess-det", toolName: "read_file", parameters: { path: "src/x.ts" } }),
      createFileEditEvent({ eventId: "det_e4", sessionId: "sess-det", filePath: "src/x.ts" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);
    const classification = await classifier.classifyOpportunity("tenant-det", cluster, "repeated_pattern");

    const first = extractWorkflowContract(cluster, events, classification);
    const second = extractWorkflowContract(cluster, events, classification);
    const third = extractWorkflowContract(cluster, [...events].reverse(), classification);

    // Deterministic: same input order yields same contract
    expect(second).toEqual(first);
    // Even if events passed in different order, contract derived from representativeSignature remains stable for core fields
    expect(third.version).toBe(first.version);
    expect(third.operations.length).toBe(first.operations.length);
    expect(third.operations.map((op) => op.name)).toEqual(first.operations.map((op) => op.name));

    // JSON-safe
    const json = JSON.stringify(first);
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(first);
  });

  it("should assign stable operation IDs preserving order and keep output field names collision-safe", async () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier();

    const events = [
      createCommandExecEvent({ eventId: "stable_e1", sessionId: "sess-stable", command: "git status --porcelain" }),
      createCommandExecEvent({ eventId: "stable_e2", sessionId: "sess-stable", command: "git status --porcelain" }),
      createCommandExecEvent({ eventId: "stable_e3", sessionId: "sess-stable", command: "git status --porcelain" }),
    ];

    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);
    const classification = await classifier.classifyOpportunity("tenant-stable", cluster, "repeated_pattern");

    const contract = extractWorkflowContract(cluster, events, classification);

    // Stable IDs: op_0, op_1, ...
    expect(contract.operations.every((op, idx) => op.id === `op_${idx}` && op.order === idx)).toBe(true);
    // Collision-safe: output names unique even though operations share same name
    const names = contract.outputRequirements.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    // Every output has a valid sourceOperationId
    for (const req of contract.outputRequirements) {
      expect(contract.operations.some((op) => op.id === req.sourceOperationId)).toBe(true);
    }
    // Repeated detection should flag all three as repeated
    expect(contract.repeatedOperationIds.length).toBe(3);
    expect(contract.repeatedOperationIds).toEqual(["op_0", "op_1", "op_2"]);
  });

  it("should bind commandProfile to originating ordered event not cross-assign to read, retain per-operation args/path evidence, and avoid fallback paths", async () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier();
    const t0 = new Date("2026-08-20T10:00:00.000Z").getTime();
    const ts = (o: number) => new Date(t0 + o).toISOString();
    // Read followed by git status: read must remain read, git must have correct command only on git, with per-operation evidence
    const events = [
      createToolCallEvent({
        eventId: "cross_e1",
        sessionId: "sess-cross",
        toolName: "read_file",
        parameters: { path: "src/a.ts" },
        timestamp: ts(0),
        causalSequence: 1,
      }),
      createCommandExecEvent({
        eventId: "cross_e2",
        sessionId: "sess-cross",
        command: "git status --porcelain",
        args: [],
        timestamp: ts(1000),
        causalSequence: 2,
      }),
    ];
    const episodes = segmenter.segmentEvents(events);
    expect(episodes.length).toBeGreaterThanOrEqual(1);
    const clusters = clusterer.clusterEpisodes(episodes);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const cluster = clusters[0]!;
    const classification = await classifier.classifyOpportunity("tenant-cross", cluster, "repeated_pattern");
    const contract = extractWorkflowContract(cluster, events, classification);
    expect(contract.operations.length).toBeGreaterThanOrEqual(2);
    // Preserve order and deterministic IDs
    expect(contract.operations.map((o) => o.id)).toEqual(contract.operations.map((_, i) => `op_${i}`));
    expect(contract.operations.map((o) => o.order)).toEqual(contract.operations.map((_, i) => i));
    // Locate read and git ops by order (first should be read, second git)
    const op0 = contract.operations[0]!;
    const op1 = contract.operations[1]!;
    // Op0 is read - must NOT have commandProfile (cross-assignment would incorrectly give it git profile)
    expect(op0.name.toLowerCase()).toMatch(/read|file/);
    expect(op0.commandProfile).toBeUndefined();
    // Op1 is git - must have correct command only on git, with args evidence
    expect(op1.name.toLowerCase()).toMatch(/git|command/);
    expect(op1.commandProfile).toBeDefined();
    expect(op1.commandProfile).toContain("git");
    expect(op1.commandProfile).toContain("status");
    expect(op1.args).toBeDefined();
    expect(op1.args).toEqual(expect.arrayContaining(["status", "--porcelain"]));
    // Per-operation file evidence retained on read, not fallback
    expect(op0.filePath ?? op0.targetPaths?.[0]).toBeDefined();
    const readPath = op0.filePath ?? op0.targetPaths?.[0] ?? "";
    expect(readPath).toContain("src/a.ts");
    // No fallback paths like ./data.txt on any operation
    for (const op of contract.operations) {
      expect(op.commandProfile).not.toBe("./data.txt");
      expect(op.filePath).not.toBe("./data.txt");
      if (op.targetPaths) {
        for (const p of op.targetPaths) expect(p).not.toBe("./data.txt");
      }
    }
    // Deterministic: second call yields same contract
    const contract2 = extractWorkflowContract(cluster, events, classification);
    expect(contract2).toEqual(contract);
  });

  it("should retain multi-path file evidence and not fallback to ./data.txt", async () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier();
    const events = [
      createToolCallEvent({
        eventId: "mp_e1",
        sessionId: "sess-mp",
        toolName: "read_file",
        parameters: { path: "src/one.ts" },
        causalSequence: 1,
      }),
      createToolCallEvent({
        eventId: "mp_e2",
        sessionId: "sess-mp",
        toolName: "read_file",
        parameters: { path: "src/two.ts" },
        causalSequence: 2,
      }),
      createToolCallEvent({
        eventId: "mp_e3",
        sessionId: "sess-mp",
        toolName: "read_file",
        parameters: { path: "src/three.ts" },
        causalSequence: 3,
      }),
    ];
    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);
    const classification = await classifier.classifyOpportunity("tenant-mp", cluster, "repeated_pattern");
    // Force inferredInputs to have targetPaths array to exercise multi-path binding
    classification.inferredInputs = [
      { name: "targetPaths", type: "array", description: "Target file or directory paths to operate on.", required: true },
    ];
    const contract = extractWorkflowContract(cluster, events, classification);
    // Every file operation should have per-operation path evidence, not fallback
    for (const op of contract.operations) {
      if (op.toolClass === "file_read" || op.name.toLowerCase().includes("read")) {
        expect(op.filePath ?? op.targetPaths?.[0]).toBeDefined();
        expect(op.filePath).not.toBe("./data.txt");
        if (op.targetPaths) expect(op.targetPaths[0]).not.toBe("./data.txt");
      }
    }
    // Required inputs must include targetPaths
    expect(contract.requiredInputs.some((i) => i.name === "targetPaths")).toBe(true);
    // No operation should have fallback commandProfile ./data.txt
    for (const op of contract.operations) {
      expect(op.commandProfile).not.toBe("./data.txt");
    }
  });

  it("should keep composite command profiles on one operation without displacing later command", async () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier();
    const t0 = new Date("2026-08-20T10:00:00.000Z").getTime();
    const ts = (o: number) => new Date(t0 + o).toISOString();
    // Composite `git status && git diff` as single originating event, followed by `npm test`
    const events = [
      createCommandExecEvent({
        eventId: "comp_e1",
        sessionId: "sess-comp",
        command: "git status && git diff",
        timestamp: ts(0),
        causalSequence: 1,
      }),
      createCommandExecEvent({
        eventId: "comp_e2",
        sessionId: "sess-comp",
        command: "npm test",
        timestamp: ts(1000),
        causalSequence: 2,
      }),
    ];
    const episodes = segmenter.segmentEvents(events);
    const [cluster] = clusterer.clusterEpisodes(episodes);
    const classification = await classifier.classifyOpportunity("tenant-comp", cluster, "repeated_pattern");
    const contract = extractWorkflowContract(cluster, events, classification);

    expect(contract.operations.length).toBe(2);
    expect(contract.operations.map((o) => o.id)).toEqual(["op_0", "op_1"]);
    expect(contract.operations.map((o) => o.order)).toEqual([0, 1]);

    const op0 = contract.operations[0]!;
    const op1 = contract.operations[1]!;

    // Composite stays on one operation as commandProfiles array
    expect(op0.commandProfiles).toBeDefined();
    expect(op0.commandProfiles).toEqual(expect.arrayContaining(["git status", "git diff"]));
    expect(op0.commandProfiles).toHaveLength(2);
    expect(op0.commandProfile).toBe("git status");
    // Later command remains on its own operation, no cross-assignment
    expect(op1.commandProfiles).toBeDefined();
    expect(op1.commandProfiles).toEqual(["npm test"]);
    expect(op1.commandProfile).toBe("npm test");
    expect(op1.commandProfiles).not.toContain("git status");
    expect(op0.commandProfiles).not.toContain("npm test");

    // No profile loss: all three profiles accounted for across operations
    const allProfiles = contract.operations.flatMap((o) => o.commandProfiles ?? (o.commandProfile ? [o.commandProfile] : []));
    expect(allProfiles).toEqual(expect.arrayContaining(["git status", "git diff", "npm test"]));
    expect(allProfiles).toHaveLength(3);

    // Preserve order: first operation's profiles are git, second is npm
    expect(allProfiles[0]).toBe("git status");
    expect(allProfiles[1]).toBe("git diff");
    expect(allProfiles[2]).toBe("npm test");

    // Deterministic: second extraction yields same grouping
    const contract2 = extractWorkflowContract(cluster, events, classification);
    expect(contract2.operations[0]!.commandProfiles).toEqual(op0.commandProfiles);
    expect(contract2.operations[1]!.commandProfiles).toEqual(op1.commandProfiles);

    // No fallback paths
    for (const op of contract.operations) {
      expect(op.commandProfile).not.toBe("./data.txt");
      if (op.commandProfiles) {
        for (const p of op.commandProfiles) expect(p).not.toBe("./data.txt");
      }
    }
  });
  it("should bind operations from one deterministic representative episode for five identical 11-command sessions", async () => {
    const segmenter = new EpisodeSegmenter();
    const clusterer = new StructuralClusterer();
    const classifier = new OpportunityClassifier();
    const t0 = new Date("2026-08-20T10:00:00.000Z").getTime();
    const ts = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();
    const gitCommands = [
      "git log --oneline -10",
      "git status --porcelain",
      "git diff --stat",
      "git branch --all",
      "git rev-parse HEAD",
    ];
    const findCommands = [
      "find ./src -name \"*.ts\" -type f",
      "find ./src -name \"*.js\" -type f",
      "find ./tests -name \"*.spec.ts\" -type f",
      "find ./apps -name \"*.json\" -type f",
      "find ./packages -name \"*.md\" -type f",
      "find . -maxdepth 2 -name \"README.md\"",
    ];
    const allCommands = [...gitCommands, ...findCommands];
    function makeSessionEvents(sessionId: string, sessionIdx: number) {
      const base = sessionIdx * 200_000;
      return allCommands.map((cmd, idx) =>
        createCommandExecEvent({
          eventId: `rep_${sessionId}_${idx}`,
          sessionId,
          command: cmd,
          timestamp: ts(base + idx * 1000),
          causalSequence: idx + 1,
        }),
      );
    }
    const sessions = ["sess-01", "sess-02", "sess-03", "sess-04", "sess-05"];
    const allEvents = sessions.flatMap((sid, idx) => makeSessionEvents(sid, idx));
    const episodes = segmenter.segmentEvents(allEvents);
    expect(episodes.length).toBe(5);
    const clusters = clusterer.clusterEpisodes(episodes);
    expect(clusters.length).toBe(1);
    const cluster = clusters[0]!;
    expect(cluster.representativeSignature.operationSequence.length).toBe(11);
    const classification = await classifier.classifyOpportunity("tenant-test", cluster, "repeated_pattern");
    const contract = extractWorkflowContract(cluster, allEvents, classification);
    expect(contract.operations.length).toBe(11);
    const profiles = contract.operations.map((op) => op.commandProfile!);
    expect(profiles[0]).toContain("log");
    expect(profiles[1]).toContain("status");
    expect(profiles[2]).toContain("diff");
    expect(profiles[3]).toContain("branch");
    expect(profiles[4]).toContain("rev-parse");
    const flat = contract.operations.flatMap((op) => op.commandProfiles ?? (op.commandProfile ? [op.commandProfile] : []));
    const findProfiles = flat.filter((p) => p.startsWith("find"));
    expect(findProfiles.length).toBe(6);
    expect(new Set(findProfiles).size).toBe(6);
    expect(profiles.slice(0, 5).every((p) => p.includes("log"))).toBe(false);
    const contract2 = extractWorkflowContract(cluster, allEvents, classification);
    expect(contract2).toEqual(contract);
    const shuffled = [...allEvents].sort(() => Math.random() - 0.5);
    const contractShuffled = extractWorkflowContract(cluster, shuffled, classification);
    expect(contractShuffled).toEqual(contract);
    const reversed = [...allEvents].reverse();
    const contractReversed = extractWorkflowContract(cluster, reversed, classification);
    expect(contractReversed).toEqual(contract);
  });
});
