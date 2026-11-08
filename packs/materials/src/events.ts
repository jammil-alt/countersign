// The pack's sense types (ARCHITECTURE §12.2): matching decisions, and prices recorded and changed.

import type { EventTypeSpec } from "@countersign/core";
import { EventTypeRegistry } from "@countersign/senses";

const uuid = { type: "string", format: "uuid" } as const;
const SAMPLE_LINE = "0192f7a0-0000-7000-8000-0000000000a1";
const SAMPLE_ITEM = "0192f7a0-0000-7000-8000-0000000000a2";
const SAMPLE_MATCH = "0192f7a0-0000-7000-8000-0000000000a3";

const decisionPayload = (required: string[]) => ({
  type: "object",
  properties: {
    docLineId: uuid,
    matchId: uuid,
    catalogItemId: { anyOf: [uuid, { type: "null" }] },
    decision: { type: "string", enum: ["matched", "new_item", "unsure"] },
    method: { type: "string", enum: ["alias", "rules", "llm", "human"] },
    confidence: { type: "string" },
  },
  required,
  additionalProperties: false,
});

const decimalString = { type: "string", pattern: "^-?\\d{1,10}(\\.\\d{1,4})?$" } as const;

function pricePayload(extra: string[]) {
  return {
    type: "object",
    properties: {
      observationId: uuid,
      catalogItemId: uuid,
      vendorId: uuid,
      observedOn: { type: "string", format: "date" },
      unitPriceStd: decimalString,
      standardUom: { type: "string" },
      ...(extra.length > 0
        ? {
            previousObservationId: uuid,
            previousUnitPriceStd: decimalString,
            changePct: { anyOf: [{ type: "string" }, { type: "null" }] },
          }
        : {}),
    },
    required: [
      "observationId",
      "catalogItemId",
      "vendorId",
      "observedOn",
      "unitPriceStd",
      "standardUom",
      ...extra,
    ],
    additionalProperties: false,
  };
}

const SAMPLE_PRICE = {
  observationId: "0192f7a0-0000-7000-8000-0000000000a4",
  catalogItemId: SAMPLE_ITEM,
  vendorId: "0192f7a0-0000-7000-8000-0000000000a5",
  observedOn: "2026-10-28",
  unitPriceStd: "68.5000",
  standardUom: "sheet",
};

export const MATERIALS_EVENTS: EventTypeSpec[] = [
  {
    type: "materials.line.matched",
    description: "A document line was matched to a catalog item, or made a new one, by the agent.",
    subjectType: "doc_line",
    payload: decisionPayload([
      "docLineId",
      "matchId",
      "catalogItemId",
      "decision",
      "method",
      "confidence",
    ]),
    sample: {
      docLineId: SAMPLE_LINE,
      matchId: SAMPLE_MATCH,
      catalogItemId: SAMPLE_ITEM,
      decision: "matched",
      method: "rules",
      confidence: "0.970",
    },
  },
  {
    type: "materials.line.needs_review",
    description: "A document line could not be matched with enough confidence; a person decides.",
    subjectType: "doc_line",
    payload: decisionPayload(["docLineId", "matchId", "decision", "method", "confidence"]),
    sample: {
      docLineId: SAMPLE_LINE,
      matchId: SAMPLE_MATCH,
      catalogItemId: null,
      decision: "unsure",
      method: "llm",
      confidence: "0.600",
    },
  },
  {
    type: "materials.match.decided",
    description: "A person decided a document line's catalog item.",
    subjectType: "doc_line",
    payload: decisionPayload([
      "docLineId",
      "matchId",
      "catalogItemId",
      "decision",
      "method",
      "confidence",
    ]),
    sample: {
      docLineId: SAMPLE_LINE,
      matchId: SAMPLE_MATCH,
      catalogItemId: SAMPLE_ITEM,
      decision: "matched",
      method: "human",
      confidence: "1.000",
    },
  },
  {
    type: "materials.price.observed",
    description: "A price was recorded for a catalog item, in its standard unit.",
    subjectType: "price_observation",
    payload: pricePayload([]),
    sample: SAMPLE_PRICE,
  },
  {
    type: "materials.price.changed",
    description: "A vendor's price for a catalog item differs from the last one recorded.",
    subjectType: "price_observation",
    payload: pricePayload(["previousObservationId", "previousUnitPriceStd", "changePct"]),
    sample: {
      ...SAMPLE_PRICE,
      previousObservationId: "0192f7a0-0000-7000-8000-0000000000a6",
      previousUnitPriceStd: "62.5000",
      changePct: "9.60",
    },
  },
];

/** The platform's types plus the pack's, for validating what the pack emits. */
export const materialsEventRegistry = (): EventTypeRegistry =>
  new EventTypeRegistry().registerPack("materials", MATERIALS_EVENTS);
