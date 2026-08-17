import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import type { DatabasePool, Queryable } from "../db/client.js";
import { OutboxRepository } from "../db/outbox.js";
import type { JobEnvelope } from "../queue/envelope.js";
import type { TenantContext } from "../tenant.js";
import { ObservationRepository } from "./repositories/observation-repository.js";
import { SessionRepository } from "./repositories/session-repository.js";

/**
 * Payload schema for store-observation-batch jobs.
 */
export interface StoreObservationBatchPayload {
  batchId: string;
  accountId: string;
  workspaceId: string;
  deviceId?: string;
  installationId?: string;
  cursor?: string;
  cursorAck?: string;
  contentHash?: string;
  acceptedCount?: number;
  observations: NormalizedSessionEvent[];
  ingestedAt?: string;
}

/**
 * Event published when observations are committed and materialized.
 */
export interface ObservationAvailableEvent {
  batchId: string;
  accountId: string;
  workspaceId: string;
  sessionIds: string[];
  eventCount: number;
  processedAt: string;
}

export class StoreObservationBatchConsumer {
  private obsRepo: ObservationRepository;
  private sessionRepo: SessionRepository;

  constructor(
    private pool: DatabasePool,
    options: {
      obsRepo?: ObservationRepository;
      sessionRepo?: SessionRepository;
    } = {},
  ) {
    this.obsRepo = options.obsRepo ?? new ObservationRepository(this.pool);
    this.sessionRepo = options.sessionRepo ?? new SessionRepository(this.pool);
  }

  /**
   * Process a queued store-observation-batch job.
   */
  async processJob(job: JobEnvelope<StoreObservationBatchPayload>): Promise<void> {
    const payload = job.payload;
    if (!payload || !Array.isArray(payload.observations)) {
      return;
    }

    const tenant: TenantContext = {
      accountId: payload.accountId || job.tenantContext.accountId,
      workspaceId: payload.workspaceId || job.tenantContext.workspaceId,
      deviceId: payload.deviceId || job.tenantContext.deviceId,
      traceId: job.tenantContext.traceId,
      correlationId: job.tenantContext.correlationId,
    };

    if (payload.observations.length === 0) {
      return;
    }

    // Group observations by sessionId
    const bySession = new Map<string, NormalizedSessionEvent[]>();
    for (const obs of payload.observations) {
      const sId = obs.sessionId || "default";
      let list = bySession.get(sId);
      if (!list) {
        list = [];
        bySession.set(sId, list);
      }
      list.push(obs);
    }

    const processedSessionIds: string[] = [];

    await this.pool.transaction(async (txClient: Queryable) => {
      for (const [sessionId, events] of bySession.entries()) {
        processedSessionIds.push(sessionId);

        // Ensure session exists
        await this.sessionRepo.getOrCreateSession(tenant, sessionId, "default", txClient);

        // Handle branch forks if any
        for (const evt of events) {
          if (evt.type === "branch_fork") {
            const forkPayload = evt as unknown as {
              forkBranchId?: string;
              parentBranchId?: string;
              name?: string;
              description?: string;
            };
            const branchId = forkPayload.forkBranchId || evt.eventId;
            await this.sessionRepo.createBranch(
              tenant,
              {
                id: branchId,
                sessionId,
                name: forkPayload.name || `branch-${branchId}`,
                parentBranchId: forkPayload.parentBranchId || null,
                forkEventId: evt.eventId,
              },
              txClient,
            );
          }
        }

        // Insert events idempotently
        const { newlyInserted } = await this.obsRepo.insertEventsBatchWithStatus(
          tenant,
          events,
          txClient,
        );

        // Materialize session summary updates for newly inserted events
        if (newlyInserted.length > 0) {
          await this.sessionRepo.recordSessionEventsMaterialized(
            tenant,
            sessionId,
            newlyInserted,
            txClient,
          );
        }
      }
      // Publish observation-available event to transactional outbox
      const availablePayload: ObservationAvailableEvent = {
        batchId: payload.batchId,
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        sessionIds: processedSessionIds,
        eventCount: payload.observations.length,
        processedAt: new Date().toISOString(),
      };

      const outboxHeaders: Record<string, string> = {};
      if (tenant.traceId) outboxHeaders.traceId = tenant.traceId;
      if (tenant.correlationId) outboxHeaders.correlationId = tenant.correlationId;

      await OutboxRepository.insert(txClient, {
        accountId: tenant.accountId,
        workspaceId: tenant.workspaceId,
        aggregateType: "observation-storage",
        aggregateId: payload.batchId,
        eventType: "observation-available",
        payload: availablePayload as unknown as Record<string, unknown>,
        headers: outboxHeaders,
      });
    });
  }
}

/**
 * Factory function to create a StoreObservationBatchConsumer.
 */
export function createStoreObservationBatchConsumer(
  pool: DatabasePool,
  options?: {
    obsRepo?: ObservationRepository;
    sessionRepo?: SessionRepository;
  },
): StoreObservationBatchConsumer {
  return new StoreObservationBatchConsumer(pool, options);
}
