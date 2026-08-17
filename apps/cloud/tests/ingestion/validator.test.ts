import { gzipSync } from "node:zlib";
import {
  NormalizedSessionEvent,
  hashCanonicalContent,
  normalizeSha256,
} from "@tool-evolver/contracts";
import {
  ChecksumMismatchError,
  ObservationBatchRequest,
  ProtocolMessageEnvelope,
} from "@tool-evolver/protocol";
import { describe, expect, it } from "vitest";
import {
  CursorOrderingError,
  DecompressionError,
  ObservationBatchValidator,
  ObservationValidationError,
  PayloadLimitExceededError,
} from "../../src/ingestion/validator.js";

describe("ObservationBatchValidator", () => {
  const sampleEvent: NormalizedSessionEvent = {
    eventId: "evt-001",
    schemaVersion: "1.0.0",
    sessionId: "sess-001",
    timestamp: "2026-08-17T12:00:00.000Z",
    causalRef: { causalSequence: 0 },
    redaction: {
      isRedacted: true,
      redactedFields: ["authHeader"],
      redactionStrategy: "mask",
      scrubbedPatterns: [],
    },
    type: "message",
    role: "user",
    content: "Hello AI",
  };

  const sampleEvent2: NormalizedSessionEvent = {
    eventId: "evt-002",
    schemaVersion: "1.0.0",
    sessionId: "sess-001",
    timestamp: "2026-08-17T12:00:01.000Z",
    causalRef: { causalSequence: 1, parentId: "evt-001" },
    redaction: {
      isRedacted: true,
      redactedFields: [],
      redactionStrategy: "none",
      scrubbedPatterns: [],
    },
    type: "message",
    role: "assistant",
    content: "Hello! How can I help you?",
  };

  const validRequest: ObservationBatchRequest = {
    batchId: "batch-001",
    workspaceId: "ws-001",
    deviceId: "dev-001",
    installationId: "inst-001",
    cursor: "seq-1",
    compressed: false,
    compression: "none",
    observations: [sampleEvent, sampleEvent2],
  };

  it("should successfully validate a direct ObservationBatchRequest", () => {
    const validator = new ObservationBatchValidator();
    const result = validator.validateBatch(validRequest);

    expect(result.request.batchId).toBe("batch-001");
    expect(result.observations.length).toBe(2);
    expect(result.contentHash).toBe(hashCanonicalContent([sampleEvent, sampleEvent2]));
    expect(result.envelope).toBeUndefined();
  });

  it("should successfully validate an enveloped request with matching digest", () => {
    const validator = new ObservationBatchValidator();
    const payloadDigest = normalizeSha256(hashCanonicalContent(validRequest));

    const envelope: ProtocolMessageEnvelope<ObservationBatchRequest> = {
      version: "1.0.0",
      messageId: "msg-001",
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 1,
      createdAt: "2026-08-17T12:00:00.000Z",
      compression: "none",
      payloadType: "observation_batch",
      payloadDigest,
      payload: validRequest,
    };

    const result = validator.validateBatch(envelope);
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.messageId).toBe("msg-001");
    expect(result.request.batchId).toBe("batch-001");
  });

  it("should throw ChecksumMismatchError when envelope digest does not match payload", () => {
    const validator = new ObservationBatchValidator();
    const envelope: ProtocolMessageEnvelope<ObservationBatchRequest> = {
      version: "1.0.0",
      messageId: "msg-001",
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 1,
      createdAt: "2026-08-17T12:00:00.000Z",
      compression: "none",
      payloadType: "observation_batch",
      payloadDigest: "a".repeat(64), // Invalid digest
      payload: validRequest,
    };

    expect(() => validator.validateBatch(envelope)).toThrow(ChecksumMismatchError);
  });

  it("should reject empty batch if minEventsPerBatch is not met", () => {
    const validator = new ObservationBatchValidator({ minEventsPerBatch: 1 });
    const emptyRequest: ObservationBatchRequest = {
      ...validRequest,
      observations: [],
    };

    expect(() => validator.validateBatch(emptyRequest)).toThrow(ObservationValidationError);
  });

  it("should reject batch exceeding maxEventsPerBatch", () => {
    const validator = new ObservationBatchValidator({ maxEventsPerBatch: 2 });
    const thirdEvent: NormalizedSessionEvent = {
      ...sampleEvent,
      eventId: "evt-003",
      timestamp: "2026-08-17T12:00:02.000Z",
    };

    const largeRequest: ObservationBatchRequest = {
      ...validRequest,
      observations: [sampleEvent, sampleEvent2, thirdEvent],
    };

    expect(() => validator.validateBatch(largeRequest)).toThrow(PayloadLimitExceededError);
  });

  it("should enforce timestamp ordering across events within a batch", () => {
    const validator = new ObservationBatchValidator({ enforceTimestampOrdering: true });
    const disorderedEvent: NormalizedSessionEvent = {
      ...sampleEvent2,
      eventId: "evt-002",
      timestamp: "2026-08-17T11:59:00.000Z", // Earlier than sampleEvent (12:00:00)
    };

    const disorderedRequest: ObservationBatchRequest = {
      ...validRequest,
      observations: [sampleEvent, disorderedEvent],
    };

    expect(() => validator.validateBatch(disorderedRequest)).toThrow(CursorOrderingError);
  });

  it("should validate and decompress gzip payload within limits", () => {
    const validator = new ObservationBatchValidator({ maxDecompressedSizeBytes: 1024 * 1024 });
    const jsonStr = JSON.stringify(validRequest);
    const compressedBuffer = gzipSync(Buffer.from(jsonStr, "utf8"));

    const decompressed = validator.decompressPayload(compressedBuffer, "gzip");
    expect(decompressed).toBe(jsonStr);
  });

  it("should reject decompression when decompressed size exceeds limit", () => {
    const validator = new ObservationBatchValidator({ maxDecompressedSizeBytes: 50 });
    const jsonStr = JSON.stringify(validRequest); // > 200 bytes
    const compressedBuffer = gzipSync(Buffer.from(jsonStr, "utf8"));

    expect(() => validator.decompressPayload(compressedBuffer, "gzip")).toThrow(PayloadLimitExceededError);
  });

  it("should reject malformed event schema", () => {
    const validator = new ObservationBatchValidator();
    const malformedRequest = {
      ...validRequest,
      observations: [
        {
          eventId: "evt-bad",
          // missing required fields
          type: "message",
        },
      ],
    };

    expect(() => validator.validateBatch(malformedRequest)).toThrow(ObservationValidationError);
  });
});
