import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import type {
  OpportunityClassification,
  OpportunityInferredInput,
  ToolClass,
  WorkflowCluster,
  WorkflowContract,
  WorkflowOperation,
  WorkflowOutputRequirement,
} from "./types.js";
import {
  normalizeCommandProfile,
  splitCompositeCommand,
} from "./signature.js";

function sanitizeFieldName(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base.length > 0 ? base : "output";
}

function deepCloneJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function sortEventsDeterministically(events: NormalizedSessionEvent[]): NormalizedSessionEvent[] {
  return [...events].sort((a, b) => {
    const aSeq = (a as unknown as { causalRef?: { causalSequence?: number } }).causalRef?.causalSequence ?? 0;
    const bSeq = (b as unknown as { causalRef?: { causalSequence?: number } }).causalRef?.causalSequence ?? 0;
    if (aSeq !== bSeq) return aSeq - bSeq;
    const aTime = Date.parse((a as unknown as { timestamp?: string }).timestamp ?? "") || 0;
    const bTime = Date.parse((b as unknown as { timestamp?: string }).timestamp ?? "") || 0;
    if (aTime !== bTime) return aTime - bTime;
    const ai: string = (a as unknown as { eventId?: string }).eventId ?? "";
    const bi: string = (b as unknown as { eventId?: string }).eventId ?? "";
    if (ai && bi) return ai.localeCompare(bi);
    return String(a.type).localeCompare(String(b.type));
  });
}

function isCommandOperation(op: WorkflowOperation): boolean {
  const lower = op.name.toLowerCase();
  const tc = op.toolClass;
  if (tc === "vcs" || tc === "shell_exec" || tc === "package_manager" || tc === "build_tool" || tc === "test_runner") return true;
  if (lower.startsWith("command:") || lower.startsWith("cmd:")) return true;
  // Tool class string variants
  if ((tc as string) === "command" || (tc as string) === "shell") return true;
  return false;
}

function isFileOperation(op: WorkflowOperation): boolean {
  const lower = op.name.toLowerCase();
  const tc = op.toolClass;
  if (tc === "file_read" || tc === "file_edit") return true;
  if ((tc as string) === "filesystem" || (tc as string) === "fs") return true;
  if (lower.includes("file_read") || lower.includes("file_edit") || lower.startsWith("edit:") || lower === "file_edit:update") return true;
  if (lower.startsWith("tool:read") || lower.startsWith("tool:edit") || lower.startsWith("tool:write")) return true;
  // Generic read/write file patterns in operation name
  if (lower.includes("read") && lower.includes("file")) return true;
  if (lower.includes("write") && lower.includes("file")) return true;
  return false;
}

/**
 * Derive a deterministic, JSON-safe WorkflowContract for the observed workflow cluster.
 *
 * - Retains the full ordered representative workflow (operationSequence + commandProfiles), not only the first command.
 * - Assigns stable operation IDs (`op_0`, `op_1`, …) preserving order.
 * - Binds `commandProfile` and per-operation `args`/`filePath`/`targetPaths` to the originating ordered event
 *   instead of indexing a filtered deduplicated command list (prevents cross-assignment like read getting git profile).
 * - Surfaces required inputs from classification.inferredInputs.
 * - Surfaces required structured outputs with explicit sourceOperationId, derived from the full workflow + candidateOutputSchema.
 * - Enumerates explicit invariants, expensive and repeated operation IDs.
 * - All derivation is deterministic (sorted keys, stable ordering) and JSON-serializable.
 */
export function extractWorkflowContract(
  cluster: WorkflowCluster,
  events: NormalizedSessionEvent[],
  classification: OpportunityClassification,
): WorkflowContract {
  const sig = cluster.representativeSignature;
  const opSeq: string[] = sig.operationSequence ?? [];
  const toolClasses: ToolClass[] = sig.toolClasses ?? [];

  // Deterministically ordered events for evidence binding
  const orderedEvents = sortEventsDeterministically(events);

  // Build per-event evidence queues in causal order

  const commandQueue: Array<{ profiles: string[]; argsList: string[][] }> = [];
  const fileQueue: Array<{ filePath: string; targetPaths: string[] }> = [];

  for (const evt of orderedEvents) {
    if (evt.type === "command_exec") {
      const ce = evt as unknown as { command: string; args?: string[] };
      const rawCmd = (ce.command ?? "").trim();
      const rawArgs: string[] = Array.isArray(ce.args) ? ce.args : [];
      const joined = [rawCmd, ...rawArgs].join(" ").trim();
      if (joined) {
        const profiles: string[] = [];
        const argsList: string[][] = [];
        for (const seg of splitCompositeCommand(joined)) {
          const profile = normalizeCommandProfile(seg);
          if (profile) {
            profiles.push(profile);
            const parts = profile.trim().split(/\s+/);
            argsList.push(parts.slice(1));
          }
        }
        if (profiles.length > 0) {
          commandQueue.push({ profiles, argsList });
        }
      }
    } else if (evt.type === "tool_call") {
      const tc = evt as unknown as { toolName: string; parameters?: Record<string, unknown> };
      const params = tc.parameters as Record<string, unknown> | undefined;
      if (params) {
        const rawCmd = params.command ?? params.cmd ?? params.executable;
        if (typeof rawCmd === "string" && rawCmd.trim()) {
          const profiles: string[] = [];
          const argsList: string[][] = [];
          for (const seg of splitCompositeCommand(rawCmd)) {
            const profile = normalizeCommandProfile(seg);
            if (profile) {
              profiles.push(profile);
              const parts = profile.trim().split(/\s+/);
              argsList.push(parts.slice(1));
            }
          }
          if (profiles.length > 0) {
            commandQueue.push({ profiles, argsList });
          }
        }
        // File evidence from tool_call parameters
        const maybePaths = (params.targetPaths ?? params.paths ?? params.files ?? params.filePaths) as unknown;
        if (Array.isArray(maybePaths)) {
          const strs = (maybePaths as unknown[]).filter((v): v is string => typeof v === "string" && v.trim().length > 0) as string[];
          if (strs.length > 0) {
            fileQueue.push({ filePath: strs[0]!, targetPaths: [...strs] });
          }
        } else {
          const maybePath = (params.path ?? params.filePath ?? params.file ?? params.targetPath ?? params.sourcePath) as unknown;
          if (typeof maybePath === "string" && maybePath.trim().length > 0) {
            fileQueue.push({ filePath: maybePath, targetPaths: [maybePath] });
          } else {
            const maybePathArray = params.targetPath as unknown;
            if (typeof maybePathArray === "string" && maybePathArray.trim().length > 0) {
              fileQueue.push({ filePath: maybePathArray, targetPaths: [maybePathArray] });
            }
          }
        }
      }
    } else if (evt.type === "file_edit") {
      const fe = evt as unknown as { filePath: string };
      if (fe.filePath && typeof fe.filePath === "string" && fe.filePath.trim().length > 0) {
        fileQueue.push({ filePath: fe.filePath, targetPaths: [fe.filePath] });
      }
    }
  }

  // Also consider file_edit via normalizedPaths if no explicit fileQueue but signature has paths? Keep for completeness but per-operation evidence primary is from events.

  // Stable operations: preserve full ordered workflow
  let baseOps: string[] = opSeq.length > 0 ? [...opSeq] : [];
  if (baseOps.length === 0 && classification.commandProfiles && classification.commandProfiles.length > 0) {
    // Fallback when signature empty: derive from classification profiles (rare)
    baseOps = classification.commandProfiles.map((p: string) => `cmd:${String(p)}`);
  }
  if (baseOps.length === 0 && orderedEvents.length > 0) {
    // Final fallback: derive from ordered events
    baseOps = orderedEvents.slice(0, Math.min(orderedEvents.length, 8)).map((e: NormalizedSessionEvent): string => {
      if (e.type === "tool_call" || e.type === "tool_result") {
        const toolName = (e as unknown as { toolName: string }).toolName ?? "unknown";
        return `tool:${String(toolName).toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
      }
      if (e.type === "command_exec") {
        const cmd: string = (e as unknown as { command: string }).command ?? "";
        const head: string = cmd ? cmd.split(" ")[0]! : "exec";
        return `command:${head.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
      }
      if (e.type === "file_edit") return `file_edit:update`;
      return `${e.type}`;
    });
  }

  const operations: WorkflowOperation[] = baseOps.map((name: string, idx: number): WorkflowOperation => {
    const id = `op_${idx}`;
    const op: WorkflowOperation = {
      id,
      order: idx,
      name: String(name),
    };
    const tc: ToolClass | undefined = toolClasses[idx];
    if (tc !== undefined) op.toolClass = tc;
    return op;
  });

  if (operations.length === 0) {
    operations.push({
      id: "op_0",
      order: 0,
      name: "workflow:generic",
    });
  }

  // Bind per-operation evidence to originating ordered event, not filtered index
  // Only command-like ops consume from commandQueue in order; file-like ops consume from fileQueue.

  let cmdCursor = 0;
  let fileCursor = 0;

  // Fallback sequential profiles when event queue exhausted but classification has profiles
  const fallbackProfiles: string[] = classification.commandProfiles ?? [];
  let fallbackIdx = 0;

  for (const op of operations) {
    if (isCommandOperation(op)) {
      let entry: { profiles: string[]; argsList: string[][] } | undefined;
      if (cmdCursor < commandQueue.length) {
        entry = commandQueue[cmdCursor++];
      } else if (fallbackIdx < fallbackProfiles.length) {
        const profile = String(fallbackProfiles[fallbackIdx++]);
        const parts = profile.trim().split(/\s+/);
        entry = { profiles: [profile], argsList: [parts.slice(1)] };
      }
      if (entry) {
        op.commandProfiles = [...entry.profiles];
        op.commandProfile = entry.profiles[0];
        const firstArgs = entry.argsList[0];
        if (firstArgs && firstArgs.length > 0) {
          op.args = [...firstArgs];
        }
      }
    } else if (isFileOperation(op)) {
      if (fileCursor < fileQueue.length) {
        const fe = fileQueue[fileCursor++];
        op.filePath = fe.filePath;
        if (fe.targetPaths && fe.targetPaths.length > 0) {
          op.targetPaths = [...fe.targetPaths];
        }
      }
    }
  }

  // Required inputs: inferredInputs from classification, deterministic JSON clone
  const inferred: OpportunityInferredInput[] = classification.inferredInputs ?? [];
  const requiredInputs: OpportunityInferredInput[] = inferred.map((inp: OpportunityInferredInput) => ({
    name: String(inp.name),
    type: String(inp.type),
    description: String(inp.description),
    required: Boolean(inp.required),
    ...(inp.default !== undefined ? { default: deepCloneJsonSafe(inp.default) } : {}),
  }));

  // Required structured outputs with source operation IDs
  // Derive from full representative workflow + candidateOutputSchema
  const outputRequirements: WorkflowOutputRequirement[] = [];
  const seenNames = new Set<string>();

  function pushRequirement(req: WorkflowOutputRequirement): void {
    // Ensure collision-safe deterministic name
    let candidate = sanitizeFieldName(req.name);
    let unique = candidate;
    let suffix = 1;
    while (seenNames.has(unique)) {
      unique = `${candidate}_${suffix++}`;
    }
    seenNames.add(unique);
    outputRequirements.push({
      name: unique,
      sourceOperationId: req.sourceOperationId,
      type: String(req.type),
      required: Boolean(req.required),
      ...(req.description ? { description: String(req.description) } : {}),
    });
  }

  // 1. Per-operation structured outputs (covers every observed operation)
  for (const op of operations) {
    const baseName = `op${op.order}_${sanitizeFieldName(op.name)}_result`;
    pushRequirement({
      name: baseName,
      sourceOperationId: op.id,
      type: "object",
      required: true,
      description: `Output of ${op.name}`,
    });
  }

  // 2. Candidate output schema properties (if present) – adds schema-derived requirements
  const schema: Record<string, unknown> | undefined = classification.candidateOutputSchema;
  const schemaProps: Record<string, unknown> | undefined =
    schema !== undefined && typeof schema === "object" && (schema as Record<string, unknown>).properties !== undefined
      ? ((schema as Record<string, unknown>).properties as Record<string, unknown>)
      : undefined;
  if (schemaProps !== undefined) {
    const propNames: string[] = Object.keys(schemaProps).sort();
    for (const propName of propNames) {
      const propDef: unknown = schemaProps[propName];
      const typeValue: unknown = (propDef as Record<string, unknown>)?.type;
      const propType = String(typeof typeValue === "string" ? typeValue : "string");
      const requiredArray: unknown = (schema as Record<string, unknown>).required;
      const isRequired: boolean = Array.isArray(requiredArray)
        ? (requiredArray as string[]).includes(propName)
        : true;
      const descValue: unknown = (propDef as Record<string, unknown>)?.description;
      const description: string =
        typeof descValue === "string" ? String(descValue) : `Schema output ${propName}`;
      const existing: WorkflowOutputRequirement | undefined = outputRequirements.find(
        (r) => r.name === sanitizeFieldName(propName),
      );
      if (existing !== undefined) continue;
      // Assign to last operation as source if not mapping to specific op; deterministic fallback
      const sourceId: string = operations[operations.length - 1]!.id;
      pushRequirement({
        name: propName,
        sourceOperationId: sourceId,
        type: propType,
        required: isRequired,
        description,
      });
    }
  }

  // Ensure deterministic ordering by name for JSON stability, but preserve sourceOperationId mapping
  // We have already inserted per-operation in order then schema sorted; now sort for determinism
  // However to keep operation order verifiable, we sort by name which is deterministic and collision-safe
  outputRequirements.sort((a, b) => a.name.localeCompare(b.name));

  // Explicit invariants: ordering, side effects, hashes
  const invariants: string[] = [];
  invariants.push(`ordering: sequential op_0->op_${operations.length - 1} must execute in observed order`);
  invariants.push(`order:${operations.map((o) => o.id).join("->")}`);
  invariants.push(`structuralHash:${cluster.structuralHash}`);
  invariants.push(`operationCount:${operations.length}`);
  invariants.push(`toolClasses:${[...toolClasses].sort().join(",")}`);
  invariants.push(`commandProfiles:${[...(classification.commandProfiles ?? [])].sort().join("|")}`);
  invariants.push(`workflowVersion:1`);
  // Side-effect invariants derived from toolClasses / operation names
  const hasFileEdit = operations.some((o) => o.toolClass === "file_edit" || o.name.includes("file_edit") || o.name.includes("edit:"));
  const hasVcs = operations.some((o) => o.toolClass === "vcs" || o.name.includes("vcs") || o.name.includes("git"));
  const hasSearch = operations.some((o) => o.toolClass === "search" || o.name.includes("search"));
  const hasBuild = operations.some((o) => o.toolClass === "build_tool" || o.name.includes("build"));
  const hasTest = operations.some((o) => o.toolClass === "test_runner" || o.name.includes("test"));
  if (hasFileEdit) invariants.push(`sideEffect: file_edit modifies filesystem - capability:write required`);
  if (hasVcs) invariants.push(`sideEffect: vcs reads working tree - requires git capability`);
  if (hasSearch) invariants.push(`sideEffect: search is read-only`);
  if (hasBuild) invariants.push(`sideEffect: build_tool may execute arbitrary build steps`);
  if (hasTest) invariants.push(`sideEffect: test_runner executes test suite`);
  invariants.push(`inputs: ${requiredInputs.map((i) => i.name).sort().join(",")}`);
  invariants.push(`outputs: ${outputRequirements.map((o) => o.name).sort().join(",")}`);

  // Repeated operation IDs: deterministic – operation identity is name + commandProfile
  // This ensures distinct git subcommands (status vs diff vs log) are not conflated,
  // while exact duplicates (git status appearing twice) are flagged.
  const combinedCounts = new Map<string, number>();
  for (const op of operations) {
    const key = `${op.name}|${op.commandProfile ?? ""}`;
    combinedCounts.set(key, (combinedCounts.get(key) ?? 0) + 1);
  }
  const repeatedKeys = new Set<string>(
    [...combinedCounts.entries()].filter(([, c]: [string, number]) => c > 1).map(([k]: [string, number]) => k),
  );
  const repeatedOperationIds: string[] = operations
    .filter((op) => repeatedKeys.has(`${op.name}|${op.commandProfile ?? ""}`))
    .map((op) => op.id)
    .sort();

  // Fallback: if no combined duplicate but raw name dup exists (e.g., generic command:git without profile), flag those too
  if (repeatedOperationIds.length === 0) {
    const nameCounts = new Map<string, number>();
    for (const op of operations) {
      nameCounts.set(op.name, (nameCounts.get(op.name) ?? 0) + 1);
    }
    const repeatedNames = new Set<string>(
      [...nameCounts.entries()].filter(([, c]: [string, number]) => c > 1).map(([n]: [string, number]) => n),
    );
    if (repeatedNames.size > 0) {
      for (const op of operations) {
        if (repeatedNames.has(op.name) && !repeatedOperationIds.includes(op.id)) {
          repeatedOperationIds.push(op.id);
        }
      }
      repeatedOperationIds.sort();
    }
  }

  // Expensive operation IDs: test_runner/build_tool, high tokens/cost, or repeated
  const expensiveToolClasses = new Set<ToolClass>(["test_runner", "build_tool"]);
  const expensiveOperationIdsSet = new Set<string>();
  for (const op of operations) {
    if (op.toolClass !== undefined && expensiveToolClasses.has(op.toolClass)) {
      expensiveOperationIdsSet.add(op.id);
    }
    if (op.name.includes("test_runner") || op.name.includes("build_tool") || op.name.startsWith("tool:exec")) {
      expensiveOperationIdsSet.add(op.id);
    }
    // Command profiles that are known expensive
    if (op.commandProfile !== undefined && /\b(pnpm|npm|yarn|cargo|vitest|jest|pytest|tsc|build|test)\b/i.test(op.commandProfile)) {
      expensiveOperationIdsSet.add(op.id);
    }
    // Duration-based: use events durationMs if available
    if (orderedEvents.length > 0) {
      const related: NormalizedSessionEvent | undefined = orderedEvents.find((e: NormalizedSessionEvent): boolean => {
        if (op.commandProfile !== undefined) {
          const cmdHead = op.commandProfile.split(" ")[0]!;
          if (e.type === "command_exec" && (e as unknown as { command: string }).command.includes(cmdHead)) return true;
          if (e.type === "tool_call") {
            const params = (e as unknown as { parameters?: Record<string, unknown> }).parameters;
            const rc = params ? ((params.command ?? params.cmd) as string | undefined) : undefined;
            if (typeof rc === "string" && rc.includes(cmdHead)) return true;
          }
        }
        if (e.type === "tool_call" || e.type === "tool_result") {
          const toolName = (e as unknown as { toolName: string }).toolName;
          if (toolName && op.name.includes(String(toolName).toLowerCase())) return true;
        }
        if (e.type === "file_edit" && op.filePath) {
          const fp = (e as unknown as { filePath: string }).filePath;
          if (fp === op.filePath) return true;
        }
        return false;
      });
      let dur: number | undefined;
      if (related !== undefined) {
        if (related.type === "command_exec") {
          dur = (related as unknown as { durationMs?: number }).durationMs;
        } else if (related.type === "model_reasoning") {
          dur = (related as unknown as { durationMs?: number }).durationMs;
        }
      }
      if (typeof dur === "number" && dur > 5000) {
        expensiveOperationIdsSet.add(op.id);
      }
    }
  }
  const avgTokens: number = cluster.metrics?.avgTokens ?? cluster.metrics?.totalTokens ?? 0;
  const totalCost: number = cluster.metrics?.totalCostUsd ?? 0;
  if ((avgTokens > 5000 || totalCost > 0.1) && operations.length > 0) {
    const last = operations[operations.length - 1]!;
    expensiveOperationIdsSet.add(last.id);
  }
  // Repeated work is expensive: flag repeated ops as expensive as well
  for (const rid of repeatedOperationIds) {
    expensiveOperationIdsSet.add(rid);
  }

  const expensiveOperationIds: string[] = [...expensiveOperationIdsSet].sort();

  const contract: WorkflowContract = {
    version: 1,
    operations: deepCloneJsonSafe(operations),
    requiredInputs: deepCloneJsonSafe(requiredInputs),
    outputRequirements: deepCloneJsonSafe(outputRequirements),
    invariants: deepCloneJsonSafe(invariants),
    expensiveOperationIds: deepCloneJsonSafe(expensiveOperationIds),
    repeatedOperationIds: deepCloneJsonSafe(repeatedOperationIds),
  };

  return contract;
}
