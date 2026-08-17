import { gunzipSync, inflateSync } from "node:zlib";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  RedactionMetaSchema,
  hashCanonicalContent,
  normalizeSha256,
} from "@tool-evolver/contracts";
import {
  ChecksumMismatchError,
  type ObservationBatchRequest,
  ObservationBatchRequestSchema,
  type ProtocolMessageEnvelope,
  ProtocolMessageEnvelopeSchema,
} from "@tool-evolver/protocol";
import { z } from "zod";

/**
 * Custom error thrown when batch validation fails.
 */
export class ObservationValidationError extends Error {
  public readonly errors: Array<{ field?: string; message: string }>;

  constructor(message: string, errors: Array<{ field?: string; message: string }> = []) {
    super(message);
    this.name = "ObservationValidationError";
    this.errors = errors;
  }
}

/**
 * Custom error thrown when payload or decompression size exceeds limit.
 */
export class PayloadLimitExceededError extends Error {
  public readonly limitBytes: number;
  public readonly actualBytes: number;

  constructor(message: string, limitBytes: number, actualBytes: number) {
    super(message);
    this.name = "PayloadLimitExceededError";
    this.limitBytes = limitBytes;
    this.actualBytes = actualBytes;
  }
}

/**
 * Custom error thrown when cursor ordering is violated.
 */
export class CursorOrderingError extends Error {
  public readonly previousTimestamp?: string;
  public readonly currentTimestamp?: string;

  constructor(message: string, previousTimestamp?: string, currentTimestamp?: string) {
    super(message);
    this.name = "CursorOrderingError";
    this.previousTimestamp = previousTimestamp;
    this.currentTimestamp = currentTimestamp;
  }
}

/**
 * Custom error thrown when decompression fails.
 */
export class DecompressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecompressionError";
  }
}

/**
 * Validation configuration options.
 */
export interface BatchValidatorOptions {
  maxBatchSizeBytes?: number; // Default 10MB
  maxDecompressedSizeBytes?: number; // Default 50MB
  maxEventsPerBatch?: number; // Default 1,000
  minEventsPerBatch?: number; // Default 1
  enforceTimestampOrdering?: boolean; // Default true
}

export const DEFAULT_BATCH_VALIDATOR_OPTIONS: Required<BatchValidatorOptions> = {
  maxBatchSizeBytes: 10 * 1024 * 1024, // 10 MB
  maxDecompressedSizeBytes: 50 * 1024 * 1024, // 50 MB
  maxEventsPerBatch: 1000,
  minEventsPerBatch: 1,
  enforceTimestampOrdering: true,
};

/**
 * Validated batch request result.
 */
export interface ValidatedBatch {
  envelope?: ProtocolMessageEnvelope<ObservationBatchRequest>;
  request: ObservationBatchRequest;
  observations: NormalizedSessionEvent[];
  rawByteSize: number;
  contentHash: string;
}

/**
 * Batch request validator.
 * Validates envelope structure, compression, byte/event limits,
 * cursor ordering, event schemas, canonical hashes, and redaction metadata.
 */
export class ObservationBatchValidator {
  private options: Required<BatchValidatorOptions>;

  constructor(options: BatchValidatorOptions = {}) {
    this.options = { ...DEFAULT_BATCH_VALIDATOR_OPTIONS, ...options };
  }

  /**
   * Decompresses raw payload buffer if needed, enforcing decompression limits.
   */
  decompressPayload(
    data: Buffer | Uint8Array | string,
    compression: "none" | "gzip" | "zstd" | "deflate" = "none",
  ): string {
    const rawBuffer = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);

    if (rawBuffer.length > this.options.maxBatchSizeBytes) {
      throw new PayloadLimitExceededError(
        `Payload size (${rawBuffer.length} bytes) exceeds limit of ${this.options.maxBatchSizeBytes} bytes`,
        this.options.maxBatchSizeBytes,
        rawBuffer.length,
      );
    }

    if (compression === "none") {
      return rawBuffer.toString("utf8");
    }

    let decompressed: Buffer;
    try {
      if (compression === "gzip") {
        decompressed = gunzipSync(rawBuffer, {
          maxOutputLength: this.options.maxDecompressedSizeBytes,
        });
      } else if (compression === "deflate") {
        decompressed = inflateSync(rawBuffer, {
          maxOutputLength: this.options.maxDecompressedSizeBytes,
        });
      } else {
        throw new DecompressionError(`Unsupported compression algorithm: ${compression}`);
      }
    } catch (err: unknown) {
      if (err instanceof DecompressionError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("maxOutputLength") ||
        msg.includes("limit") ||
        msg.includes("Cannot create a Buffer")
      ) {
        throw new PayloadLimitExceededError(
          `Decompressed payload exceeds maximum size limit of ${this.options.maxDecompressedSizeBytes} bytes`,
          this.options.maxDecompressedSizeBytes,
          this.options.maxDecompressedSizeBytes + 1,
        );
      }
      throw new DecompressionError(`Failed to decompress payload with ${compression}: ${msg}`);
    }

    if (decompressed.length > this.options.maxDecompressedSizeBytes) {
      throw new PayloadLimitExceededError(
        `Decompressed payload size (${decompressed.length} bytes) exceeds limit of ${this.options.maxDecompressedSizeBytes} bytes`,
        this.options.maxDecompressedSizeBytes,
        decompressed.length,
      );
    }

    return decompressed.toString("utf8");
  }

  /**
   * Validates an observation batch request or envelope.
   */
  validateBatch(input: unknown, rawByteSize?: number): ValidatedBatch {
    if (!input || typeof input !== "object") {
      throw new ObservationValidationError("Invalid request body: expected JSON object");
    }

    let envelope: ProtocolMessageEnvelope<ObservationBatchRequest> | undefined;
    let request: ObservationBatchRequest;

    const rawObj = input as Record<string, unknown>;

    // 1. Check if input is wrapped in a ProtocolMessageEnvelope
    if ("messageId" in rawObj && "payload" in rawObj && "payloadDigest" in rawObj) {
      const parsedEnvelope = ProtocolMessageEnvelopeSchema.safeParse(rawObj);
      if (!parsedEnvelope.success) {
        throw new ObservationValidationError(
          `Invalid protocol envelope: ${parsedEnvelope.error.message}`,
          parsedEnvelope.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        );
      }

      // Verify envelope payload digest
      const expectedDigest = normalizeSha256(hashCanonicalContent(rawObj.payload));
      const givenDigest = normalizeSha256(parsedEnvelope.data.payloadDigest);
      if (expectedDigest !== givenDigest) {
        throw new ChecksumMismatchError(
          expectedDigest,
          givenDigest,
          `Envelope payload digest mismatch: expected ${expectedDigest}, received ${givenDigest}`,
        );
      }

      envelope = parsedEnvelope.data as ProtocolMessageEnvelope<ObservationBatchRequest>;
      const parsedReq = ObservationBatchRequestSchema.safeParse(parsedEnvelope.data.payload);
      if (!parsedReq.success) {
        throw new ObservationValidationError(
          `Invalid observation batch request in envelope payload: ${parsedReq.error.message}`,
          parsedReq.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        );
      }
      request = parsedReq.data;
    } else {
      // Direct ObservationBatchRequest
      const parsedReq = ObservationBatchRequestSchema.safeParse(rawObj);
      if (!parsedReq.success) {
        throw new ObservationValidationError(
          `Invalid observation batch request: ${parsedReq.error.message}`,
          parsedReq.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        );
      }
      request = parsedReq.data;
    }

    // 2. Validate Event Limits
    const eventCount = request.observations.length;
    if (eventCount < this.options.minEventsPerBatch) {
      throw new ObservationValidationError(
        `Batch must contain at least ${this.options.minEventsPerBatch} observation event(s), received ${eventCount}`,
      );
    }
    if (eventCount > this.options.maxEventsPerBatch) {
      throw new PayloadLimitExceededError(
        `Batch exceeds maximum event limit of ${this.options.maxEventsPerBatch} (received ${eventCount})`,
        this.options.maxEventsPerBatch,
        eventCount,
      );
    }

    // 3. Validate Each Event Schema and Redaction Metadata
    const validatedObservations: NormalizedSessionEvent[] = [];
    for (let i = 0; i < request.observations.length; i++) {
      const obs = request.observations[i];
      const parsedEvent = NormalizedSessionEventSchema.safeParse(obs);
      if (!parsedEvent.success) {
        const obsId =
          typeof obs === "object" && obs !== null && "eventId" in obs
            ? String((obs as Record<string, unknown>).eventId)
            : "unknown";
        throw new ObservationValidationError(
          `Invalid event schema at index ${i} (eventId: ${obsId}): ${parsedEvent.error.message}`,
          parsedEvent.error.issues.map((issue) => ({
            field: `observations[${i}].${issue.path.join(".")}`,
            message: issue.message,
          })),
        );
      }

      // Redaction metadata check
      const parsedRedaction = RedactionMetaSchema.safeParse(parsedEvent.data.redaction);
      if (!parsedRedaction.success) {
        throw new ObservationValidationError(
          `Invalid redaction metadata at index ${i}: ${parsedRedaction.error.message}`,
        );
      }

      validatedObservations.push(parsedEvent.data);
    }

    // 4. Validate Cursor Ordering & Timestamp Monotonicity
    if (this.options.enforceTimestampOrdering && validatedObservations.length > 1) {
      for (let i = 1; i < validatedObservations.length; i++) {
        const prevTs = new Date(validatedObservations[i - 1].timestamp).getTime();
        const currTs = new Date(validatedObservations[i].timestamp).getTime();

        if (Number.isNaN(prevTs) || Number.isNaN(currTs)) {
          throw new CursorOrderingError(
            `Invalid timestamp format in observations at indices ${i - 1} or ${i}`,
            validatedObservations[i - 1].timestamp,
            validatedObservations[i].timestamp,
          );
        }

        // Allow up to 1000ms clock skew / identical timestamps within batch
        if (currTs < prevTs - 1000) {
          throw new CursorOrderingError(
            `Observations are out of order: event at index ${i} (${validatedObservations[i].timestamp}) occurred before index ${i - 1} (${validatedObservations[i - 1].timestamp})`,
            validatedObservations[i - 1].timestamp,
            validatedObservations[i].timestamp,
          );
        }
      }
    }

    // 5. Compute canonical content hash
    const contentHash = hashCanonicalContent(validatedObservations);

    return {
      envelope,
      request,
      observations: validatedObservations,
      rawByteSize: rawByteSize ?? JSON.stringify(request).length,
      contentHash,
    };
  }
}
