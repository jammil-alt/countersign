// Sales (docs/cases-plan.md S1–S2, docs/plan.md §1.124.2): deals for new accounts and for more
// from a client, as the agreed prototype has them (docs/design/pipelines.html: PIPES, salesKpis,
// salesTable). Pure: the stages and their likelihood, where a deal stands, what is late, the
// Sales KPIs and the words. Money is a decimal string (invariant 6), summed with decimal.js.

import { z } from "zod";
import { Decimal, dec, toNumeric } from "../money";

import { addDays } from "../weekly/week";
import { SALES_TABS } from "./pipelines";

/** A date plus N days (the check-back date). */
export const dealCheckBackOn = (today: string, days: number): string => addDays(today, days);

export const DEAL_KIND_VALUES = ["new", "expansion"] as const;
export const DealKind = z.enum(DEAL_KIND_VALUES);
export type DealKind = z.infer<typeof DealKind>;

export const NEW_DEAL_STAGES = [
  "lead",
  "qualified",
  "diagnostic",
  "proposal",
  "setup",
  "live",
] as const;
export const EXPANSION_DEAL_STAGES = ["spotted", "pitch", "offered", "agreed", "billed"] as const;
export const DealStage = z.enum([...NEW_DEAL_STAGES, ...EXPANSION_DEAL_STAGES]);
export type DealStage = z.infer<typeof DealStage>;

export const DEAL_OUTCOME_VALUES = ["open", "won", "lost", "not_now", "no"] as const;
export const DealOutcome = z.enum(DEAL_OUTCOME_VALUES);
export type DealOutcome = z.infer<typeof DealOutcome>;

export const DEAL_SOURCE_VALUES = ["site_form", "email", "referral", "ops", "reggie"] as const;
export const DealSource = z.enum(DEAL_SOURCE_VALUES);
export type DealSource = z.infer<typeof DealSource>;

export const DEAL_WAITING_ON = ["operator", "reggie", "client"] as const;
export const DealWaitingOn = z.enum(DEAL_WAITING_ON);
export type DealWaitingOn = z.infer<typeof DealWaitingOn>;

/** The Sales section's tabs: the one list across both pipelines, then each (`SALES_TABS`, ./pipelines). */
export const SalesTab = z.enum(SALES_TABS);
export type SalesTab = z.infer<typeof SalesTab>;
export const SALES_TAB_WORDS: Record<SalesTab, string> = {
  all: "All deals",
  new: "New accounts",
  grow: "Expansion",
};

/** A pipeline's tab id for a deal's kind. */
export const salesPipeOf = (kind: DealKind): "new" | "grow" => (kind === "new" ? "new" : "grow");
export const dealKindOf = (pipe: "new" | "grow"): DealKind =>
  pipe === "new" ? "new" : "expansion";

export interface SalesStage {
  id: DealStage;
  name: string;
  /** How likely a deal at this stage is to close, as a decimal string (the prototype's `p`). */
  p: string;
  /** What Reggie does at this stage (the board column's line). */
  auto: string;
}

export interface SalesPipeline {
  name: string;
  short: string;
  stages: readonly SalesStage[];
}

/** The prototype's PIPES for Sales, word for word. */
export const SALES_PIPELINES: Record<"new" | "grow", SalesPipeline> = {
  new: {
    name: "New accounts",
    short: "New",
    stages: [
      {
        id: "lead",
        name: "Lead",
        p: "0.1",
        auto: "Reggie reads their site and drafts the first reply.",
      },
      {
        id: "qualified",
        name: "Qualified",
        p: "0.25",
        auto: "Reggie scores the fit and books the diagnostic.",
      },
      {
        id: "diagnostic",
        name: "Diagnostic",
        p: "0.4",
        auto: "Reggie prepares the call and writes up the plan.",
      },
      {
        id: "proposal",
        name: "Proposal and contract",
        p: "0.6",
        auto: "Reggie drafts the proposal; you send the contract and add the signed copy.",
      },
      {
        id: "setup",
        name: "Set up the account",
        p: "0.9",
        auto: "Reggie sets up the client and opens a build per agent sold.",
      },
      {
        id: "live",
        name: "First agent live",
        p: "1",
        auto: "Reggie sends the first Weekly Table.",
      },
    ],
  },
  grow: {
    name: "Expansion",
    short: "Expansion",
    stages: [
      {
        id: "spotted",
        name: "Spotted",
        p: "0.2",
        auto: "Reggie watches every live client nightly and opens these with evidence.",
      },
      { id: "pitch", name: "Pitch", p: "0.4", auto: "Reggie drafts the pitch in their numbers." },
      {
        id: "offered",
        name: "Offered",
        p: "0.6",
        auto: "You agree the terms and record them. Reggie nudges after 5 days.",
      },
      { id: "agreed", name: "Agreed", p: "0.9", auto: "Reggie opens the agent builds." },
      {
        id: "billed",
        name: "Live and billed",
        p: "1",
        auto: "Reggie puts the new price on the bill from go-live.",
      },
    ],
  },
};

export function dealStages(kind: DealKind): readonly SalesStage[] {
  return SALES_PIPELINES[salesPipeOf(kind)].stages;
}

/** Whether a stage belongs to a kind's pipeline (the database checks the same). */
export function isDealStage(kind: DealKind, stage: string): stage is DealStage {
  return dealStages(kind).some((s) => s.id === stage);
}

export function dealStageOf(kind: DealKind, stage: DealStage): SalesStage {
  const found = dealStages(kind).find((s) => s.id === stage);
  if (!found) throw new RangeError(`${stage} is not a ${kind} deal's stage`);
  return found;
}

export const firstDealStage = (kind: DealKind): DealStage => dealStages(kind)[0]?.id as DealStage;
export const lastDealStage = (kind: DealKind): DealStage =>
  dealStages(kind).at(-1)?.id as DealStage;

/** The stage's index in its pipeline (for sorting and the stepper). */
export const dealStageIndex = (kind: DealKind, stage: DealStage): number =>
  dealStages(kind).findIndex((s) => s.id === stage);

/** A month's value weighted by how likely its stage is to close (the prototype's `weighted`). */
export function weightedMrr(kind: DealKind, stage: DealStage, mrr: string): string {
  return toNumeric(dec(mrr).times(dealStageOf(kind, stage).p));
}

/**
 * A renewal keeps the price it has: shown without "+" (the prototype's rule).
 */
// DECISION: a renewal is an expansion deal whose title starts "Renewal", as the prototype reads it;
// no column of its own until the owner asks for one.
export const isRenewal = (d: { kind: DealKind; title: string }): boolean =>
  d.kind === "expansion" && /^renewal\b/i.test(d.title.trim());

// ── Stages are a record, not a gate (docs/cases-plan.md §3.1) ─────────────────────────────────

/**
 * The stages a move passes over: those strictly between `from` and `to` when moving forward
 * (empty when moving back or one step on). Each shows on the timeline as skipped, with who and why.
 */
export function skippedStages(kind: DealKind, from: DealStage, to: DealStage): DealStage[] {
  const a = dealStageIndex(kind, from);
  const b = dealStageIndex(kind, to);
  if (a < 0 || b < 0 || b <= a + 1) return [];
  return dealStages(kind)
    .slice(a + 1, b)
    .map((s) => s.id);
}

/** The stages before `stage` (a deal opened there skipped all of them). */
export function stagesBefore(kind: DealKind, stage: DealStage): DealStage[] {
  const at = dealStageIndex(kind, stage);
  return at <= 0
    ? []
    : dealStages(kind)
        .slice(0, at)
        .map((s) => s.id);
}

/** Why a stage was skipped when the operator gave no reason. */
export const SIGNED_UP_DIRECTLY = "signed up directly";

/**
 * What a later stage wants that may not have been given: the agreed price, the signed copy, what
 * we're starting with. Each missing one becomes a to-do on Your call, never a block.
 */
export const DEAL_WANTS = ["price", "signed_copy", "start"] as const;
export type DealWant = (typeof DEAL_WANTS)[number];

/** Days until a missing item's to-do is due. */
export const DEAL_WANT_DUE_DAYS = 7;

export const DEAL_WANT_WORDS: Record<DealWant, (who: string) => string> = {
  price: (who) => `Record ${who}'s agreed price`,
  signed_copy: (who) => `Attach ${who}'s signed contract`,
  start: (who) => `What are we starting with for ${who}?`,
};

/**
 * What a deal at its stage wants and hasn't got. A new account from Set up the account on wants
 * the agreed price and the signed copy (Proposal and contract's); an expansion from Agreed on wants
 * the agreed price. `start` only when the caller knows nothing was chosen ("Just the account").
 */
// DECISION: an expansion asks for no signed copy: contracts are by hand, and the first one covers
// the account; the owner can add it when expansions get their own paper.
export function dealWants(d: {
  kind: DealKind;
  stage: DealStage;
  agreedMrr: string | null;
  hasSignedCopy: boolean;
  nothingChosen?: boolean;
}): DealWant[] {
  const out: DealWant[] = [];
  const at = dealStageIndex(d.kind, d.stage);
  const from = dealStageIndex(d.kind, d.kind === "new" ? "setup" : "agreed");
  if (at >= from) {
    if (d.agreedMrr === null) out.push("price");
    if (d.kind === "new" && !d.hasSignedCopy) out.push("signed_copy");
  }
  if (d.nothingChosen) out.push("start");
  return out;
}

// ── Where a deal stands ─────────────────────────────────────────────────────────────────────────

export const DEAL_STANDINGS = ["you", "agent", "client", "stalled", "done"] as const;
export const DealStanding = z.enum(DEAL_STANDINGS);
export type DealStanding = z.infer<typeof DealStanding>;

/** The prototype's `st`: done once closed, stalled when stuck or held, else whoever has it. */
export function dealStanding(d: {
  outcome: DealOutcome;
  waitingOn: DealWaitingOn;
  stuck: boolean;
  held: boolean;
}): DealStanding {
  if (d.outcome !== "open") return "done";
  if (d.held || d.stuck) return "stalled";
  if (d.waitingOn === "operator") return "you";
  if (d.waitingOn === "reggie") return "agent";
  return "client";
}

export const DEAL_OUTCOME_WORDS: Record<Exclude<DealOutcome, "open">, string> = {
  won: "Won",
  lost: "Lost",
  not_now: "Not now",
  no: "Said no",
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 3" for a date (YYYY-MM-DD, or an ISO time read as its UTC day). */
export function shortDay(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${MON[Number(m) - 1] ?? ""} ${Number(d)}`;
}

/** The words beside a deal's standing when its status line is empty. */
export function dealStatusText(d: {
  standing: DealStanding;
  statusLine: string;
  held: { reason: string } | null;
  outcome: DealOutcome;
  wonAt: string | null;
  closedAt: string | null;
}): string {
  if (d.standing === "done") {
    if (d.outcome === "won") return d.wonAt ? `Won ${shortDay(d.wonAt)}` : "Won";
    const word = DEAL_OUTCOME_WORDS[d.outcome as Exclude<DealOutcome, "open">] ?? "Closed";
    return d.closedAt ? `${word} ${shortDay(d.closedAt)}` : word;
  }
  if (d.held) return d.held.reason;
  if (d.statusLine.trim()) return d.statusLine.trim();
  switch (d.standing) {
    case "you":
      return "Your move";
    case "agent":
      return "Reggie on it";
    case "client":
      return "Waiting on them";
    default:
      return "Stuck";
  }
}

/** Days from `today` to `iso` (both dates); negative when past. */
export function daysFrom(today: string, iso: string): number {
  return Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(today.slice(0, 10))) / 86_400_000);
}

/** Late: an open deal whose next step was due before today. */
export const dealIsLate = (
  d: { nextDueOn: string | null; standing: DealStanding },
  today: string,
): boolean => d.nextDueOn !== null && d.standing !== "done" && daysFrom(today, d.nextDueOn) < 0;

/** The list's filters (the prototype's FILTERS; "Critical and high" is for issues only). */
export const DEAL_FILTERS = ["open", "you", "agent", "client", "stuck", "late", "done"] as const;
export type DealFilter = (typeof DEAL_FILTERS)[number];
export const DEAL_FILTER_WORDS: Record<DealFilter, string> = {
  open: "Open",
  you: "Needs you",
  agent: "Reggie on it",
  client: "Waiting on the client",
  stuck: "Stuck or held",
  late: "Late",
  done: "Done",
};

export function dealPasses(
  filter: DealFilter,
  d: { standing: DealStanding; nextDueOn: string | null },
  today: string,
): boolean {
  switch (filter) {
    case "open":
      return d.standing !== "done";
    case "you":
      return d.standing === "you";
    case "agent":
      return d.standing === "agent";
    case "client":
      return d.standing === "client";
    case "stuck":
      return d.standing === "stalled";
    case "late":
      return dealIsLate(d, today);
    default:
      return d.standing === "done";
  }
}

// ── Outcomes ────────────────────────────────────────────────────────────────────────────────────

/** When Reggie checks back after a deal closes without a sale (cases-plan S1). */
export const DEAL_CHECK_BACK_DAYS: Partial<Record<DealOutcome, number>> = { lost: 90, not_now: 60 };

// ── KPIs ────────────────────────────────────────────────────────────────────────────────────────

/** The figures over the Sales lists (the prototype's `salesKpis` and status line). */
export interface SalesFigures {
  /** Open deals' value a month, and weighted by stage. */
  potential: string;
  weighted: string;
  open: number;
  openNew: number;
  openExpansion: number;
  /** Agents sold or offered, not live. */
  agentsInPlay: number;
  needYou: number;
  /** Late, or stuck or held. */
  lateOrStuck: number;
  late: number;
  /** Won since the month began: their value a month, and how many. */
  wonThisMonth: string;
  wonCount: number;
}

export interface SalesFigureInput {
  kind: DealKind;
  stage: DealStage;
  mrr: string;
  agreedMrr: string | null;
  agentCount: number;
  standing: DealStanding;
  outcome: DealOutcome;
  nextDueOn: string | null;
  wonAt: string | null;
}

/**
 * The Sales figures for a set of deals. `today` is a date; "this month" is its calendar month.
 */
// DECISION: a won deal counts at its agreed value a month when terms were recorded, else its
// estimate. Every deal is USD today; the figures add amounts as they are (one currency).
export function salesFigures(deals: readonly SalesFigureInput[], today: string): SalesFigures {
  const open = deals.filter((d) => d.standing !== "done");
  const month = today.slice(0, 7);
  const won = deals.filter((d) => d.outcome === "won" && d.wonAt?.slice(0, 7) === month);
  const sum = (xs: readonly string[]) => xs.reduce((n, x) => n.plus(x), new Decimal(0));
  return {
    potential: toNumeric(sum(open.map((d) => d.mrr))),
    weighted: toNumeric(sum(open.map((d) => weightedMrr(d.kind, d.stage, d.mrr)))),
    open: open.length,
    openNew: open.filter((d) => d.kind === "new").length,
    openExpansion: open.filter((d) => d.kind === "expansion").length,
    agentsInPlay: open.reduce((n, d) => n + d.agentCount, 0),
    needYou: open.filter((d) => d.standing === "you").length,
    lateOrStuck: open.filter((d) => dealIsLate(d, today) || d.standing === "stalled").length,
    late: open.filter((d) => dealIsLate(d, today)).length,
    wonThisMonth: toNumeric(sum(won.map((d) => d.agreedMrr ?? d.mrr))),
    wonCount: won.length,
  };
}

/** Whole dollars with separators, as the prototype shows money ("$2,400"). */
export function wholeMoney(amount: string, currency = "USD"): string {
  const n = dec(amount).toDecimalPlaces(0).toFixed(0);
  const grouped = n.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = grouped.startsWith("-") ? "-" : "";
  const digits = grouped.replace(/^-/, "");
  return currency === "USD" ? `${sign}$${digits}` : `${sign}${digits} ${currency}`;
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

export const SALES_WORDS = {
  title: "Sales",
  subtitle:
    "New accounts and expansion in one place. Reggie keeps every deal moving; prices and terms are yours.",
  newDeal: "New deal",
  autopilot: "Autopilot",
  empty: "Nothing matches.",
  clear: "Clear the search and filters",
  noDeals: "No deals yet. Add the first one with New deal.",
  termsHead: "Terms",
  termsByHand: "By hand for now",
  termsLater: "Later: posted to the client's Billing page for them to agree.",
  recordTerms: "Record agreed terms",
  setUp: "Set up the account",
  openBuilds: "Open the builds",
} as const;
