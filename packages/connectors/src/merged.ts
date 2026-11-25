// The three merged connectors, resolved per client (docs/step-model-plan.md §10c; owner,
// 2026-11-25): **Email** (Resend, Gmail, Outlook), **Team chat** (Slack, Teams, Google Chat) and
// **Spreadsheets** (Google Sheets, Excel). The catalog (`steps.MERGED_CONNECTORS`) says which tool
// each connector runs an action with; this module says how the action's one input and output map onto
// that tool's own, so a template written once ("Team chat › Post a message") runs on whichever the
// client connected.
//
// The action's shape is its first connector's (the catalog shows that one): Email's three tools
// already share one input and output; Team chat is Slack's `{ channel, text }`; Spreadsheets is
// Google Sheets' `spreadsheetId`. Only the names that differ are mapped, and only keys: values,
// limits and approvals stay each tool's own. The gate does not move: the call still runs as the
// tool it resolves to, against the client's connection to that connector, with that tool's verb,
// entity, approval and before state (invariant 8).
//
// Pure: no connection, no storage, no secrets. The executor (`packages/workflows`) calls it.

import { steps } from "@countersign/core";

type Obj = Record<string, unknown>;

/** Renames keys: `{ from: to }`. Keys not named pass through, and a missing key stays missing. */
function rename(value: unknown, map: Readonly<Record<string, string>>): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value as Obj)) out[map[k] ?? k] = v;
  return out;
}

/** How one connector's tool differs from the action's shape: key renames, in and out. */
interface Mapping {
  /** The action's input key → the tool's. */
  input?: Readonly<Record<string, string>>;
  /** The tool's output key → the action's. */
  output?: Readonly<Record<string, string>>;
  /** Fills the action's output keys the tool names differently or not at all. */
  finish?(out: Obj): Obj;
}

// DECISION: the mappings are by merged action id and connector, here and not in the connectors, so a
// connector's own tool keeps its own, truthful names (Teams has a "channel", Google Chat a "space",
// Excel a "workbook") and the merge is the one place that says they are the same thing.
const MAPPINGS: Readonly<Record<string, Readonly<Record<string, Mapping>>>> = {
  "teamchat.message.post": {
    slack: {},
    teams: {
      // Slack's output: { channel, channelName, ts, workspace }.
      output: { channelLabel: "channelName", team: "workspace" },
      finish: (o) => ({ ...o, ts: o.activityId ?? o.conversationId ?? "" }),
    },
    gchat: {
      input: { channel: "space" },
      output: { space: "channel", spaceLabel: "channelName" },
      finish: (o) => ({ ...o, ts: o.createTime ?? o.messageId ?? "", workspace: "" }),
    },
  },
  "spreadsheet.range.read": {
    gsheets: {},
    excel: {
      input: { spreadsheetId: "workbookId" },
      output: { workbookId: "spreadsheetId", workbook: "spreadsheet" },
    },
  },
  "spreadsheet.rows.append": {
    gsheets: {},
    excel: { input: { spreadsheetId: "workbookId" }, output: { workbookId: "spreadsheetId" } },
  },
  "spreadsheet.range.update": {
    gsheets: {},
    excel: { input: { spreadsheetId: "workbookId" }, output: { workbookId: "spreadsheetId" } },
  },
};

/** A merged action's call, resolved for one client: the tool to run and the input it takes. */
export interface ResolvedMergedCall {
  connector: string;
  tool: string;
  input: unknown;
}

/**
 * Resolves a merged action for a client with these connectors connected: the first of the action's
 * connectors the client has (the merge's order), its tool, and the action's input in that tool's
 * own words. `undefined` when the id isn't a merged action or the client has none of its connectors.
 */
export function resolveMergedCall(
  actionId: string,
  connected: readonly string[],
  input: unknown,
): ResolvedMergedCall | undefined {
  const action = steps.mergedAction(actionId);
  if (!action) return undefined;
  for (const [connector, tool] of Object.entries(action.tools)) {
    if (!connected.includes(connector)) continue;
    const mapping = MAPPINGS[actionId]?.[connector];
    return {
      connector,
      tool,
      input: mapping?.input ? rename(input, mapping.input) : input,
    };
  }
  return undefined;
}

/** A tool's output in the merged action's words, whichever connector ran it. */
export function mergedOutput(actionId: string, connector: string, output: unknown): unknown {
  const mapping = MAPPINGS[actionId]?.[connector];
  if (!mapping) return output;
  let out = mapping.output ? rename(output, mapping.output) : output;
  if (mapping.finish && out !== null && typeof out === "object") out = mapping.finish(out as Obj);
  return out;
}

/** The merged actions with a mapping, for the tests that check every tool still fits it. */
export const MAPPED_MERGED_ACTIONS: readonly string[] = Object.keys(MAPPINGS);
