// The pack's sense types (ARCHITECTURE §12.2) for catalog and matching. M8b adds the price ones
// (`materials.price.observed`, `materials.price.changed`) to this list.

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
];

/** The platform's types plus the pack's, for validating what the pack emits. */
export const materialsEventRegistry = (): EventTypeRegistry =>
  new EventTypeRegistry().registerPack("materials", MATERIALS_EVENTS);
