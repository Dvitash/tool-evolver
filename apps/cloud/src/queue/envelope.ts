import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TenantContext } from "../tenant.js";

/**
 * Tenant context schema for job envelopes.
 */
export const TenantContextSchema = z.object({
  accountId: z.string().min(1),
  workspaceId: z.string().min(1),
  userId: z.string().optional(),
  deviceId: z.string().optional(),
  roles: z.array(z.string()).optional(),
  traceId: z.string().optional(),
  correlationId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Schema for versioned internal job envelopes.
 */
export const JobEnvelopeSchema = z.object({
  jobId: z
    .string()
    .uuid()
    .default(() => randomUUID()),
  jobType: z.string().min(1),
  version: z.string().default("1.0.0"),
  tenantContext: TenantContextSchema,
  causationId: z.string().optional(),
  correlationId: z.string().optional(),
  attempt: z.number().int().positive().default(1),
  maxAttempts: z.number().int().positive().default(3),
  availableAt: z
    .number()
    .int()
    .nonnegative()
    .default(() => Date.now()),
  expiresAt: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().optional(),
  payload: z.unknown(),
  traceContext: z.record(z.string()).optional().default({}),
});

export type JobEnvelope<T = unknown> = Omit<z.infer<typeof JobEnvelopeSchema>, "payload"> & {
  payload: T;
};

/**
 * Options for creating a new job envelope.
 */
export interface CreateJobEnvelopeOptions<T> {
  jobId?: string;
  jobType: string;
  version?: string;
  tenantContext: TenantContext;
  causationId?: string;
  correlationId?: string;
  attempt?: number;
  maxAttempts?: number;
  availableAt?: number;
  expiresAt?: number;
  idempotencyKey?: string;
  payload: T;
  traceContext?: Record<string, string>;
}

/**
 * Factory function creating a validated JobEnvelope.
 */
export function createJobEnvelope<T>(options: CreateJobEnvelopeOptions<T>): JobEnvelope<T> {
  const envelope: JobEnvelope<T> = {
    jobId: options.jobId ?? randomUUID(),
    jobType: options.jobType,
    version: options.version ?? "1.0.0",
    tenantContext: options.tenantContext,
    causationId: options.causationId,
    correlationId: options.correlationId,
    attempt: options.attempt ?? 1,
    maxAttempts: options.maxAttempts ?? 3,
    availableAt: options.availableAt ?? Date.now(),
    expiresAt: options.expiresAt,
    idempotencyKey: options.idempotencyKey,
    payload: options.payload,
    traceContext: options.traceContext ?? {},
  };

  JobEnvelopeSchema.parse(envelope);
  return envelope;
}

/**
 * Serialize a job envelope to JSON string.
 */
export function serializeEnvelope<T>(envelope: JobEnvelope<T>): string {
  return JSON.stringify(envelope);
}

/**
 * Deserialize a JSON string to a validated JobEnvelope.
 */
export function deserializeEnvelope<T = unknown>(json: string): JobEnvelope<T> {
  const parsed = JSON.parse(json);
  return JobEnvelopeSchema.parse(parsed) as JobEnvelope<T>;
}
