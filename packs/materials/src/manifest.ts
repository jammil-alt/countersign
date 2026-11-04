// The Materials pack's manifest (ARCHITECTURE §12.1–12.2): its tools, skills and events for the
// catalog and matching. M8b adds pricing and alerts (tools, skills, events), the Pia template and
// her workflows (`templates`) and the report screens (`screens`) to these lists.

import { PackManifest, type SkillDefinition } from "@countersign/core";
import { MATCH_CONFIDENCE_AUTO } from "./catalog/settings";
import { MATERIALS_EVENTS } from "./events";
import { catalogDuplicates, MATERIALS_TOOLS, matchLinesTool, type PackTool } from "./tools";

export const PACK_ID = "materials";

const schema = (tool: PackTool, key: "input" | "output") =>
  tool.spec[key] as Record<string, unknown>;

export const MATERIALS_SKILLS: readonly SkillDefinition[] = [
  {
    schemaVersion: 1,
    id: "materials.match-lines",
    name: "Match lines to the catalog",
    description:
      "Matches each line of an invoice to the client's catalog: known vendor names first, then the attribute rules, then a model check. Lines it isn't sure of are left for review.",
    category: "Materials",
    mode: "tool",
    handler: matchLinesTool.spec.id,
    tools: [],
    input: schema(matchLinesTool, "input"),
    output: schema(matchLinesTool, "output"),
    settings: [
      {
        key: "match_confidence_auto",
        label: "Match automatically at or above this confidence",
        type: "number",
        default: MATCH_CONFIDENCE_AUTO,
        clientSpecific: false,
      },
    ],
    summary: "Matched {{matched}} of {{total}} lines; {{needsReview}} to review",
    requiresConnectors: [],
    requiresPacks: [PACK_ID],
    producesAlerts: false,
  },
  {
    schemaVersion: 1,
    id: "materials.review-merge",
    name: "Find duplicate catalog items",
    description:
      "Looks for catalog items that are probably the same thing and asks the operator to merge them. Never merges by itself.",
    category: "Materials",
    mode: "agent",
    // DECISION: the agent proposes, a person merges (back office); a merge moves price history,
    // so it is never an agent's call.
    instructions: [
      "List likely duplicates with materials.catalog.duplicates.",
      "For each pair that is truly one item (same material, size, thickness, grade or model; one of them just states less), create one review item for the operator with inbox.create: title 'Merge catalog items', payload { fromId, intoId, reason }, keeping the item that states more.",
      "Skip pairs that could be different items. Never merge yourself.",
      "Finish with the proposals you made and their item ids as sources.",
    ].join("\n"),
    tools: [catalogDuplicates.spec.id, "materials.catalog.search", "inbox.create"],
    input: { type: "object", properties: { category: { type: "string" } } },
    output: {
      type: "object",
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fromId: { type: "string" },
              intoId: { type: "string" },
              reason: { type: "string" },
            },
            required: ["fromId", "intoId", "reason"],
          },
        },
        sources: { type: "array", items: { type: "string" } },
      },
      required: ["proposals", "sources"],
    },
    settings: [],
    summary: "Proposed merging {{proposals.length}} pairs of catalog items",
    requiresConnectors: [],
    requiresPacks: [PACK_ID],
    producesAlerts: false,
  },
];

export const materialsManifest: PackManifest = PackManifest.parse({
  id: PACK_ID,
  name: "Materials",
  version: "0.1.0",
  description:
    "Material cost management: the client's catalog of materials, matching invoice lines across vendors, prices and alerts.",
  requiresConnectors: [],
  events: MATERIALS_EVENTS,
  tools: MATERIALS_TOOLS.map((t) => t.spec),
  skills: MATERIALS_SKILLS,
  templates: [],
  screens: [],
});

/** The pack's tool handlers by id, for apps/api to adapt into the tool registry. */
export const MATERIALS_HANDLERS: Readonly<Record<string, PackTool>> = Object.fromEntries(
  MATERIALS_TOOLS.map((t) => [t.spec.id, t]),
);
