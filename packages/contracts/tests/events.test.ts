import { describe, expect, it } from "vitest";
import {
  validBranchForkEvent,
  validCommandExecEvent,
  validCompactionEvent,
  validErrorEvent,
  validFileEditEvent,
  validMessageEvent,
  validModelReasoningEvent,
  validSessionLifecycleEvent,
  validSubagentLifecycleEvent,
  validToolCallEvent,
  validToolDiscoveryEvent,
  validToolResultEvent,
  validUnknownPassthroughEvent,
} from "../fixtures/index.js";
import {
  NormalizedBranchForkEventSchema,
  NormalizedCommandExecEventSchema,
  NormalizedCompactionEventSchema,
  NormalizedErrorEventSchema,
  NormalizedFileEditEventSchema,
  NormalizedMessageEventSchema,
  NormalizedModelReasoningEventSchema,
  NormalizedSessionEventSchema,
  NormalizedSessionLifecycleEventSchema,
  NormalizedSubagentLifecycleEventSchema,
  NormalizedToolCallEventSchema,
  NormalizedToolDiscoveryEventSchema,
  NormalizedToolResultEventSchema,
  NormalizedUnknownPassthroughEventSchema,
} from "../src/events.js";

describe("NormalizedSessionEvents", () => {
  const allEvents = [
    { name: "message", fixture: validMessageEvent, schema: NormalizedMessageEventSchema },
    {
      name: "model_reasoning",
      fixture: validModelReasoningEvent,
      schema: NormalizedModelReasoningEventSchema,
    },
    {
      name: "tool_discovery",
      fixture: validToolDiscoveryEvent,
      schema: NormalizedToolDiscoveryEventSchema,
    },
    { name: "tool_call", fixture: validToolCallEvent, schema: NormalizedToolCallEventSchema },
    {
      name: "tool_result",
      fixture: validToolResultEvent,
      schema: NormalizedToolResultEventSchema,
    },
    {
      name: "command_exec",
      fixture: validCommandExecEvent,
      schema: NormalizedCommandExecEventSchema,
    },
    { name: "file_edit", fixture: validFileEditEvent, schema: NormalizedFileEditEventSchema },
    { name: "error", fixture: validErrorEvent, schema: NormalizedErrorEventSchema },
    {
      name: "compaction",
      fixture: validCompactionEvent,
      schema: NormalizedCompactionEventSchema,
    },
    {
      name: "branch_fork",
      fixture: validBranchForkEvent,
      schema: NormalizedBranchForkEventSchema,
    },
    {
      name: "subagent_lifecycle",
      fixture: validSubagentLifecycleEvent,
      schema: NormalizedSubagentLifecycleEventSchema,
    },
    {
      name: "session_lifecycle",
      fixture: validSessionLifecycleEvent,
      schema: NormalizedSessionLifecycleEventSchema,
    },
    {
      name: "unknown_passthrough",
      fixture: validUnknownPassthroughEvent,
      schema: NormalizedUnknownPassthroughEventSchema,
    },
  ];

  describe("Union Schema Parsing", () => {
    it.each(allEvents)(
      "parses valid $name event through NormalizedSessionEventSchema",
      ({ fixture }) => {
        const parsed = NormalizedSessionEventSchema.parse(fixture);
        expect(parsed.type).toBe(fixture.type);
        expect(parsed.eventId).toBe(fixture.eventId);
      },
    );

    it.each(allEvents)(
      "parses valid $name event through specific schema",
      ({ fixture, schema }) => {
        const parsed = schema.parse(fixture);
        expect(parsed.type).toBe(fixture.type);
      },
    );
  });

  describe("Validation & Rejection", () => {
    it("rejects unknown event type in union schema", () => {
      const invalid = {
        ...validMessageEvent,
        type: "unknown_future_unsupported_type",
      };
      expect(() => NormalizedSessionEventSchema.parse(invalid)).toThrow();
    });

    it("rejects message with invalid role", () => {
      const invalid = {
        ...validMessageEvent,
        role: "admin_override",
      };
      expect(() => NormalizedMessageEventSchema.parse(invalid)).toThrow();
    });

    it("rejects event missing causal sequence", () => {
      const invalid = {
        ...validMessageEvent,
        causalRef: { parentId: "evt_001" }, // missing causalSequence
      };
      expect(() => NormalizedMessageEventSchema.parse(invalid)).toThrow();
    });

    it("rejects event with negative causal sequence", () => {
      const invalid = {
        ...validMessageEvent,
        causalRef: { causalSequence: -5 },
      };
      expect(() => NormalizedMessageEventSchema.parse(invalid)).toThrow();
    });

    it("rejects invalid timestamps", () => {
      const invalid = {
        ...validMessageEvent,
        timestamp: "not-a-valid-iso-date",
      };
      expect(() => NormalizedMessageEventSchema.parse(invalid)).toThrow();
    });
  });

  describe("Unknown Passthrough Forward Compatibility", () => {
    it("safely preserves raw payload for forward compatibility", () => {
      const customEvent = {
        ...validUnknownPassthroughEvent,
        rawEventType: "experimental_agent_checkpoint",
        rawPayload: {
          checkpointId: "chk_99",
          memoryVector: [0.12, 0.45, -0.88],
          nestedConfig: { enabled: true, tags: ["v2"] },
        },
      };

      const parsed = NormalizedSessionEventSchema.parse(customEvent);
      expect(parsed.type).toBe("unknown_passthrough");
      if (parsed.type === "unknown_passthrough") {
        expect(parsed.rawEventType).toBe("experimental_agent_checkpoint");
        expect(parsed.rawPayload.checkpointId).toBe("chk_99");
      }
    });
  });
});
