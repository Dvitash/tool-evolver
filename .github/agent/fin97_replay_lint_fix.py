from pathlib import Path

path = Path("apps/cloud/src/evolution/lifecycle/orchestrator.ts")
source = path.read_text()
old = '''      do {
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
      } while (true);'''
new = '''      let continuePolling = true;
      while (continuePolling) {
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

        continuePolling =
          persistedById.size < evidenceEventIds.length && Date.now() < deadline;
        if (continuePolling) {
          await new Promise((resolve) => setTimeout(resolve, this.replayEvidencePollMs));
        }
      }'''
if old in source:
    source = source.replace(old, new, 1)
elif "let continuePolling = true;" not in source:
    raise SystemExit("replay polling loop not found")
path.write_text(source)
print("FIN-001 replay polling satisfies lint")
