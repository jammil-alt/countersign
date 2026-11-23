// The work order (docs/plan.md §1.124; docs/cases-plan.md §3.2): Build's three kinds in one
// order, with the reason each item is where it is. Critical issues first, always. Then high, normal
// and low issues before builds, unless a build would miss its promised date, in which case it goes
// first. Enhancements after builds, most-asked first. The operator can move anything. Pure.

import { houseDate } from "../timezone";
import type { WorkUrgency } from "./pipelines";

export type WorkOrderInput =
  | {
      kind: "issue";
      id: string;
      urgency: WorkUrgency;
      createdAt: string;
      /** ISO instant or date. */
      fixBy: string | null;
      manualRank: number | null;
    }
  | {
      kind: "build";
      id: string;
      /** ISO date. */
      promisedOn: string | null;
      openItems: number;
      manualRank: number | null;
    }
  | {
      kind: "enhancement";
      id: string;
      decision: "do" | "later" | "no" | "sell" | null;
      asks: number;
      decideBy: string | null;
      manualRank: number | null;
    };

export interface WorkOrderRow {
  kind: WorkOrderInput["kind"];
  id: string;
  rank: number;
  why: string;
  /** Moved ahead by the rule on promised dates ("Moved by Reggie"). */
  moved: boolean;
  /** Placed by the operator ("Moved by you"). */
  manual: boolean;
}

/** Days of work each open issue ahead of a build is taken to need. */
const ISSUE_DAYS: Readonly<Record<WorkUrgency, number>> = {
  critical: 0,
  high: 2,
  normal: 1,
  low: 2,
};
const URGENCY_ORDER: Readonly<Record<WorkUrgency, number>> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function addDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) + Math.ceil(days) * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type Issue = Extract<WorkOrderInput, { kind: "issue" }>;
type Build = Extract<WorkOrderInput, { kind: "build" }>;
type Enh = Extract<WorkOrderInput, { kind: "enhancement" }>;
type Placed = Omit<WorkOrderRow, "rank">;

/** The open items in order, ranked from 1. Enhancements decided `no` are left out. */
export function workOrder(items: readonly WorkOrderInput[], today: string): WorkOrderRow[] {
  const auto = items.filter((i) => i.manualRank === null);
  const issues = auto.filter((i): i is Issue => i.kind === "issue");
  const critical = issues
    .filter((i) => i.urgency === "critical")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const rest = issues
    .filter((i) => i.urgency !== "critical")
    .sort(
      (a, b) =>
        URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] ||
        (a.fixBy ?? "9999").localeCompare(b.fixBy ?? "9999") ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const builds = auto
    .filter((i): i is Build => i.kind === "build")
    .sort((a, b) => (a.promisedOn ?? "9999").localeCompare(b.promisedOn ?? "9999"));
  const enhancements = auto
    .filter((i): i is Enh => i.kind === "enhancement" && i.decision !== "no")
    .sort(
      (a, b) =>
        Number(a.decision === "later") - Number(b.decision === "later") ||
        b.asks - a.asks ||
        (a.decideBy ?? "9999").localeCompare(b.decideBy ?? "9999"),
    );

  const out: Placed[] = critical.map((i) => ({
    kind: "issue",
    id: i.id,
    why: "Critical: ahead of everything.",
    moved: false,
    manual: false,
  }));

  // A dated build that would miss its promised date after every issue goes ahead of the normal and
  // low issues (high issues stay ahead of it: they are the ones the rule keeps first).
  const allIssueDays = rest.reduce((n, i) => n + ISSUE_DAYS[i.urgency], 0);
  const movedUp = new Map<string, string>();
  let buildDays = 0;
  for (const b of builds) {
    const own = Math.max(1, b.openItems * 0.5);
    buildDays += own;
    if (!b.promisedOn) continue;
    const lands = addDays(today, allIssueDays + buildDays);
    if (lands > b.promisedOn) {
      movedUp.set(
        b.id,
        `Moved up: after the normal issues it would land ${houseDate(lands)}, past the promised ${houseDate(b.promisedOn)}.`,
      );
    }
  }
  const high = rest.filter((i) => i.urgency === "high");
  const lower = rest.filter((i) => i.urgency !== "high");
  for (const i of high) {
    out.push({
      kind: "issue",
      id: i.id,
      why: "High issues go before builds.",
      moved: false,
      manual: false,
    });
  }
  for (const b of builds) {
    const why = movedUp.get(b.id);
    if (why) out.push({ kind: "build", id: b.id, why, moved: true, manual: false });
  }
  for (const i of lower) {
    const late = !!i.fixBy && i.fixBy.slice(0, 10) < today;
    const word = i.urgency === "normal" ? "Normal" : "Low";
    const why = late
      ? `Late: a ${i.urgency} issue.`
      : `${word}: no promised date is at risk after it.`;
    out.push({ kind: "issue", id: i.id, why, moved: false, manual: false });
  }
  for (const b of builds) {
    if (movedUp.has(b.id)) continue;
    out.push({
      kind: "build",
      id: b.id,
      why: b.promisedOn ? "On track." : "No date yet: after dated builds.",
      moved: false,
      manual: false,
    });
  }
  enhancements.forEach((e, n) => {
    const why =
      e.decision === "later"
        ? "Decided later."
        : n === 0
          ? `Enhancements after builds, most-asked first: ${plural(e.asks, "client")}.`
          : `${plural(e.asks, "client")}.`;
    out.push({ kind: "enhancement", id: e.id, why, moved: false, manual: false });
  });

  // The operator's moves: each at its position, in the order of their positions.
  const manual = items
    .filter((i) => i.manualRank !== null && !(i.kind === "enhancement" && i.decision === "no"))
    .sort((a, b) => (a.manualRank ?? 0) - (b.manualRank ?? 0));
  for (const m of manual) {
    const at = Math.min(Math.max((m.manualRank ?? 1) - 1, 0), out.length);
    out.splice(at, 0, { kind: m.kind, id: m.id, why: "Moved by you.", moved: false, manual: true });
  }
  return out.map((row, n) => ({ ...row, rank: n + 1 }));
}
