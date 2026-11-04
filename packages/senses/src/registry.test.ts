import { EventTypeSpec, PLATFORM_EVENT_TYPES } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { PLATFORM_EVENTS } from "./platform";
import { EventPayloadError, EventTypeRegistry, UnknownEventTypeError } from "./registry";

const PACK_EVENT = {
  type: "materials.price.changed",
  description: "A price moved",
  subjectType: "catalog_item",
  payload: {
    type: "object",
    properties: { itemId: { type: "string" }, pct: { type: "number" } },
    required: ["itemId", "pct"],
    additionalProperties: false,
  },
  sample: { itemId: "x", pct: 12 },
};

describe("EventTypeRegistry", () => {
  it("lists every platform type with a schema and a sample that parses", () => {
    const r = new EventTypeRegistry();
    const types = r.list().map((s) => s.type);
    expect(types.sort()).toEqual([...PLATFORM_EVENT_TYPES].sort());
    for (const spec of r.list()) {
      expect(EventTypeSpec.safeParse(spec).success).toBe(true);
      expect(spec.payload.type).toBe("object");
      expect(() => r.parsePayload(spec.type, spec.sample)).not.toThrow();
    }
    expect(r.get("document.received")?.subjectType).toBe("document");
  });

  it("rejects unknown types and bad payloads", () => {
    const r = new EventTypeRegistry();
    expect(() => r.parsePayload("nope.never", {})).toThrow(UnknownEventTypeError);
    expect(() => r.parsePayload("document.extraction_failed", { documentId: "x" })).toThrow(
      EventPayloadError,
    );
    // Strict: an unexpected field is a mistake in the emitter, not something to drop silently.
    const sample = PLATFORM_EVENTS["document.extraction_failed"].sample;
    expect(() =>
      r.parsePayload("document.extraction_failed", { ...sample, body: "email text" }),
    ).toThrow(EventPayloadError);
  });

  it("adds pack types, validated against their JSON Schema", () => {
    const r = new EventTypeRegistry().registerPack("materials", [PACK_EVENT]);
    expect(r.sourceOf("materials.price.changed")).toBe("materials");
    expect(r.parsePayload("materials.price.changed", { itemId: "a", pct: 3 })).toEqual({
      itemId: "a",
      pct: 3,
    });
    expect(() => r.parsePayload("materials.price.changed", { itemId: "a" })).toThrow(
      EventPayloadError,
    );
  });

  it("shows pack types only to clients with the pack enabled", () => {
    const r = new EventTypeRegistry().registerPack("materials", [PACK_EVENT]);
    expect(r.list([]).some((s) => s.type === "materials.price.changed")).toBe(false);
    expect(r.list(["materials"]).some((s) => s.type === "materials.price.changed")).toBe(true);
    expect(Object.keys(r.byType([]))).toHaveLength(PLATFORM_EVENT_TYPES.length);
  });

  it("refuses packs that redefine or squat on other names", () => {
    const r = new EventTypeRegistry();
    expect(() => r.registerPack("materials", [{ ...PACK_EVENT, type: "alert.raised" }])).toThrow(
      /platform/,
    );
    expect(() => r.registerPack("other", [PACK_EVENT])).toThrow(/must start with/);
    r.registerPack("materials", [PACK_EVENT]);
    expect(() => r.registerPack("materials", [PACK_EVENT])).toThrow(/already registered/);
  });

  it("adds connector types for every client, refusing ones outside the connector's name", () => {
    const hook = { ...PACK_EVENT, type: "webhook.received", subjectType: "raw_record" };
    const r = new EventTypeRegistry().registerConnector("webhook", [hook]);
    expect(r.sourceOf("webhook.received")).toBe("connector:webhook");
    expect(r.list([]).some((s) => s.type === "webhook.received")).toBe(true);
    expect(r.parsePayload("webhook.received", { itemId: "a", pct: 1 })).toEqual({
      itemId: "a",
      pct: 1,
    });
    expect(() => r.registerConnector("webhook", [hook])).toThrow(/already registered/);
    expect(() =>
      new EventTypeRegistry().registerConnector("zoho_crm", [{ ...hook, type: "webhook.x" }]),
    ).toThrow(/must start with/);
    expect(() =>
      new EventTypeRegistry().registerConnector("inbox", [{ ...hook, type: "inbox.resolved" }]),
    ).toThrow(/platform event/);
  });
});
