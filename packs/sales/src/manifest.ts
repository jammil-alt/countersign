// The Sales pack's manifest (docs/plan.md §1.164; ARCHITECTURE §12.0, the Sales area's first
// version): the record keys built from the client's synced CRM, the match and the look-up. The
// Confirm matches card and the "Spreadsheet to Zoho" template come with the next piece.
// DECISION: core's `AREA_OF_PACK` (owners/areas.ts) doesn't name this pack yet: naming it seeds a
// Sales start in onboarding (with generic intake questions) and moves processes into the Sales
// area. The template declares `area: "sales"` itself; the pack's owner-area mapping and its
// intake section come with it.

import {
  lazy,
  lazyObject,
  lazyObjects,
  lazyParse,
  PackManifest,
  type SkillDefinition,
} from "@countersign/core";
import { PACK_ID } from "./ids";
import { MATCH_THRESHOLD } from "./match/score";
import type { PackTool } from "./pack";
import { keysRefreshTool, matchRecordsTool, recordsLookupTool, SALES_TOOLS } from "./tools";

export { PACK_ID };

const schema = (tool: PackTool, key: "input" | "output") =>
  lazy(() => tool.spec[key] as Record<string, unknown>);

function toolSkill(
  tool: PackTool,
  def: {
    id: string;
    name: string;
    description: string;
    summary: string;
    settings?: SkillDefinition["settings"];
  },
): SkillDefinition {
  return lazyObject({
    schemaVersion: 1,
    id: def.id,
    name: def.name,
    description: def.description,
    category: "Sales",
    mode: "tool",
    handler: tool.spec.id,
    tools: [],
    input: schema(tool, "input"),
    output: schema(tool, "output"),
    settings: def.settings ?? [],
    summary: def.summary,
    requiresConnectors: [],
    requiresPacks: [PACK_ID],
    producesAlerts: false,
  });
}

export const SALES_SKILLS: readonly SkillDefinition[] = lazyObjects([
  toolSkill(matchRecordsTool, {
    id: "sales.match-records",
    name: "Match to CRM",
    description:
      "Matches each row to the client's CRM records (leads, contacts, accounts, deals): the same email, phone or website first, then the answers a person gave before, similar names and similar meaning, then a small model. Rows it isn't sure of wait for a person.",
    summary: "Matched {{counts.matched}} rows; {{counts.unsure}} for a person",
    settings: [
      {
        key: "match_threshold",
        label: "Match without a person at or above this confidence",
        type: "number",
        default: MATCH_THRESHOLD,
        clientSpecific: false,
      },
      {
        key: "match_on",
        label: "Compare on (email, phone, website, company, name, deal; empty for all)",
        type: "string",
        default: "",
        clientSpecific: false,
      },
    ],
  }),
  toolSkill(keysRefreshTool, {
    id: "sales.refresh-records",
    name: "Refresh CRM records for matching",
    description:
      "Brings the CRM records the match searches up to date: those synced since, and their search by meaning.",
    summary: "Built {{built}} record keys",
  }),
  toolSkill(recordsLookupTool, {
    id: "sales.look-up-records",
    name: "Look up CRM records",
    description:
      "Finds the client's synced CRM records in one module by a name, company, email, phone or deal name.",
    summary: "Found {{records.length}} records",
  }),
]);

export const salesManifest: PackManifest = lazyParse(PackManifest, () => ({
  id: PACK_ID,
  name: "Sales",
  version: "0.1.0",
  description:
    "The Sales area: the client's CRM records (leads, contacts, accounts, deals) kept ready to match, and rows from a file or a step matched to them by email, phone, website, name and meaning, a person deciding what isn't sure.",
  requiresConnectors: [],
  // §1.162: the connection the Sales area works through, for the client page's Areas tab.
  connections: [
    {
      connectors: ["zoho_crm"],
      use: "Leads, contacts, accounts and deals, synced to match rows against, and the records updated after approval.",
    },
  ],
  // DECISION: no events yet. A match answers its step (and the Confirm matches card resumes the
  // run); nothing else waits on a match today.
  events: [],
  tools: SALES_TOOLS.map((t) => t.spec),
  skills: SALES_SKILLS,
  templates: [],
  screens: [],
}));

export const SALES_HANDLERS: Readonly<Record<string, PackTool>> = Object.fromEntries(
  SALES_TOOLS.map((t) => [t.spec.id, t]),
);
