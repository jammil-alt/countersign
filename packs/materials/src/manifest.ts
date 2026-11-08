// The Materials pack's manifest (ARCHITECTURE §12.1–12.2): its tools, skills and events for the
// catalog, matching, prices and alerts, and the client reports it adds to the portal.
// DECISION: no agent templates (owner, 2026-11-07; docs/plan.md §1.63): agents on the Purchasing
// area, Pia included, are built by the operator in the Agent lab from these tools and skills.

import { PackManifest, type SkillDefinition } from "@countersign/core";
import { MATCH_CONFIDENCE_AUTO } from "./catalog/settings";
import { MATERIALS_EVENTS } from "./events";
import { PACK_ID } from "./ids";
import { PRICE_DEFAULTS } from "./pricing/rules";
import { PURCHASING_SKILLS } from "./purchasing/skills";
import { PURCHASING_TOOLS } from "./purchasing/tools";
import {
  catalogDuplicates,
  MATERIALS_TOOLS,
  matchLinesTool,
  type PackTool,
  pricesCheck,
  pricesCompareVendors,
  pricesDigest,
  pricesRecord,
} from "./tools";

export { PACK_ID };

// P-5: the Purchasing area's tools, after the catalog's and the prices'.
const ALL_TOOLS: readonly PackTool[] = [...MATERIALS_TOOLS, ...PURCHASING_TOOLS];

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
  {
    schemaVersion: 1,
    id: "materials.record-prices",
    name: "Record prices",
    description:
      "Records what each matched line of an invoice cost, per sheet, board foot, linear foot, each or gallon, so prices compare across vendors. Freight and surcharges are kept apart.",
    category: "Materials",
    mode: "tool",
    handler: pricesRecord.spec.id,
    tools: [],
    input: schema(pricesRecord, "input"),
    output: schema(pricesRecord, "output"),
    settings: [],
    summary: "Recorded {{recorded}} prices from {{total}} lines",
    requiresConnectors: [],
    requiresPacks: [PACK_ID],
    producesAlerts: false,
  },
  {
    schemaVersion: 1,
    id: "materials.price-check",
    name: "Check prices",
    description:
      "Compares an invoice's prices with what the client paid before and what other vendors charge, and raises an alert, with the invoices behind it and the dollars at stake, when a price jumps, creeps, beats its average, another vendor is cheaper, a new fee appears or a purchase is unusual.",
    category: "Materials",
    // DECISION: the six rules are code with thresholds (ARCHITECTURE §12.4), so the skill runs them
    // as a tool (deterministic first); a model would add cost and nothing the rules don't decide.
    mode: "tool",
    handler: pricesCheck.spec.id,
    tools: [],
    input: schema(pricesCheck, "input"),
    output: schema(pricesCheck, "output"),
    settings: [
      {
        key: "price_change_pct",
        label: "Alert when a price goes up more than this percent",
        type: "number",
        default: PRICE_DEFAULTS.price_change_pct,
        clientSpecific: false,
      },
      {
        key: "vendor_spread_pct",
        label: "Alert when another vendor is cheaper by more than this percent",
        type: "number",
        default: PRICE_DEFAULTS.vendor_spread_pct,
        clientSpecific: false,
      },
      {
        key: "creep_pct",
        label: "Alert when small increases add up to more than this percent in 90 days",
        type: "number",
        default: PRICE_DEFAULTS.creep_pct,
        clientSpecific: false,
      },
      {
        key: "ignore_vendors",
        label: "Vendors not to alert on (names, comma-separated)",
        type: "string",
        default: "",
        clientSpecific: true,
      },
    ],
    summary: "Checked {{checked}} prices; raised {{raised}} alerts",
    requiresConnectors: [],
    requiresPacks: [PACK_ID],
    producesAlerts: true,
  },
  {
    schemaVersion: 1,
    id: "materials.vendor-compare",
    name: "Compare vendors",
    description:
      "Shows what each vendor charged for one item over the last 90 days: last and average price and how much was bought, cheapest first.",
    category: "Materials",
    mode: "tool",
    handler: pricesCompareVendors.spec.id,
    tools: [],
    input: schema(pricesCompareVendors, "input"),
    output: schema(pricesCompareVendors, "output"),
    settings: [],
    summary: "Compared {{vendors.length}} vendors",
    requiresConnectors: [],
    requiresPacks: [PACK_ID],
    producesAlerts: false,
  },
  {
    schemaVersion: 1,
    id: "materials.weekly-digest",
    name: "Weekly price digest",
    description:
      "Sums up the week in prices: what went up or down, the alerts raised and the dollars at stake, as a short message for the client.",
    category: "Materials",
    mode: "tool",
    handler: pricesDigest.spec.id,
    tools: [],
    input: schema(pricesDigest, "input"),
    output: schema(pricesDigest, "output"),
    settings: [],
    summary: "{{prices}} prices this week; {{alerts.length}} alerts",
    requiresConnectors: [],
    requiresPacks: [PACK_ID],
    producesAlerts: false,
  },
  // P-5: the Purchasing area's skills (docs/plan.md §1.67).
  ...PURCHASING_SKILLS,
];

export const materialsManifest: PackManifest = PackManifest.parse({
  id: PACK_ID,
  name: "Materials",
  // P-5: 0.2.0 adds purchase requests, quotes, purchase orders and prices from QuickBooks bills.
  version: "0.2.0",
  description:
    "Material cost management and purchasing: the client's catalog of materials, matching invoice lines across vendors, prices and alerts, purchase requests, quotes and purchase orders.",
  requiresConnectors: [],
  events: MATERIALS_EVENTS,
  tools: ALL_TOOLS.map((t) => t.spec),
  skills: MATERIALS_SKILLS,
  templates: [],
  screens: [
    {
      route: "/reports/materials/prices",
      title: "Price watch",
      roles: ["client_admin", "client_user"],
    },
    {
      route: "/reports/materials/catalog",
      title: "Catalog",
      roles: ["client_admin", "client_user"],
    },
  ],
});

/** The pack's tool handlers by id, for apps/api to adapt into the tool registry. */
export const MATERIALS_HANDLERS: Readonly<Record<string, PackTool>> = Object.fromEntries(
  ALL_TOOLS.map((t) => [t.spec.id, t]),
);
