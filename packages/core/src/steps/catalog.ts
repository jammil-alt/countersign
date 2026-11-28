// The action catalog (docs/step-model-plan.md §10c–§10e): what a Do step's "Uses" picker offers, made
// by code from the registered tools. Every action belongs to a **connector** (a system outside
// Mezonas) or an **area** (our own records), has a kind (Get, Save, Change, Send), and its input and
// output fields. Merged connectors (Email, Team chat, Spreadsheets, Accounting) offer one action
// that runs on whichever of their connectors the client has connected (§10c).
//
// Pure: the API serves it, the builder shows it, the Builder reads it. Nothing here names a pack
// (invariant 2): areas and connectors are named by the caller.

import { ACTION_SPECS } from "../process/actions";
import { CHANNEL_TOOLS } from "../reach/rules";
import type { JsonSchema } from "../schemas/common";
import type { ToolSpec } from "../schemas/tool";
import type { Field, FieldType } from "./schema";

/** An action's kind: Get (reads), Save (to our records), Change (in an outside system), Send. */
export const ACTION_KINDS = ["get", "save", "change", "send"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface CatalogAction {
  /** The action's id: a tool's, or a merged connector's (`email.send`). */
  id: string;
  label: string;
  description: string;
  kind: ActionKind;
  input: Field[];
  output: Field[];
}

export interface CatalogGroup {
  type: "connector" | "area";
  /** A connector's id (`qbo`, or a merged one: `email`), or an area's (`purchasing`, `shared`). */
  id: string;
  name: string;
  actions: CatalogAction[];
}

/** One action of a merged connector: the tool each of its connectors runs it with. */
export interface MergedAction {
  id: string;
  label: string;
  /** Connector id to tool id. */
  tools: Readonly<Record<string, string>>;
}

export interface MergedConnector {
  id: string;
  name: string;
  actions: readonly MergedAction[];
}

const emailTools = Object.fromEntries(
  Object.entries(CHANNEL_TOOLS).flatMap(([c, k]) => (k.email ? [[c, k.email]] : [])),
);

/**
 * The merged connectors (owner, 2026-11-25): a template works for any client, whichever of them it
 * has. Accounting carries the actions built today (`../process/actions`); more come as the rebuilt
 * agents need them.
 */
// DECISION: merged action ids sit under the merged connector's id (`email.send`); Resend's own tool
// shares that id today and is renamed in stream E, so no merged id is also a tool's.
export const MERGED_CONNECTORS: readonly MergedConnector[] = [
  {
    id: "email",
    name: "Email",
    actions: [{ id: "email.send", label: "Send email", tools: emailTools }],
  },
  {
    id: "teamchat",
    name: "Team chat",
    actions: [
      {
        id: "teamchat.message.post",
        label: "Post a message",
        tools: {
          slack: "slack.message.post",
          teams: "teams.message.post",
          gchat: "gchat.message.post",
        },
      },
    ],
  },
  {
    id: "spreadsheet",
    name: "Spreadsheets",
    actions: [
      {
        id: "spreadsheet.range.read",
        label: "Read cells",
        tools: { gsheets: "sheets.range.read", excel: "excel.range.read" },
      },
      {
        id: "spreadsheet.rows.append",
        label: "Add rows",
        tools: { gsheets: "sheets.rows.append", excel: "excel.rows.append" },
      },
      {
        id: "spreadsheet.range.update",
        label: "Change cells",
        tools: { gsheets: "sheets.range.update", excel: "excel.range.update" },
      },
    ],
  },
  {
    id: "accounting",
    name: "Accounting",
    actions: [
      {
        id: "accounting.bill.create",
        label: ACTION_SPECS.create_bill.label,
        tools: ACTION_SPECS.create_bill.tools,
      },
      {
        id: "accounting.vendor.create",
        label: ACTION_SPECS.create_vendor.label,
        tools: ACTION_SPECS.create_vendor.tools,
      },
    ],
  },
];

/** The merged action an id names, if any. */
export function mergedAction(id: string): MergedAction | undefined {
  for (const c of MERGED_CONNECTORS) {
    const a = c.actions.find((x) => x.id === id);
    if (a) return a;
  }
  return undefined;
}

/** The tool a merged action runs on for a client with these connectors (in the merge's order). */
export function resolveMerged(id: string, connected: readonly string[]): string | undefined {
  const a = mergedAction(id);
  if (!a) return undefined;
  for (const [connector, tool] of Object.entries(a.tools)) {
    if (connected.includes(connector)) return tool;
  }
  return undefined;
}

/**
 * Tools never offered as an action: the engines behind Do steps done by a person or a contact, and
 * the platform's own (the supervisor's, Sloan's, the agents' own) (§10e).
 */
const ENGINE_TOOLS = new Set([
  "comms.reach_out",
  "comms.converse",
  "forms.request",
  "inbox.create",
  "agents.ask",
  "manual.read",
  "sop.read",
  "supervisor.report",
  "supervisor.check",
]);
const PLATFORM_PREFIXES = ["health.", "account."];

export function isOfferedAction(spec: Pick<ToolSpec, "id">): boolean {
  if (ENGINE_TOOLS.has(spec.id)) return false;
  return !PLATFORM_PREFIXES.some((p) => spec.id.startsWith(p));
}

/** Writes that send a message somewhere (a channel post, a call) though they name no recipient. */
// DECISION: by name, the few that send without naming a person (Odoo's `invoice.post` posts a
// ledger entry, so `post` alone isn't enough).
const SENDS = /\.send$|\.message\.post$|^linkedin\.post$|^call\.place$/;

/** A tool's kind of action. */
export function actionKind(spec: Pick<ToolSpec, "id" | "sideEffect" | "recipient">): ActionKind {
  if (spec.sideEffect === "none") return "get";
  if (spec.sideEffect === "internal") return "save";
  return spec.recipient !== undefined || SENDS.test(spec.id) ? "send" : "change";
}

/**
 * Where a tool's action lives: the connector it acts through or comes from (a connector's reads name
 * no `connector`, only their `source`), else its area (`shared` by default).
 */
export function actionOwner(
  spec: Pick<ToolSpec, "connector" | "area" | "source">,
  connectors: ReadonlySet<string> = new Set(),
): { type: "connector" | "area"; id: string } {
  if (spec.connector) return { type: "connector", id: spec.connector };
  if (connectors.has(spec.source)) return { type: "connector", id: spec.source };
  if (spec.area) return { type: "area", id: spec.area };
  return { type: "area", id: spec.source === "platform" ? "shared" : spec.source };
}

/** A JSON schema's properties as fields, one level of lists and groups deep at a time. */
export function fieldsFromSchema(schema: JsonSchema | undefined): Field[] {
  const s = (schema ?? {}) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {}).map(([name, p]) => {
    const raw = Array.isArray(p.type) ? (p.type as string[]).find((t) => t !== "null") : p.type;
    const type: FieldType =
      raw === "number" || raw === "integer"
        ? "number"
        : raw === "boolean"
          ? "yes_no"
          : raw === "array"
            ? "list"
            : raw === "object"
              ? "group"
              : p.format === "date" || p.format === "date-time"
                ? "date"
                : "text";
    const field: Field = { name, type, required: required.has(name) };
    if (typeof p.description === "string") field.about = p.description.slice(0, 200);
    if (type === "list") {
      const items = (p.items ?? {}) as JsonSchema;
      field.of = (items as { type?: unknown }).type === "object" ? fieldsFromSchema(items) : [];
    }
    if (type === "group") field.of = fieldsFromSchema(p as JsonSchema);
    return field;
  });
}

/**
 * The catalog: every offered tool grouped by its connector or area, then the merged connectors
 * whose connectors are registered (their input and output are their first connector's). Names come
 * from the caller: connectors' from their manifests, areas' from the packs and the platform.
 */
export function buildActionCatalog(
  specs: readonly ToolSpec[],
  names: { connectors: Readonly<Record<string, string>>; areas: Readonly<Record<string, string>> },
  label: (spec: ToolSpec) => string = (spec) => spec.id,
): CatalogGroup[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const connectorIds = new Set(Object.keys(names.connectors));
  // A tool a merged action runs is offered there only: Gmail's send is Email's.
  const merged = new Set(
    MERGED_CONNECTORS.flatMap((c) => c.actions.flatMap((a) => Object.values(a.tools))),
  );
  const groups = new Map<string, CatalogGroup>();
  for (const spec of specs) {
    if (!isOfferedAction(spec) || merged.has(spec.id)) continue;
    const owner = actionOwner(spec, connectorIds);
    const key = `${owner.type}:${owner.id}`;
    const group = groups.get(key) ?? {
      ...owner,
      name: (owner.type === "connector" ? names.connectors : names.areas)[owner.id] ?? owner.id,
      actions: [],
    };
    group.actions.push({
      id: spec.id,
      label: label(spec),
      description: spec.description,
      kind: actionKind(spec),
      input: fieldsFromSchema(spec.input),
      output: fieldsFromSchema(spec.output),
    });
    groups.set(key, group);
  }
  for (const merged of MERGED_CONNECTORS) {
    const actions: CatalogAction[] = [];
    for (const a of merged.actions) {
      const first = Object.values(a.tools)
        .map((t) => byId.get(t))
        .find((s) => s !== undefined);
      if (!first) continue;
      actions.push({
        id: a.id,
        label: a.label,
        description: first.description,
        kind: actionKind(first),
        input: fieldsFromSchema(first.input),
        output: fieldsFromSchema(first.output),
      });
    }
    if (actions.length > 0) {
      groups.set(`connector:${merged.id}`, {
        type: "connector",
        id: merged.id,
        name: merged.name,
        actions,
      });
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "connector" ? -1 : 1,
  );
}
