import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  hashCanonicalContent,
  normalizeSha256,
} from "@tool-evolver/contracts";
import { ChecksumMismatchError, ClockSkewError } from "./errors.js";

/**
 * Protocol compression algorithms.
 */
export const ProtocolCompressionSchema = z.enum(["none", "gzip", "zstd", "deflate"]).default("none");
export type ProtocolCompression = z.infer<typeof ProtocolCompressionSchema>;

/**
 * OpenTelemetry-compatible W3C distributed trace context.
 */
export const TraceContextSchema = z.object({
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  traceFlags: z.string().optional(),
  baggage: z.record(z.string()).optional(),
});
export type TraceContext = z.infer<typeof TraceContextSchema>;

/**
 * Core protocol envelope wrapping all client-to-cloud and cloud-to-client messages.
 */
export const ProtocolMessageEnvelopeSchema = z.object({
  version: SchemaVersionSchema.default("1.0.0"),
  messageId: IdentifierSchema,
  deviceId: IdentifierSchema,
  installationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sequence: z.number().int().nonnegative(),
  causationId: IdentifierSchema.optional(),
  correlationId: IdentifierSchema.optional(),
  createdAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  compression: ProtocolCompressionSchema,
  payloadType: z.string().min(1),
  payloadDigest: Sha256DigestSchema,
  traceContext: TraceContextSchema.optional(),
  payload: z.unknown(),
  signature: z.string().optional(),
});

export type ProtocolMessageEnvelope<T = unknown> = Omit<
  z.infer<typeof ProtocolMessageEnvelopeSchema>,
  "payload"
> & {
  payload: T;
};

/**
 * Options for constructing a ProtocolMessageEnvelope.
 */
export interface CreateProtocolEnvelopeOptions<T> {
  payloadType: string;
  payload: T;
  deviceId: string;
  installationId: string;
  workspaceId: string;
  sequence: number;
  messageId?: string;
  version?: string;
  causationId?: string;
  correlationId?: string;
  createdAt?: string;
  expiresAt?: string;
  idempotencyKey?: string;
  compression?: ProtocolCompression;
  payloadDigest?: string;
  traceContext?: TraceContext;
  signature?: string;
}

/**
 * Creates a strongly-typed, canonical-digest-verified ProtocolMessageEnvelope.
 */
export function createProtocolEnvelope<T>(
  options: CreateProtocolEnvelopeOptions<T>,
): ProtocolMessageEnvelope<T> {
  const messageId = options.messageId ?? randomUUID();
  const createdAt = options.createdAt ?? new Date().toISOString();
  const compression = options.compression ?? "none";
  const version = options.version ?? "1.0.0";
  const payloadDigest = options.payloadDigest ?? hashCanonicalContent(options.payload);

  const envelope: ProtocolMessageEnvelope<T> = {
    version,
    messageId,
    deviceId: options.deviceId,
    installationId: options.installationId,
    workspaceId: options.workspaceId,
    sequence: options.sequence,
    causationId: options.causationId,
    correlationId: options.correlationId,
    createdAt,
    expiresAt: options.expiresAt,
    idempotencyKey: options.idempotencyKey,
    compression,
    payloadType: options.payloadType,
    payloadDigest,
    traceContext: options.traceContext,
    payload: options.payload,
    signature: options.signature,
  };

  return ProtocolMessageEnvelopeSchema.parse(envelope) as ProtocolMessageEnvelope<T>;
}

/**
 * Validates a protocol message envelope structure and optionally parses payload against schema.
 */
export function validateProtocolEnvelope<T>(
  raw: unknown,
  payloadSchema?: z.ZodType<T>,
): ProtocolMessageEnvelope<T> {
  const parsed = ProtocolMessageEnvelopeSchema.parse(raw);
  if (payloadSchema) {
    const validatedPayload = payloadSchema.parse(parsed.payload);
    return {
      ...parsed,
      payload: validatedPayload,
    } as ProtocolMessageEnvelope<T>;
  }
  return parsed as ProtocolMessageEnvelope<T>;
}

/**
 * Verifies that the canonical hash of the envelope payload matches payloadDigest.
 */
export function verifyPayloadDigest(envelope: ProtocolMessageEnvelope<unknown>): boolean {
  const computed = hashCanonicalContent(envelope.payload);
  const normalizedExpected = normalizeSha256(envelope.payloadDigest);
  const normalizedComputed = normalizeSha256(computed);

  if (normalizedExpected !== normalizedComputed) {
    throw new ChecksumMismatchError(normalizedExpected, normalizedComputed);
  }
  return true;
}

/**
 * Checks whether an envelope has expired relative to reference timestamp.
 */
export function isEnvelopeExpired(
  envelope: ProtocolMessageEnvelope<unknown>,
  now = Date.now(),
): boolean {
  if (!envelope.expiresAt) return false;
  return new Date(envelope.expiresAt).getTime() <= now;
}

/**
 * Asserts that the envelope createdAt timestamp does not exceed allowed clock skew.
 */
export function assertEnvelopeClockSkew(
  envelope: ProtocolMessageEnvelope<unknown>,
  options: { serverTimestamp?: string; maxSkewMs?: number } = {},
): void {
  const serverTime = options.serverTimestamp ? new Date(options.serverTimestamp).getTime() : Date.now();
  const clientTime = new Date(envelope.createdAt).getTime();
  const maxSkewMs = options.maxSkewMs ?? 300_000; // 5 minutes default
  const skew = Math.abs(serverTime - clientTime);

  if (skew > maxSkewMs) {
    throw new ClockSkewError(
      `Clock skew of ${skew}ms exceeds maximum tolerance of ${maxSkewMs}ms`,
      new Date(serverTime).toISOString(),
      envelope.createdAt,
      skew,
    );
  }
}
