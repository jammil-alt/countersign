// The Close pack's manifest (docs/plan.md §1.232), in core's one pack shape (§1.230): its tools and
// skills for a month's close, its report screen, its configuration and the Month-end close template.
// It extends the Bookkeeping area (`extends: "bookkeeping"`): the same business area, its own pack.

import {
  lazy,
  lazyObject,
  lazyObjects,
  lazyParse,
  PackManifest,
  type SkillDefinition,
} from "@countersign/core";
import type { PackTool } from "../pack";
import { CLOSE_REPORTS } from "./api";
import { CLOSE_CONFIG_FIELDS } from "./config";
import { CLOSE_PACK_ID } from "./ids";
import { MONTH_END_CLOSE_TEMPLATE } from "./template";
import { CLOSE_TOOLS, checkTool, proposeTool, readyTool, writtenTool } from "./tools";

const schema = (tool: PackTool, key: "input" | "output") =>
  lazy(() => tool.spec[key] as Record<string, unknown>);

function toolSkill(
  tool: PackTool,
  def: { id: string; name: string; description: string; summary: string },
): SkillDefinition {
  return lazyObject({
    schemaVersion: 1,
    id: def.id,
    name: def.name,
    description: def.description,
    category: "Bookkeeping",
    mode: "tool",
    handler: tool.spec.id,
    tools: [],
    input: schema(tool, "input"),
    output: schema(tool, "output"),
    settings: [],
    summary: def.summary,
    requiresConnectors: [],
    requiresPacks: [CLOSE_PACK_ID],
    producesAlerts: false,
  });
}

export const CLOSE_SKILLS: readonly SkillDefinition[] = lazyObjects([
  toolSkill(checkTool, {
    id: "close.check-month",
    name: "Check the month's close",
    description:
      "Opens last month's close and checks each line: accounts reconciled, nothing uncategorized or entered twice, bank transactions booked, journal entries decided. Proposes reversals, recurring journals and accruals.",
    summary: "{{summary}}",
  }),
  toolSkill(readyTool, {
    id: "close.entries-to-record",
    name: "Journal entries to record",
    description: "The month's proposed journal entries, each as the entry in the accounting system it becomes.",
    summary: "{{count}} journal entries to record",
  }),
  toolSkill(writtenTool, {
    id: "close.record-written",
    name: "Record a written entry",
    description: "Records the journal entry an entry became in the accounting system, or what a person decided.",
    summary: "Recorded the entry as {{status}}",
  }),
  toolSkill(proposeTool, {
    id: "close.propose-entry",
    name: "Propose a journal entry",
    description:
      "Proposes an accrual or a recurring journal for the month, balanced, with the records it rests on. A person signs its write.",
    summary: "Proposed a journal entry: {{memo}}",
  }),
]);

export const closeManifest: PackManifest = lazyParse(PackManifest, () => ({
  id: CLOSE_PACK_ID,
  name: "Close",
  version: "0.1.0",
  description:
    "A month's close of the client's books in the accounting system: a checklist (accounts reconciled, nothing uncategorized or entered twice, bank transactions booked), accruals and recurring journals proposed and recorded after approval, and the month signed off by a person, with a close report in the portal.",
  area: "bookkeeping",
  // §1.232: the same business area as the Bookkeeping pack, whose reconciliations it reads.
  extends: "bookkeeping",
  // §1.230: what the operator sets when switching it on (read in ./store.ts `closeConfig`).
  config: CLOSE_CONFIG_FIELDS,
  // §1.230: none of its own; it reads what the QuickBooks connector synced.
  processors: [],
  reports: Object.keys(CLOSE_REPORTS),
  requiresConnectors: ["qbo"],
  connections: [
    {
      connectors: ["qbo"],
      use: "The books to close, and journal entries recorded after approval.",
    },
  ],
  events: [],
  tools: CLOSE_TOOLS.map((t) => t.spec),
  skills: CLOSE_SKILLS,
  templates: [MONTH_END_CLOSE_TEMPLATE],
  screens: [
    {
      route: "/reports/close/close",
      title: "Month-end close",
      roles: ["client_admin", "client_user"],
    },
  ],
}));

/** The pack's tool handlers by id, for apps/api to adapt into the tool registry. */
export const CLOSE_HANDLERS: Readonly<Record<string, PackTool>> = Object.fromEntries(
  CLOSE_TOOLS.map((t) => [t.spec.id, t]),
);
