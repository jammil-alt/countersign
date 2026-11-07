// What a run waits on, for the run page's top block, its status chip, the Timeline's waiting step
// and the Changes tab, so they all say the same thing ("Waiting for approval · client admin").
// One source of truth: who waits and since when come from the API's `run.waiting` (core's
// `runWaitOf`, packages/core/src/api/run-state.ts) and core's `waitOn`; this file only adds what
// the page needs to act: which open item to answer first and whether we may.
import { type NobodyToAct, type RunWait as ServerWait, waitOn } from "@countersign/core";
import { age, waitOnWords } from "./words";

export interface WaitingItem {
  id: string;
  kind: string;
  status: string;
  assigneeRole: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  resolvableByOperator: boolean;
}

export interface RunWait<I extends WaitingItem = WaitingItem> {
  /** "Waiting for approval", "Waiting for an answer". */
  what: string;
  /** Who must act: "you", "client admin", "client's team", a named person, "us". */
  who: string;
  /** "Waiting for approval · client admin". */
  line: string;
  /** When the run started waiting: the oldest open item. */
  since: string;
  /** "39 h", "3 days". */
  waited: string;
  /** The item to act on first: the operator's own when there is one, else the oldest. */
  item: I;
  /** Whether the operator may approve or reject it (the server decides). */
  mine: boolean;
  /** Every open item of the run. */
  items: I[];
  /** Why nobody can act on it, when that's so (from the API). */
  nobodyToAct: NobodyToAct | null;
}

/** Who an item waits on, in the back office's words ("you" when we may answer it). */
export function waitingOn(item: WaitingItem, person: string | null = null): string {
  if (item.resolvableByOperator) return "you";
  return waitOnWords({ on: waitOn(item), person });
}

/** "Waiting for approval" for a change or an approval; "Waiting for an answer" for a question. */
export function waitingWhat(kind: string): string {
  return kind === "external_action" || kind === "approval"
    ? "Waiting for approval"
    : "Waiting for an answer";
}

/**
 * The run's wait, or null when nothing of it is open. `server` is the run's `waiting` from the API:
 * when given, its time, named person and "nobody can act" are used.
 */
export function runWaiting<I extends WaitingItem>(
  items: readonly I[],
  server: ServerWait | null | undefined = null,
  now: Date = new Date(),
): RunWait<I> | null {
  const open = items
    .filter((i) => i.status === "open")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const oldest = open[0];
  if (!oldest) return null;
  const item = open.find((i) => i.resolvableByOperator) ?? oldest;
  const what = waitingWhat(item.kind);
  const who = waitingOn(item, item === oldest ? (server?.person ?? null) : null);
  const since = server?.since ?? oldest.createdAt;
  return {
    what,
    who,
    line: `${what} · ${who}`,
    since,
    waited: age(since, now),
    item,
    mine: item.resolvableByOperator,
    items: open,
    nobodyToAct: server?.nobodyToAct ?? null,
  };
}
