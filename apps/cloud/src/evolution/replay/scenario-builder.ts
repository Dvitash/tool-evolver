import { randomUUID } from "node:crypto";
import type { NormalizedSessionEvent, ToolManifest } from "@tool-evolver/contracts";
import type {
  AllowedBrokerOperation,
  CandidateTarget,
  EvidenceSource,
  HistoricalReplayOptions,
  ReplayBaselineMetrics,
  ReplayInvariant,
  ReplayScenario,
  ReplayScenarioType,
  VirtualBrokerState,
} from "./types.js";
import { DeterministicRandom, VirtualBrokerReconstructor } from "./virtual-broker.js";

/**
 * Derives inputs, expected invariants, and baseline metrics from historical workflow episodes.
 */
export class ReplayScenarioBuilder {
  /**
   * Constructs deterministic replay scenarios from evidence and candidate definition.
   */
  buildScenarios(
    evidence: EvidenceSource,
    candidate: CandidateTarget,
    options: HistoricalReplayOptions = {},
  ): ReplayScenario[] {
    const events = VirtualBrokerReconstructor.extractEvents(evidence);
    const rng = new DeterministicRandom(options.seed ?? 42);
    const scenarios: ReplayScenario[] = [];

    const evidenceEventIds = events.map((e) =>
      "eventId" in e
        ? e.eventId
        : "id" in e
          ? String((e as { id: unknown }).id)
          : "unknown-event-id",
    );
    const evidenceRevision =
      "evidenceSet" in evidence && typeof evidence.evidenceSet?.revision === "number"
        ? evidence.evidenceSet.revision
        : "revision" in evidence && typeof evidence.revision === "number"
          ? evidence.revision
          : 1;
    const sourceEpisodeId =
      "evidenceSet" in evidence && typeof evidence.evidenceSet?.id === "string"
        ? evidence.evidenceSet.id
        : "id" in evidence && typeof evidence.id === "string"
          ? evidence.id
          : `ep-${evidenceEventIds[0] ?? "unknown"}`;

    const manifest: ToolManifest | Partial<ToolManifest> =
      "manifest" in candidate && candidate.manifest
        ? candidate.manifest
        : "proposedTool" in candidate && candidate.proposedTool
          ? candidate.proposedTool
          : { name: "candidate_tool" };

    const virtualBaseState = VirtualBrokerReconstructor.buildFromEvents(events);
    const baselineMetrics = this.computeBaselineMetrics(events);
    const allowedOps = this.deriveAllowedBrokerOperations(candidate);
    const primaryInput = this.derivePrimaryInput(events, manifest, virtualBaseState);

    // 1. Primary Observed Episode Scenario
    const primaryScenario: ReplayScenario = {
      id: `scenario-obs-${rng.nextUuid().slice(0, 8)}`,
      name: `Replay Observed Episode: ${manifest.name ?? "candidate"}`,
      description: `Replays historical episode against reconstructed virtual state with exact inputs.`,
      type: "observed_episode",
      sourceEpisodeId,
      evidenceEventIds,
      evidenceRevision,
      input: primaryInput,
      virtualState: {
        fs: { ...virtualBaseState.fs, files: { ...virtualBaseState.fs?.files } },
        net: { ...virtualBaseState.net, routes: { ...virtualBaseState.net?.routes } },
        cmd: { ...virtualBaseState.cmd, commands: { ...virtualBaseState.cmd?.commands } },
        secrets: { ...virtualBaseState.secrets, values: { ...virtualBaseState.secrets?.values } },
      },
      invariants: this.buildPrimaryInvariants(manifest, events),
      allowedBrokerOperations: allowedOps,
      baselineMetrics,
      expectedOutcome: "success",
      metadata: {
        eventCount: events.length,
        extractedInputKeys: Object.keys(primaryInput),
      },
    };
    scenarios.push(primaryScenario);

    // 2. Counterfactual Scenario
    if (options.includeCounterfactualScenarios !== false) {
      const counterfactualScenario = this.synthesizeCounterfactualScenario(
        primaryScenario,
        manifest,
        rng,
      );
      if (counterfactualScenario) {
        scenarios.push(counterfactualScenario);
      }
    }

    // 3. Negative Scenarios (Missing file, network failure, malformed inputs, permission error, command failure)
    if (options.includeNegativeScenarios !== false) {
      const negativeScenarios = this.synthesizeNegativeScenarios(
        primaryScenario,
        manifest,
        rng,
        candidate,
      );
      scenarios.push(...negativeScenarios);
    }

    return scenarios;
  }

  /**
   * Computes baseline execution metrics from observed historical session events.
   */
  private computeBaselineMetrics(events: NormalizedSessionEvent[]): ReplayBaselineMetrics {
    let stepCount = 0;
    let totalTokens = 0;
    let totalDurationMs = 0;
    let toolCallsCount = 0;
    let errorCount = 0;

    let minTimestamp: number | null = null;
    let maxTimestamp: number | null = null;

    for (const ev of events) {
      if (!ev) continue;
      if (ev.timestamp) {
        const ts = Date.parse(ev.timestamp);
        if (!Number.isNaN(ts)) {
          if (minTimestamp === null || ts < minTimestamp) minTimestamp = ts;
          if (maxTimestamp === null || ts > maxTimestamp) maxTimestamp = ts;
        }
      }

      if (ev.type === "tool_call") {
        stepCount++;
        toolCallsCount++;
      } else if (ev.type === "file_edit") {
        stepCount++;
        toolCallsCount++;
      } else if (ev.type === "command_exec") {
        stepCount++;
        toolCallsCount++;
        const ce = ev as unknown as { durationMs?: number; exitCode?: number };
        if (ce.durationMs) totalDurationMs += ce.durationMs;
        if (typeof ce.exitCode === "number" && ce.exitCode !== 0) errorCount++;
      } else if (ev.type === "tool_result") {
        const tr = ev as unknown as { executionDurationMs?: number; isError?: boolean };
        if (tr.executionDurationMs) totalDurationMs += tr.executionDurationMs;
        if (tr.isError) errorCount++;
      } else if (ev.type === "model_reasoning") {
        const mr = ev as unknown as { tokenCount?: number; durationMs?: number };
        if (mr.tokenCount) totalTokens += mr.tokenCount;
        if (mr.durationMs) totalDurationMs += mr.durationMs;
      } else if (ev.type === "message") {
        const msg = ev as unknown as { tokenCount?: number };
        if (msg.tokenCount) totalTokens += msg.tokenCount;
      }
    }

    if (
      totalDurationMs === 0 &&
      minTimestamp !== null &&
      maxTimestamp !== null &&
      maxTimestamp >= minTimestamp
    ) {
      totalDurationMs = maxTimestamp - minTimestamp;
    }
    if (totalDurationMs === 0) {
      totalDurationMs = Math.max(stepCount * 50, 100);
    }
    if (stepCount === 0) {
      stepCount = Math.max(events.length, 1);
    }
    if (totalTokens === 0) {
      totalTokens = stepCount * 150;
    }

    const estimatedCostUsd = (totalTokens / 1000) * 0.003;

    return {
      stepCount,
      totalTokens,
      totalDurationMs,
      toolCallsCount: Math.max(toolCallsCount, stepCount),
      estimatedCostUsd,
      errorCount,
    };
  }

  /**
   * Derives input parameter map for candidate tool from observed events and manifest parameter schema.
   */
  private derivePrimaryInput(
    events: NormalizedSessionEvent[],
    manifest: ToolManifest | Partial<ToolManifest>,
    virtualState: VirtualBrokerState,
  ): Record<string, unknown> {
    const derived: Record<string, unknown> = {};

    const paramsSchema = manifest.parameters as
      | { properties?: Record<string, { type?: string; default?: unknown }> }
      | undefined;
    const properties = paramsSchema?.properties ?? {};

    const observedPaths: string[] = [];
    const observedQueries: string[] = [];
    const observedCommands: string[] = [];
    const observedUrls: string[] = [];

    for (const ev of events) {
      if (ev.type === "tool_call") {
        const tc = ev as unknown as { parameters?: Record<string, unknown> };
        const p = tc.parameters ?? {};
        for (const [k, v] of Object.entries(p)) {
          if (typeof v === "string") {
            if (k.toLowerCase().includes("path") || k.toLowerCase().includes("file"))
              observedPaths.push(v);
            if (
              k.toLowerCase().includes("query") ||
              k.toLowerCase().includes("pattern") ||
              k.toLowerCase().includes("search")
            )
              observedQueries.push(v);
            if (k.toLowerCase().includes("cmd") || k.toLowerCase().includes("command"))
              observedCommands.push(v);
            if (k.toLowerCase().includes("url") || k.toLowerCase().includes("uri"))
              observedUrls.push(v);
          }
        }
      }
      if (ev.type === "command_exec") {
        const ce = ev as unknown as { command?: string; args?: string[] };
        if (ce.command) {
          observedCommands.push([ce.command, ...(ce.args ?? [])].join(" "));
        }
      }
      if (ev.type === "file_edit") {
        const fd = ev as unknown as { filePath?: string };
        if (fd.filePath) observedPaths.push(fd.filePath);
      }
    }

    const availableFiles = Object.keys(virtualState.fs?.files ?? {});

    for (const [propName, propDef] of Object.entries(properties)) {
      const lower = propName.toLowerCase();
      if (lower.includes("path") || lower.includes("file") || lower.includes("target")) {
        derived[propName] = observedPaths[0] ?? availableFiles[0] ?? "/workspace/main.ts";
      } else if (
        lower.includes("query") ||
        lower.includes("pattern") ||
        lower.includes("search") ||
        lower.includes("filter")
      ) {
        derived[propName] = observedQueries[0] ?? "export";
      } else if (lower.includes("cmd") || lower.includes("command")) {
        derived[propName] = observedCommands[0] ?? "npm test";
      } else if (lower.includes("url") || lower.includes("uri") || lower.includes("host")) {
        derived[propName] = observedUrls[0] ?? "https://api.example.com/v1/resource";
      } else if (propDef.default !== undefined) {
        derived[propName] = propDef.default;
      } else if (propDef.type === "number" || propDef.type === "integer") {
        derived[propName] = 10;
      } else if (propDef.type === "boolean") {
        derived[propName] = true;
      } else if (propDef.type === "array") {
        derived[propName] = [];
      } else {
        derived[propName] = `fixture_${propName}`;
      }
    }

    if (Object.keys(derived).length === 0) {
      if (availableFiles.length > 0) {
        derived.filePath = availableFiles[0];
      }
      if (observedQueries.length > 0) {
        derived.query = observedQueries[0];
      }
      if (Object.keys(derived).length === 0) {
        derived.input = "test_sample_data";
      }
    }

    return derived;
  }

  /**
   * Derives allowed broker operations based on required capabilities and manifests.
   */
  private deriveAllowedBrokerOperations(candidate: CandidateTarget): AllowedBrokerOperation[] {
    const allowed: AllowedBrokerOperation[] = [];
    const caps =
      "requiredCapabilities" in candidate && candidate.requiredCapabilities
        ? candidate.requiredCapabilities
        : undefined;
    if (!caps) return allowed;

    const regexEscape = String.fromCharCode(92);
    const regexSpecials = new Set([
      regexEscape,
      ".",
      "*",
      "+",
      "?",
      "^",
      "$",
      "{",
      "}",
      "(",
      ")",
      "|",
      "[",
      "]",
    ]);
    const escapeRegex = (value: string): string =>
      Array.from(value, (character) =>
        regexSpecials.has(character) ? `${regexEscape}${character}` : character,
      ).join("");

    const fsPaths = [...(caps.fs.readPaths ?? []), ...(caps.fs.writePaths ?? [])];
    if (fsPaths.length > 0 || caps.fs.allowWorkspaceRoot || caps.fs.allowTemp) {
      allowed.push({
        service: "fs",
        operation: "*",
        pathPattern:
          fsPaths.length > 0
            ? fsPaths.map(escapeRegex).join("|")
            : caps.fs.allowWorkspaceRoot
              ? ".*"
              : "^/tmp(?:/|$)",
      });
    }

    if (caps.net.allowOutbound || caps.net.allowLocalhost) {
      const hosts = [...(caps.net.allowedHosts ?? []), ...(caps.net.allowedDomains ?? [])];
      allowed.push({
        service: "net",
        operation: "*",
        urlPattern: hosts.length > 0 ? hosts.map(escapeRegex).join("|") : "(?!)",
      });
    }

    const commandProfiles = (caps.command.allowedCommands ?? []).filter(
      (value) => value && !value.startsWith("$"),
    );
    const commandBinaries = (caps.command.allowedBinaries ?? []).filter(
      (value) => value && !value.startsWith("$"),
    );
    if (
      caps.command.allowShellExecution ||
      commandProfiles.length > 0 ||
      commandBinaries.length > 0
    ) {
      const commandPattern = caps.command.allowShellExecution
        ? ".*"
        : `^(?:${[
            ...commandProfiles.map((value) => escapeRegex(value)),
            ...commandBinaries.map((value) => `${escapeRegex(value)}(?:\\s|$)`),
          ].join("|")})`;
      allowed.push({ service: "cmd", operation: "*", commandPattern });
    }

    if (
      (caps.secrets.allowedSecretNames?.length ?? 0) > 0 ||
      (caps.secrets.allowedPrefixes?.length ?? 0) > 0
    ) {
      allowed.push({ service: "secret", operation: "createReference" });
    }

    return allowed;
  }

  /**
   * Formulates primary invariants for expected result and side effect containment.
   */
  private buildPrimaryInvariants(
    manifest: ToolManifest | Partial<ToolManifest>,
    events: NormalizedSessionEvent[],
  ): ReplayInvariant[] {
    const invariants: ReplayInvariant[] = [];

    // 1. Output schema compliance
    invariants.push({
      id: "inv-output-schema",
      name: "Output Schema Match",
      type: "output_schema",
      description: "Candidate tool output must conform to manifest output schema definition.",
      severity: "critical",
    });

    // 2. Side-effect containment
    invariants.push({
      id: "inv-side-effects",
      name: "Side-Effect Containment",
      type: "side_effect_containment",
      description:
        "Candidate must not invoke unauthorized broker operations outside declared boundaries.",
      severity: "critical",
    });

    // 3. No unauthorized mutations
    invariants.push({
      id: "inv-no-unauth-mutations",
      name: "No Unauthorized Mutations",
      type: "no_unauthorized_mutations",
      description: "Filesystem mutations must be contained within allowed workspace targets.",
      severity: "critical",
    });

    // 4. Operation ordering
    invariants.push({
      id: "inv-operation-ordering",
      name: "Causal Operation Ordering",
      type: "operation_ordering",
      description:
        "Operations must execute in valid causal order (e.g. read before write/execute).",
      severity: "warning",
    });

    // 5. Semantic equality check against last observed tool result if available and compatible
    const lastResultEvent = [...events].reverse().find((e) => e.type === "tool_result");
    if (lastResultEvent) {
      const tr = lastResultEvent as unknown as { result?: unknown };
      if (tr.result !== undefined && tr.result !== null) {
        const outSchema = manifest.outputSchema as
          | { properties?: Record<string, unknown> }
          | undefined;
        const schemaProps = outSchema?.properties ? Object.keys(outSchema.properties) : [];
        const isCompatible =
          schemaProps.length === 0 ||
          (typeof tr.result === "object" &&
            tr.result !== null &&
            Object.keys(tr.result as Record<string, unknown>).some((k) => schemaProps.includes(k)));

        if (isCompatible) {
          invariants.push({
            id: "inv-semantic-equality",
            name: "Semantic Result Equality",
            type: "semantic_equality",
            description: "Candidate output semantically matches historical episode outcome.",
            severity: "warning",
            expectedValue: tr.result,
          });
        }
      }
    }

    return invariants;
  }

  /**
   * Synthesizes a counterfactual scenario with modified input parameters or data.
   */
  private synthesizeCounterfactualScenario(
    primary: ReplayScenario,
    manifest: ToolManifest | Partial<ToolManifest>,
    rng: DeterministicRandom,
  ): ReplayScenario | null {
    const counterInput = { ...primary.input };
    const counterFsFiles = { ...(primary.virtualState.fs?.files ?? {}) };

    let modified = false;
    for (const [key, val] of Object.entries(counterInput)) {
      if (
        typeof val === "string" &&
        (key.toLowerCase().includes("path") || key.toLowerCase().includes("file"))
      ) {
        const altPath = "/workspace/counterfactual_target.ts";
        counterInput[key] = altPath;
        counterFsFiles[altPath] =
          "// Counterfactual file content\nexport const counterfactual = true;\n";
        modified = true;
        break;
      }
      if (
        typeof val === "string" &&
        (key.toLowerCase().includes("query") || key.toLowerCase().includes("pattern"))
      ) {
        counterInput[key] = `alt_${val}`;
        modified = true;
        break;
      }
    }

    if (!modified) {
      counterInput.counterfactualRun = true;
    }

    return {
      id: `scenario-cf-${rng.nextUuid().slice(0, 8)}`,
      name: `Counterfactual Variation: ${manifest.name ?? "candidate"}`,
      description: `Tests candidate tool robustness against perturbed inputs and state variations.`,
      type: "counterfactual",
      sourceEpisodeId: primary.sourceEpisodeId,
      evidenceEventIds: primary.evidenceEventIds,
      evidenceRevision: primary.evidenceRevision,
      input: counterInput,
      virtualState: {
        ...primary.virtualState,
        fs: {
          ...primary.virtualState.fs,
          files: counterFsFiles,
        },
      },
      invariants: [
        {
          id: "inv-cf-schema",
          name: "Counterfactual Schema Match",
          type: "output_schema",
          description: "Output on counterfactual inputs must satisfy schema constraints.",
          severity: "critical",
        },
        {
          id: "inv-cf-side-effects",
          name: "Counterfactual Side-Effect Containment",
          type: "side_effect_containment",
          description: "Side effects must remain within authorized boundaries.",
          severity: "critical",
        },
      ],
      allowedBrokerOperations: primary.allowedBrokerOperations,
      baselineMetrics: primary.baselineMetrics,
      expectedOutcome: "success",
    };
  }

  private synthesizeNegativeScenarios(
    primary: ReplayScenario,
    manifest: ToolManifest | Partial<ToolManifest>,
    rng: DeterministicRandom,
    candidate?: CandidateTarget,
  ): ReplayScenario[] {
    const negatives: ReplayScenario[] = [];
    const caps =
      candidate && "requiredCapabilities" in candidate ? candidate.requiredCapabilities : undefined;

    // 1. Missing file and permission error scenarios (if filesystem operations are involved)
    const targetFile = Object.values(primary.input).find(
      (v) => typeof v === "string" && (v.startsWith("/") || v.includes(".")),
    ) as string | undefined;
    const hasFsCapability = caps?.fs
      ? (caps.fs.readPaths && caps.fs.readPaths.length > 0) ||
        (caps.fs.writePaths && caps.fs.writePaths.length > 0)
      : false;
    const hasFiles =
      hasFsCapability && Object.keys(primary.virtualState.fs?.files ?? {}).length > 0;

    if (hasFsCapability && (targetFile || hasFiles)) {
      const fileToFail = targetFile ?? Object.keys(primary.virtualState.fs?.files ?? {})[0]!;
      negatives.push({
        id: `scenario-neg-file-${rng.nextUuid().slice(0, 8)}`,
        name: `Negative Missing File: ${manifest.name ?? "candidate"}`,
        description: `Simulates ENOENT file error on target path '${fileToFail}'.`,
        type: "negative_missing_file",
        sourceEpisodeId: primary.sourceEpisodeId,
        evidenceEventIds: primary.evidenceEventIds,
        evidenceRevision: primary.evidenceRevision,
        input: { ...primary.input },
        virtualState: {
          ...primary.virtualState,
          fs: {
            ...primary.virtualState.fs,
            simulateErrors: {
              [fileToFail]: "ENOENT",
            },
          },
        },
        invariants: [
          {
            id: "inv-neg-file-error",
            name: "Handled Missing File Error",
            type: "error_mapping",
            description: "Candidate must handle missing file error gracefully without VM crash.",
            severity: "critical",
          },
        ],
        allowedBrokerOperations: primary.allowedBrokerOperations,
        baselineMetrics: primary.baselineMetrics,
        expectedOutcome: "error",
        expectedErrorSubstring: "ENOENT",
      });

      negatives.push({
        id: `scenario-neg-perm-${rng.nextUuid().slice(0, 8)}`,
        name: `Negative Permission Denied: ${manifest.name ?? "candidate"}`,
        description: `Simulates EACCES permission denied error on target path '${fileToFail}'.`,
        type: "negative_permission_error",
        sourceEpisodeId: primary.sourceEpisodeId,
        evidenceEventIds: primary.evidenceEventIds,
        evidenceRevision: primary.evidenceRevision,
        input: { ...primary.input },
        virtualState: {
          ...primary.virtualState,
          fs: {
            ...primary.virtualState.fs,
            simulateErrors: {
              [fileToFail]: "EACCES",
            },
          },
        },
        invariants: [
          {
            id: "inv-neg-perm-error",
            name: "Handled Permission Error",
            type: "error_mapping",
            description: "Candidate must handle EACCES permission error gracefully.",
            severity: "critical",
          },
        ],
        allowedBrokerOperations: primary.allowedBrokerOperations,
        baselineMetrics: primary.baselineMetrics,
        expectedOutcome: "error",
        expectedErrorSubstring: "EACCES",
      });
    }

    // 2. Network error scenario (if network routes, URLs, or network capabilities are present)
    const hasNetRoutes = Object.keys(primary.virtualState.net?.routes ?? {}).length > 0;
    const hasUrlInput = Object.values(primary.input).some(
      (v) => typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://")),
    );
    const hasNetCapability = caps?.net?.allowOutbound === true;

    if (hasNetCapability && (hasNetRoutes || hasUrlInput || hasNetCapability)) {
      negatives.push({
        id: `scenario-neg-net-${rng.nextUuid().slice(0, 8)}`,
        name: `Negative Network Error: ${manifest.name ?? "candidate"}`,
        description: `Simulates network connection failure and timeout on external HTTP calls.`,
        type: "negative_network_error",
        sourceEpisodeId: primary.sourceEpisodeId,
        evidenceEventIds: primary.evidenceEventIds,
        evidenceRevision: primary.evidenceRevision,
        input: { ...primary.input },
        virtualState: {
          ...primary.virtualState,
          net: {
            ...primary.virtualState.net,
            simulateNetworkError: true,
          },
        },
        invariants: [
          {
            id: "inv-neg-net-error",
            name: "Handled Network Error",
            type: "error_mapping",
            description: "Candidate must handle network errors cleanly.",
            severity: "warning",
          },
        ],
        allowedBrokerOperations: primary.allowedBrokerOperations,
        baselineMetrics: primary.baselineMetrics,
        expectedOutcome: "error",
      });
    }

    // 3. Command failure scenario (if commands or command capabilities are present)
    const hasCommands = Object.keys(primary.virtualState.cmd?.commands ?? {}).length > 0;
    const hasCmdInput = Object.keys(primary.input).some(
      (k) => k.toLowerCase().includes("cmd") || k.toLowerCase().includes("command"),
    );
    const hasCmdCapability =
      caps?.command?.allowShellExecution === true ||
      (caps?.command?.allowedCommands && caps.command.allowedCommands.length > 0);

    if (hasCommands || hasCmdInput || hasCmdCapability) {
      negatives.push({
        id: `scenario-neg-cmd-${rng.nextUuid().slice(0, 8)}`,
        name: `Negative Command Failure: ${manifest.name ?? "candidate"}`,
        description: `Simulates non-zero exit code on spawned subprocess commands.`,
        type: "negative_command_failure",
        sourceEpisodeId: primary.sourceEpisodeId,
        evidenceEventIds: primary.evidenceEventIds,
        evidenceRevision: primary.evidenceRevision,
        input: { ...primary.input },
        virtualState: {
          ...primary.virtualState,
          cmd: {
            ...primary.virtualState.cmd,
            simulateFailure: true,
          },
        },
        invariants: [
          {
            id: "inv-neg-cmd-error",
            name: "Handled Command Failure",
            type: "error_mapping",
            description: "Candidate must handle non-zero command execution exit codes.",
            severity: "warning",
          },
        ],
        allowedBrokerOperations: primary.allowedBrokerOperations,
        baselineMetrics: primary.baselineMetrics,
        expectedOutcome: "error",
      });
    }

    // 4. Malformed input scenario
    negatives.push({
      id: `scenario-neg-input-${rng.nextUuid().slice(0, 8)}`,
      name: `Negative Malformed Input: ${manifest.name ?? "candidate"}`,
      description: `Passes invalid input types and missing required fields to test validation.`,
      type: "negative_malformed_input",
      sourceEpisodeId: primary.sourceEpisodeId,
      evidenceEventIds: primary.evidenceEventIds,
      evidenceRevision: primary.evidenceRevision,
      input: { __invalid_field__: null, path: 12345, query: false },
      virtualState: primary.virtualState,
      invariants: [
        {
          id: "inv-neg-input-error",
          name: "Handled Malformed Input",
          type: "error_mapping",
          description: "Candidate must fail validation gracefully on invalid parameter types.",
          severity: "critical",
        },
      ],
      allowedBrokerOperations: primary.allowedBrokerOperations,
      baselineMetrics: primary.baselineMetrics,
      expectedOutcome: "error",
    });

    return negatives;
  }
}
