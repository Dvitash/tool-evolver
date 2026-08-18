from pathlib import Path


def patch(path: str, old: str, new: str, marker: str) -> None:
    file_path = Path(path)
    source = file_path.read_text()
    if old in source:
        source = source.replace(old, new, 1)
    elif marker not in source:
        raise SystemExit(f"patch target not found in {path}: {marker}")
    file_path.write_text(source)


orchestrator = "apps/cloud/src/evolution/lifecycle/orchestrator.ts"
patch(
    orchestrator,
    'import type { ObjectStore } from "../../storage/object-store.js";\n',
    'import type { ObjectStore } from "../../storage/object-store.js";\nimport { ObservationRepository } from "../../storage/repositories/observation-repository.js";\n',
    'ObservationRepository',
)
patch(
    orchestrator,
    '''  objectStore?: ObjectStore;
  evidenceMaxAgeMs?: number;''',
    '''  objectStore?: ObjectStore;
  observationRepo?: ObservationRepository;
  requirePersistedReplayEvidence?: boolean;
  replayEvidenceWaitMs?: number;
  replayEvidencePollMs?: number;
  evidenceMaxAgeMs?: number;''',
    'replayEvidenceWaitMs?: number;',
)
patch(
    orchestrator,
    '''  readonly objectStore?: ObjectStore;
  readonly evidenceMaxAgeMs: number;''',
    '''  readonly objectStore?: ObjectStore;
  readonly observationRepo?: ObservationRepository;
  readonly requirePersistedReplayEvidence: boolean;
  readonly replayEvidenceWaitMs: number;
  readonly replayEvidencePollMs: number;
  readonly evidenceMaxAgeMs: number;''',
    'readonly replayEvidenceWaitMs: number;',
)
patch(
    orchestrator,
    '''    this.queue = opts.queue;
    this.objectStore = opts.objectStore;
    this.evidenceMaxAgeMs = opts.evidenceMaxAgeMs ?? 24 * 60 * 60 * 1000;''',
    '''    this.queue = opts.queue;
    this.objectStore = opts.objectStore;
    this.observationRepo = opts.observationRepo;
    this.requirePersistedReplayEvidence = opts.requirePersistedReplayEvidence ?? false;
    this.replayEvidenceWaitMs = opts.replayEvidenceWaitMs ?? 0;
    this.replayEvidencePollMs = Math.max(1, opts.replayEvidencePollMs ?? 25);
    this.evidenceMaxAgeMs = opts.evidenceMaxAgeMs ?? 24 * 60 * 60 * 1000;''',
    'this.replayEvidenceWaitMs =',
)
helper = '''
  private async resolveReplayEvidence(
    tenant: TenantContext,
    candidate: EvolutionCandidate,
    baselineEvents?: NormalizedSessionEvent[],
  ): Promise<EvidenceSource> {
    if (baselineEvents && baselineEvents.length > 0) {
      return { id: `candidate_${candidate.id}_explicit_evidence`, events: baselineEvents };
    }

    const evidenceEventIds = candidate.trigger?.evidenceEventIds ?? [];
    const persistedById = new Map<string, NormalizedSessionEvent>();
    const deadline = Date.now() + this.replayEvidenceWaitMs;

    if (this.observationRepo && evidenceEventIds.length > 0) {
      do {
        for (const eventId of evidenceEventIds) {
          if (persistedById.has(eventId)) continue;
          const entity = await this.observationRepo.getEventById(tenant, eventId);
          if (!entity) continue;
          persistedById.set(
            eventId,
            {
              eventId: entity.id,
              sessionId: entity.sessionId,
              timestamp: entity.timestamp,
              type: entity.eventType as NormalizedSessionEvent["type"],
              schemaVersion: entity.schemaVersion,
              causalRef: {
                causalSequence: entity.causalSequence,
                parentId: entity.parentId ?? undefined,
                rootId: entity.rootId ?? undefined,
                turnIndex: entity.turnIndex ?? undefined,
                stepIndex: entity.stepIndex ?? undefined,
                traceId: entity.traceId ?? undefined,
                spanId: entity.spanId ?? undefined,
              },
              redaction: entity.redaction ?? { isRedacted: false, rulesApplied: [] },
              ...entity.payload,
            } as unknown as NormalizedSessionEvent,
          );
        }

        if (persistedById.size === evidenceEventIds.length || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, this.replayEvidencePollMs));
      } while (true);
    }

    const persistedEvents = [...persistedById.values()].sort((left, right) => {
      const timeDelta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
      if (timeDelta !== 0) return timeDelta;
      return (left.causalRef?.causalSequence ?? 0) - (right.causalRef?.causalSequence ?? 0);
    });
    const missingEventIds = evidenceEventIds.filter((eventId) => !persistedById.has(eventId));

    if (persistedEvents.length > 0 && (!this.requirePersistedReplayEvidence || missingEventIds.length === 0)) {
      return { id: `candidate_${candidate.id}_persisted_evidence`, events: persistedEvents };
    }

    if (this.requirePersistedReplayEvidence) {
      throw new Error(
        `Candidate '${candidate.id}' is missing tenant-scoped persisted replay evidence after ${this.replayEvidenceWaitMs}ms. Missing IDs: ${missingEventIds.join(", ") || "all evidence IDs absent"}`,
      );
    }

    return { id: `candidate_${candidate.id}_test_evidence`, events: persistedEvents };
  }

'''
marker = '''  /**
   * Stage 2: Historical Replay'''
file_path = Path(orchestrator)
source = file_path.read_text()
if helper.strip() not in source:
    if marker not in source:
        raise SystemExit("replay stage marker not found")
    source = source.replace(marker, helper + marker, 1)
file_path.write_text(source)
patch(
    orchestrator,
    '''          evidence:
            options.baselineEvents ?? ({ id: "default_evidence", events: [] } as EvidenceSource),''',
    '''          evidence: await this.resolveReplayEvidence(
            tenant,
            candidate,
            options.baselineEvents,
          ),''',
    'evidence: await this.resolveReplayEvidence(',
)
patch(
    "apps/cloud/src/index.ts",
    '''      queue: this.queue,
      objectStore: this.objectStore,
    });''',
    '''      queue: this.queue,
      objectStore: this.objectStore,
      observationRepo: this.observationRepo,
      requirePersistedReplayEvidence: true,
      replayEvidenceWaitMs: 5_000,
      replayEvidencePollMs: 25,
    });''',
    'replayEvidenceWaitMs: 5_000,',
)

# Keep the focused E2E error actionable while this hardening pass runs.
path = Path("apps/cloud/src/evolution/lifecycle/orchestrator.ts")
source = path.read_text()
old = '''      throw new Error(`Candidate replay failed with state '${replayRecord.currentState}'`);'''
new = '''      throw new Error(
        `Candidate replay failed with state '${replayRecord.currentState}': ${JSON.stringify({ terminalReason: replayRecord.terminalReason, replayResult: replayRecord.replayResult })}`,
      );'''
if old in source:
    source = source.replace(old, new, 1)
elif "terminalReason: replayRecord.terminalReason" not in source:
    raise SystemExit("replay diagnostics target not found")
path.write_text(source)

print("FIN-001 replay waits for complete persisted tenant-scoped evidence")
