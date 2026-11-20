// A build's issues (owner, 2026-11-17): everything left to settle, in one list with stable keys, so
// the operator and the Builder can talk about one at a time, come back to it later, and agree the
// change that settles it. Open items are stored; the draft's problems, failing test cases, the
// client's rejected writes and failing QA checks are read live from the build, as the build shows
// them. Each message in the conversation may name the issue it is about (`about`): that is the
// issue's thread, which is how "go back to it" works however long ago it was.

import type { BuildDetail } from "../api/build";
import {
  type BuildItemOwner,
  type BuildPhase,
  DECISION_KIND_WORDS,
  DECISION_STATUS_WORDS,
  type Decision,
  decisionUnreviewed,
  ITEM_STATE_WORDS,
  itemOpen,
} from "./build";

export const ISSUE_SOURCES = ["item", "problem", "case", "rejection", "check", "decision"] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

export const ISSUE_SOURCE_WORDS: Record<IssueSource, string> = {
  item: "Open item",
  problem: "Draft problem",
  case: "Failing test",
  rejection: "Rejected by the client",
  check: "QA check",
  decision: "Decision",
};

export interface BuildIssue {
  /**
   * Stable across turns: `item:<id>`, `problem:<key>`, `case:<id>`, `rejection:<id>`, `check:<id>`,
   * `decision:<id>`.
   */
  key: string;
  source: IssueSource;
  title: string;
  detail: string;
  /** The phase it came from. */
  phase: BuildPhase;
  /** Still to settle. A settled item stays in the list, so it can be gone back to and reopened. */
  open: boolean;
  /** It holds the build's next move. */
  blocking: boolean;
  /** Its state in words: Open, Done, Put off, Fails, Accepted… */
  state: string;
  owner: BuildItemOwner | null;
  itemId: string | null;
  /** Messages about it: its thread. */
  talk: number;
  /** The Dev queue request it waits on (docs/plan.md §1.125): "Waiting on DQ-012". */
  waitingOn: { id: string; ref: string } | null;
}

const SOURCE_ORDER: Record<IssueSource, number> = {
  problem: 0,
  case: 1,
  check: 2,
  decision: 3,
  rejection: 4,
  item: 5,
};

/** The build's issues: open ones first, the ones holding the next move first among them. */
export function buildIssues(d: BuildDetail): BuildIssue[] {
  const talk = new Map<string, number>();
  for (const m of d.messages) if (m.about) talk.set(m.about, (talk.get(m.about) ?? 0) + 1);
  const t = (key: string) => talk.get(key) ?? 0;
  const out: BuildIssue[] = [];
  const phase = d.build.phase;
  // What holds the next move, from the same facts as the gate (`gateReasons`, BUILDER_QA CONS-1):
  // open items hold only the go-live (QA), draft problems only the move out of the draft.
  const itemsHold = phase === "qa";
  const problemsHold = phase === "draft";

  // A missing step whose part is in the Dev queue waits on its request.
  const waitingByStep = new Map<string, { id: string; ref: string }>();
  for (const i of d.items) {
    const w = waitingOf(i.ref);
    if (w && i.stepId && itemOpen(i.state)) waitingByStep.set(i.stepId, w);
  }
  for (const p of d.draft?.problems ?? []) {
    const where = [p.stepName ?? p.stepId, p.workflowName ?? p.workflow].filter(Boolean);
    const key = `problem:${p.key}`;
    const waiting = p.stepId ? (waitingByStep.get(p.stepId) ?? null) : null;
    const place = where.length > 0 ? `In ${where.map((w) => `“${w}”`).join(" of ")}` : "";
    out.push({
      key,
      source: "problem",
      title: p.title,
      detail: waiting ? [place, `Waiting on ${waiting.ref}`].filter(Boolean).join(". ") : place,
      phase: "draft",
      open: true,
      blocking: problemsHold,
      state: "Open",
      owner: null,
      itemId: null,
      talk: t(key),
      waitingOn: waiting,
    });
  }
  const itemFor = (ref: "testCaseId" | "actionId", id: string) =>
    d.items.some((i) => i.ref[ref] === id);
  for (const f of d.poc?.failures ?? []) {
    if (itemFor("testCaseId", f.caseId)) continue;
    const key = `case:${f.caseId}`;
    out.push({
      key,
      source: "case",
      title: `Test case fails: ${f.name}`,
      detail: `Its latest run: ${f.status}`,
      phase: "poc",
      open: true,
      blocking: phase === "poc",
      state: "Fails",
      owner: null,
      itemId: null,
      talk: t(key),
      waitingOn: null,
    });
  }
  // The checklist is read in every phase, but it is QA's: before QA every check "fails".
  for (const c of phase === "qa" ? d.qaChecks : []) {
    if (c.state !== "fail" && c.state !== "accepted") continue;
    const key = `check:${c.id}`;
    out.push({
      key,
      source: "check",
      title: c.label,
      detail: c.state === "accepted" ? `Accepted: ${c.reason ?? ""}` : c.detail,
      phase: "qa",
      open: c.state === "fail",
      blocking: c.state === "fail",
      state: c.state === "fail" ? "Fails" : "Accepted",
      owner: null,
      itemId: null,
      talk: t(key),
      waitingOn: null,
    });
  }
  // docs/builder-plan.md §4.2: a high-risk decision nobody has looked at holds the POC's move on.
  for (const dec of d.build.fitgap?.decisions ?? []) {
    if (decisionUnreviewed(dec)) out.push(decisionIssue(d, dec, t(`decision:${dec.id}`)));
  }
  for (const r of d.clientTest?.rejections ?? []) {
    if (itemFor("actionId", r.actionId)) continue;
    const key = `rejection:${r.actionId}`;
    out.push({
      key,
      source: "rejection",
      title: `The client rejected a write: ${r.tool}`,
      detail: r.reason ? `Their reason: ${r.reason}` : "They gave no reason",
      phase: "client_test",
      open: true,
      blocking: false,
      state: "Open",
      owner: null,
      itemId: null,
      talk: t(key),
      waitingOn: null,
    });
  }
  for (const i of d.items) {
    const key = `item:${i.id}`;
    const open = itemOpen(i.state);
    const waiting = waitingOf(i.ref);
    out.push({
      key,
      source: "item",
      title: i.title,
      detail: i.detail,
      phase: i.phase,
      open,
      blocking: open && itemsHold,
      state: waiting && open ? `Waiting on ${waiting.ref}` : ITEM_STATE_WORDS[i.state],
      owner: i.owner,
      itemId: i.id,
      talk: t(key),
      waitingOn: waiting,
    });
  }
  return out
    .map((issue, at) => ({ issue, at }))
    .sort(
      (a, b) =>
        Number(b.issue.open) - Number(a.issue.open) ||
        Number(b.issue.blocking) - Number(a.issue.blocking) ||
        SOURCE_ORDER[a.issue.source] - SOURCE_ORDER[b.issue.source] ||
        a.at - b.at,
    )
    .map(({ issue }) => issue);
}

/** A decision as an issue: the conversation can be on any decision ("Ask about it"). */
export function decisionIssue(d: BuildDetail, dec: Decision, talk = 0): BuildIssue {
  const open = decisionUnreviewed(dec);
  return {
    key: `decision:${dec.id}`,
    source: "decision",
    title: dec.what,
    detail: [
      dec.risk === "high" ? `High risk, ${DECISION_KIND_WORDS[dec.kind].toLowerCase()}` : null,
      dec.risk === "high" ? null : DECISION_KIND_WORDS[dec.kind],
      dec.value ? `Starts at ${dec.value}` : null,
      dec.why || null,
    ]
      .filter(Boolean)
      .join(". "),
    phase: "fitgap",
    open,
    blocking: open && d.build.phase === "poc",
    state: DECISION_STATUS_WORDS[dec.status],
    owner: null,
    itemId: null,
    talk,
    waitingOn: null,
  };
}

/**
 * The issue with this key: one of the build's issues, or any of its decisions (a decision that
 * isn't an issue, being normal risk or looked at, can still be asked about).
 */
export function issueByKey(
  d: BuildDetail,
  key: string,
  issues: readonly BuildIssue[] = buildIssues(d),
): BuildIssue | null {
  const found = issues.find((i) => i.key === key);
  if (found) return found;
  const id = /^decision:(.+)$/.exec(key)?.[1];
  const dec = id ? (d.build.fitgap?.decisions ?? []).find((x) => x.id === id) : undefined;
  if (!dec) return null;
  const talk = d.messages.filter((m) => m.about === key).length;
  return decisionIssue(d, dec, talk);
}

/** The request an item's ref names, if any. */
function waitingOf(ref: {
  codeRequestId?: string | undefined;
  codeRequestRef?: string | undefined;
}) {
  return ref.codeRequestId && ref.codeRequestRef
    ? { id: ref.codeRequestId, ref: ref.codeRequestRef }
    : null;
}

/** One line per issue, for the Builder: its key first, so it can name the one it is about. */
export function issueLine(i: BuildIssue): string {
  const who = i.owner ? `, ${i.owner}` : "";
  const hold = i.blocking ? ", holds the next move" : "";
  const said = i.talk > 0 ? `, ${i.talk} messages about it` : "";
  return `[${i.key}] ${ISSUE_SOURCE_WORDS[i.source]} (${i.state}${who}${hold}${said}): ${i.title}${i.detail ? `. ${i.detail}` : ""}`;
}
