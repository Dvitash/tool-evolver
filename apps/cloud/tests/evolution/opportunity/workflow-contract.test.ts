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
});
