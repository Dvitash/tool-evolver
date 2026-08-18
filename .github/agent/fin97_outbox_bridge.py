from pathlib import Path


def patch(path: str, old: str, new: str, marker: str) -> None:
    p = Path(path)
    source = p.read_text()
    if old in source:
        source = source.replace(old, new, 1)
    elif marker not in source:
        raise SystemExit(f"patch target not found in {path}: {marker}")
    p.write_text(source)


index = "apps/cloud/src/index.ts"
patch(
    index,
    'import type { JobEnvelope } from "./queue/envelope.js";',
    'import { type JobEnvelope, createJobEnvelope } from "./queue/envelope.js";',
    'createJobEnvelope',
)

marker = '''    this.worker.registerHandler("store-observation-batch", async (job) => {
      const typedJob = job as unknown as JobEnvelope<StoreObservationBatchPayload>;
      await this.observationConsumer.processJob(typedJob);
    });
'''
replacement = marker + '''

    // Transactional outbox records are durable intent, not completed work. Bridge every
    // record into the durable queue before the publisher marks it published. The outbox
    // record ID is the queue idempotency key, so retries cannot fork downstream work.
    this.outboxPublisher.subscribe("*", async (record) => {
      await this.queue.enqueue(
        createJobEnvelope({
          jobType: record.eventType,
          version: "1.0.0",
          tenantContext: {
            accountId: record.accountId,
            workspaceId: record.workspaceId,
            traceId: record.headers.traceId,
            correlationId: record.headers.correlationId,
            roles: ["system"],
            metadata: { source: "transactional-outbox" },
          },
          causationId: record.aggregateId,
          correlationId: record.headers.correlationId,
          idempotencyKey: `outbox:${record.id}`,
          payload: record.payload,
          traceContext: record.headers,
        }),
      );
    });
'''
patch(index, marker, replacement, 'idempotencyKey: `outbox:${record.id}`')

outbox = "apps/cloud/src/db/outbox.ts"
old = '''        const allHandlers = [...specificHandlers, ...wildcardHandlers];

        for (const handler of allHandlers) {'''
new = '''        const allHandlers = [...specificHandlers, ...wildcardHandlers];
        if (allHandlers.length === 0) {
          throw new Error(
            `No outbox subscriber is registered for event type '${record.eventType}'`,
          );
        }

        for (const handler of allHandlers) {'''
patch(outbox, old, new, "No outbox subscriber is registered")

# The real-process test already ingests through the authenticated observation endpoint.
# Detect from the same event set, but never rely on that caller payload for replay: replay
# resolves the trigger IDs from tenant-scoped persisted observations.
print("FIN-001 transactional outbox bridge ready")
