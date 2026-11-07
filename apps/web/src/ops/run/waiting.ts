// What a run waits on, from what the run detail serves (its open inbox items): one reading for the
// run page's top block, its status chip, the Timeline's waiting step and the Changes tab, so they
// all say the same thing ("Waiting for approval · client admin").
// DECISION: derived here from the run's open items until the runs list's derived "Waiting for
// approval" state (UI cleanup stream A) serves who a run waits on; then this reads that instead.
import { age } from "./words";

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
  /** Who must act: "you", "client admin", "client's team", "a named person at the client". */
  who: string;
  /** "Waiting for approval · client admin". */
  line: string;
  /** When the oldest open item was raised. */
  since: string;
  /** "39 h", "3 days". */
  waited: string;
  /** The item to act on first: the operator's own when there is one, else the oldest. */
  item: I;
  /** Whether the operator may approve or reject it (the server decides). */
  mine: boolean;
  /** Every open item of the run. */
  items: I[];
}

/** Who an item waits on, in the back office's words. */
export function waitingOn(item: WaitingItem): string {
  if (item.resolvableByOperator) return "you";
  if (item.assigneeUserId) return "a named person at the client";
  switch (item.assigneeRole) {
    case "client_user":
      return "client's team";
    case "operator":
      return "us";
    default:
      return "client admin";
  }
}

/** "Waiting for approval" for a change or an approval; "Waiting for an answer" for a question. */
export function waitingWhat(kind: string): string {
  return kind === "external_action" || kind === "approval"
    ? "Waiting for approval"
    : "Waiting for an answer";
}

/** The run's wait, or null when nothing of it is open. */
export function runWaiting<I extends WaitingItem>(
  items: readonly I[],
  now: Date = new Date(),
): RunWait<I> | null {
  const open = items
    .filter((i) => i.status === "open")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const oldest = open[0];
  if (!oldest) return null;
  const item = open.find((i) => i.resolvableByOperator) ?? oldest;
  const what = waitingWhat(item.kind);
  const who = waitingOn(item);
  return {
    what,
    who,
    line: `${what} · ${who}`,
    since: oldest.createdAt,
    waited: age(oldest.createdAt, now),
    item,
    mine: item.resolvableByOperator,
    items: open,
  };
}
