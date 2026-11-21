// v0.18 (owner, 2026-11-15; docs/plan.md §1.103): what each step reads and saves, in words, and
// what is left before a draft can go live. Core's `stepDataUse` says what a step's tools do with
// data (ARCHITECTURE §12.0 `ToolSpec.area` and `entity`); this file words it ("Reads vendors
// (filled by QuickBooks, uploads, invoices or the directory)", "Saves items (Purchasing)", "Changes bills in
// QuickBooks Online", "Saves nothing; kept in this run only"), warns when the client lacks what a
// step needs, sums it up for the agent, and lists what's left: missing steps, connections and packs
// the client lacks, and a test run. Problems come from the validator (./problems.ts words them).

import {
  type AnyAgentBundle,
  type ProcessAgentBundle,
  processes,
  SHARED_AREA,
} from "@countersign/core";

type Step = processes.Step;
type DataTouch = processes.DataTouch;
type StepDataUse = processes.StepDataUse;

/** Names for what the words mention: connectors and packs by id. */
export interface DataNames {
  connector(id: string): string;
  pack(id: string): string;
}

/** What the client has, for warnings and what's left. Null for a template (no client). */
export interface ClientSetup {
  name: string;
  /** Connectors with a connection that isn't disconnected. */
  connected: ReadonlySet<string>;
  /** Connectors this agent is bound to (a client agent reaches only these, invariant 13). */
  bound: ReadonlySet<string>;
  /** The packs there are for the client, by id, and whether each is on; null while unknown. */
  packs: ReadonlyMap<string, boolean> | null;
}

// DECISION (v0.18): record types are worded here, in the builder's words, rather than declared on
// each tool: the entity ids are few and shared (`vendor`, `bill`), and a new one reads as its id.
const ENTITY_WORDS: Readonly<Record<string, string>> = {
  vendor: "vendors",
  document: "documents",
  transaction: "transactions",
  contact: "contacts",
  ledger_account: "accounts",
  catalog_item: "items",
  vendor_item: "vendor items",
  contract: "contracts",
  item_match: "item matches",
  price: "prices",
  alert: "alerts",
  purchase_request: "purchase requests",
  quote: "quotes",
  booking: "bookings",
  reconciliation: "reconciliations",
  // §1.164: the Sales area's synced CRM records and the rows matched to them.
  crm_record: "CRM records",
  crm_match: "record matches",
  bill: "bills",
  purchase: "purchases",
  purchase_order: "purchase orders",
  invoice: "invoices",
  customer: "customers",
  payment: "payments",
  item: "items",
  attachment: "attachments",
  account: "accounts",
  class: "classes",
  location: "locations",
  deposit: "deposits",
  transfer: "transfers",
  message: "messages",
};

/** Where a shared record comes from, so a read says what it depends on. */
// DECISION (v0.18): what fills each shared record (ARCHITECTURE §5.2, §12.0) is written here once;
// the sources are the platform's and change rarely.
export const SHARED_FILLED_BY: Readonly<Record<string, string>> = {
  vendor: "filled by QuickBooks, uploads, invoices or the directory",
  document: "filled by uploads, email forwarding or Gmail",
  transaction: "filled by the bank feed, QuickBooks or invoices",
  contact: "filled by the client's People list and the directory",
  ledger_account: "filled by QuickBooks",
  alert: "made by agents' checks",
};

const AREA_WORDS: Readonly<Record<string, string>> = {
  purchasing: "Purchasing",
  bookkeeping: "Bookkeeping",
  marketing: "Marketing",
  sales: "Sales",
  receivables: "Receivables",
};

export function entityWords(entity: string): string {
  return ENTITY_WORDS[entity] ?? `${entity.replace(/_/g, " ")}s`;
}

function areaWords(area: string): string {
  return AREA_WORDS[area] ?? area.charAt(0).toUpperCase() + area.slice(1).replace(/_/g, " ");
}

/**
 * The noun a touch is about: "bills in QuickBooks Online", "items (Purchasing)", "vendors (filled
 * by …)" (`long`) or "vendors". Null for a read that keeps to the run (a web search, an answer).
 */
export function touchNoun(t: DataTouch, names: DataNames, long = true): string | null {
  const what = t.entity ? entityWords(t.entity) : null;
  if (t.connector) {
    const where = names.connector(t.connector);
    return what ? `${what} in ${where}` : where;
  }
  if (t.area === SHARED_AREA) {
    if (!what) return "shared records";
    const by = SHARED_FILLED_BY[t.entity ?? ""];
    return long && by ? `${what} (${by})` : what;
  }
  if (t.area) return `${what ?? "records"} (${areaWords(t.area)})`;
  if (t.verb === "reads") return null;
  return what ?? "our records";
}

const VERB_WORD: Record<processes.DataVerb, string> = {
  reads: "Reads",
  saves: "Saves",
  changes: "Changes",
};

/** "Sends messages through Gmail": a message is sent, not changed. */
function touchLine(t: DataTouch, names: DataNames): string | null {
  const noun = touchNoun(t, names);
  if (noun === null) return null;
  if (t.verb === "changes" && t.entity === "message" && t.connector) {
    return `Sends messages through ${names.connector(t.connector)}`;
  }
  return `${VERB_WORD[t.verb]} ${noun}`;
}

/** The words "Saves nothing" takes: a step that only reads keeps what it reads in the run. */
export const KEEPS_NOTHING = "Saves nothing; kept in this run only";

/**
 * A step's data in lines, reads first: "Reads vendors (filled by …)", "Saves items (Purchasing)",
 * "Changes bills in QuickBooks Online", and "Saves nothing; kept in this run only" for a step that
 * only reads. Empty for a step that keeps no data of its own (people, logic, a missing step).
 */
export function stepDataLines(use: StepDataUse, names: DataNames): string[] {
  if (!use.applies || use.unknown !== undefined) return [];
  const order: processes.DataVerb[] = ["reads", "saves", "changes"];
  const lines: string[] = [];
  for (const verb of order) {
    // An action's candidate tools change the same record in different tools: one line.
    const touches = use.touches.filter((t) => t.verb === verb);
    const byEntity = new Map<string, DataTouch[]>();
    for (const t of touches) {
      const key = verb === "changes" && t.connector ? `${t.entity ?? ""}` : JSON.stringify(t);
      byEntity.set(key, [...(byEntity.get(key) ?? []), t]);
    }
    for (const group of byEntity.values()) {
      const first = group[0];
      if (!first) continue;
      let line = touchLine(first, names);
      if (line && group.length > 1) {
        const where = group.map((t) => names.connector(t.connector ?? "")).join(" or ");
        line = line.replace(names.connector(first.connector ?? ""), where);
      }
      if (line && !lines.includes(line)) lines.push(line);
    }
  }
  if (processes.keepsNothing(use)) lines.push(KEEPS_NOTHING);
  return lines;
}

/** What the client lacks for a step: a connection, this agent's binding, a pack that's off. */
export function stepDataWarnings(
  use: StepDataUse,
  client: ClientSetup | null,
  names: DataNames,
): string[] {
  if (!client) return [];
  const out: string[] = [];
  for (const c of use.connectors) {
    if (!client.connected.has(c))
      out.push(`${names.connector(c)} isn't connected for ${client.name}`);
    else if (!client.bound.has(c))
      out.push(`This agent has no ${names.connector(c)} connection chosen`);
  }
  for (const p of use.packs) {
    if (client.packs?.get(p) === false)
      out.push(`The ${names.pack(p)} pack is off for ${client.name}`);
  }
  return out;
}

/** Every v4 step of the bundle with its workflow's slug, in run order. */
function bundleSteps(bundle: ProcessAgentBundle | AnyAgentBundle): { slug: string; step: Step }[] {
  const out: { slug: string; step: Step }[] = [];
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion !== 4) continue;
    processes.walkSteps(w.workflow, ({ step }) => out.push({ slug: w.slug, step }));
  }
  return out;
}

/** The agent's data at a glance: what it reads, saves and changes, each once. */
export interface DataSummary {
  reads: string[];
  saves: string[];
  changes: string[];
}

export function agentDataSummary(
  bundle: ProcessAgentBundle | AnyAgentBundle,
  ctx: processes.DataUseContext,
  names: DataNames,
): DataSummary {
  const out: DataSummary = { reads: [], saves: [], changes: [] };
  for (const { step } of bundleSteps(bundle)) {
    for (const t of processes.stepDataUse(step, ctx).touches) {
      const noun = touchNoun(t, names, false);
      if (noun === null) continue;
      const list = out[t.verb];
      if (!list.includes(noun)) list.push(noun);
    }
  }
  return out;
}

// ── What's left ──────────────────────────────────────────────────────────────────────────────────

export type LeftItem =
  | { kind: "missing"; key: string; workflow: string; stepId: string; text: string }
  | {
      kind: "connection" | "pack";
      key: string;
      workflow: string;
      /** The first step that needs it: clicking the item selects it. */
      stepId: string;
      text: string;
    }
  | { kind: "test"; key: string; text: string };

const steps = (n: number) => (n === 1 ? "1 step needs it" : `${n} steps need it`);

/**
 * What's left on a draft beyond its problems, in the order to do it: each missing step, the
 * connections and packs the client lacks (each once, with how many steps need it), and a test run
 * when it hasn't had one since its last change (`tested` false; null when that isn't known).
 */
export function whatsLeft(input: {
  bundle: ProcessAgentBundle;
  ctx: processes.DataUseContext;
  client: ClientSetup | null;
  names: DataNames;
  tested: boolean | null;
}): LeftItem[] {
  const { client, names } = input;
  const missing: LeftItem[] = [];
  const needs = new Map<
    string,
    {
      kind: "connection" | "pack";
      id: string;
      first: { workflow: string; stepId: string };
      n: number;
      text: (n: number) => string;
    }
  >();
  for (const { slug, step } of bundleSteps(input.bundle)) {
    if (step.kind === "missing") {
      missing.push({
        kind: "missing",
        key: `missing:${slug}:${step.id}`,
        workflow: slug,
        stepId: step.id,
        text: `${step.name || "A step"}: ${step.need}`,
      });
      continue;
    }
    if (!client) continue;
    const use = processes.stepDataUse(step, input.ctx);
    const need = (kind: "connection" | "pack", id: string, text: (n: number) => string) => {
      const key = `${kind}:${id}`;
      const had = needs.get(key);
      if (had) had.n += 1;
      else needs.set(key, { kind, id, first: { workflow: slug, stepId: step.id }, n: 1, text });
    };
    for (const c of use.connectors) {
      const name = names.connector(c);
      if (!client.connected.has(c)) {
        need("connection", c, (n) => `Connect ${name} for ${client.name}: ${steps(n)}`);
      } else if (!client.bound.has(c)) {
        need("connection", c, (n) => `Choose this agent's ${name} connection: ${steps(n)}`);
      }
    }
    for (const p of use.packs) {
      if (client.packs?.get(p) === false) {
        need("pack", p, (n) => `Turn on the ${names.pack(p)} pack for ${client.name}: ${steps(n)}`);
      }
    }
  }
  const setup: LeftItem[] = [...needs.entries()].map(([key, v]) => ({
    kind: v.kind,
    key,
    workflow: v.first.workflow,
    stepId: v.first.stepId,
    text: v.text(v.n),
  }));
  const test: LeftItem[] =
    input.tested === false
      ? [
          {
            kind: "test",
            key: "test",
            text: "Test-run it: it hasn't had a test run since its last change",
          },
        ]
      : [];
  return [...missing, ...setup, ...test];
}

/** The connector a `connection_missing` problem names, so what's left lists it once. */
export function problemConnector(message: string): string | null {
  return /^no (\S+) connection is bound/.exec(message)?.[1] ?? null;
}
