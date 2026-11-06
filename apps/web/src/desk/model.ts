// The Desk's pure rules for the screen (docs/ui-plan.md C3; ARCHITECTURE §11.1): which items read as
// one entry (a batch one step proposed), how the list is grouped by day, what each item asks of the
// person, and how a Desk action's answer updates what is on screen. The API decides everything;
// this only arranges what it sent.
import {
  type DeskItemState,
  isPlainObject,
  readWhyApproval,
  type WhyApproval,
} from "@countersign/core";
import type { ResponseOf } from "../api/client";
import type { apiRoutes } from "../api/routes";

export type DeskItem = ResponseOf<typeof apiRoutes.portalInbox>["items"][number];

/** One row on the Desk: an item, or the items one step proposed together (a batch). */
export interface DeskEntry {
  /** The item's id, or `batch:<batchKey>`. */
  key: string;
  items: DeskItem[];
}

/** The entry's first item: its agent, its run, its time. */
export function leadOf(entry: DeskEntry): DeskItem {
  return entry.items[0] as DeskItem;
}

export function isBatch(entry: DeskEntry): boolean {
  return entry.items.length > 1;
}

/**
 * Items in the API's order (newest first), with the open changes of one step's batch together as
 * one entry where the first of them was. A batch of one is a plain item.
 */
// DECISION: only open changes group: a batch is signed together (ARCHITECTURE §11.1 "sign part of a
// batch"), while what is done reads one line per change.
export function entriesOf(items: readonly DeskItem[]): DeskEntry[] {
  const groups = new Map<string, DeskItem[]>();
  for (const item of items) {
    const key = groupKey(item);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  const out: DeskEntry[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = groupKey(item);
    const group = key ? groups.get(key) : undefined;
    if (key && group && group.length > 1) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key: `batch:${key}`, items: group });
    } else {
      out.push({ key: item.id, items: [item] });
    }
  }
  return out;
}

function groupKey(item: DeskItem): string | null {
  return item.status === "open" && item.kind === "external_action" && item.batchKey
    ? item.batchKey
    : null;
}

/** "today", "yesterday", or the day's own date (`YYYY-MM-DD` in the viewer's time zone). */
export function dayOf(iso: string, now: Date): string {
  const d = new Date(iso);
  const key = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  if (key(d) === key(now)) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key(d) === key(yesterday)) return "yesterday";
  return key(d);
}

/** Entries by day, in order: the time is when the item came (or, when done, was resolved). */
export function byDay(
  entries: readonly DeskEntry[],
  now: Date,
): { day: string; first: string; entries: DeskEntry[] }[] {
  const out: { day: string; first: string; entries: DeskEntry[] }[] = [];
  for (const e of entries) {
    const at = timeOf(leadOf(e));
    const day = dayOf(at, now);
    const last = out.at(-1);
    if (last && last.day === day) last.entries.push(e);
    else out.push({ day, first: at, entries: [e] });
  }
  return out;
}

export function timeOf(item: DeskItem): string {
  return item.status === "resolved" && item.resolvedAt ? item.resolvedAt : item.createdAt;
}

/** What an open item asks of the person: a signature, an answer, a release code, or "Done". */
export type DeskNeed = "sign" | "answer" | "code" | "done" | "request";

export function needOf(item: Pick<DeskItem, "kind" | "payload">): DeskNeed {
  if (isPlainObject(item.payload.accessRelease)) return "code";
  if (item.kind === "change_request") return "request";
  if (item.kind === "request") return "answer";
  if (item.kind === "review" && typeof item.payload.fingerprint === "string") return "done";
  return "sign";
}

/** Why a change waits for a signature (`payload.whyApproval`), when the API stored it. */
export function whyOf(item: Pick<DeskItem, "payload">): WhyApproval | null {
  return readWhyApproval(item.payload.whyApproval);
}

/** Inside its undo window at `now`: signed, and the run not told yet. */
export function undoable(item: Pick<DeskItem, "status" | "deliverAfter">, now: number): boolean {
  return (
    item.status === "resolved" && !!item.deliverAfter && new Date(item.deliverAfter).getTime() > now
  );
}

/** Seconds left in the undo window (0 once it has passed). */
export function undoLeft(item: Pick<DeskItem, "deliverAfter">, now: number): number {
  if (!item.deliverAfter) return 0;
  return Math.max(0, Math.ceil((new Date(item.deliverAfter).getTime() - now) / 1000));
}

/** An item after a Desk action: the API's new Desk state over what was on screen. */
export function withState(item: DeskItem, state: DeskItemState): DeskItem {
  return {
    ...item,
    status: state.status,
    deliverAfter: state.deliverAfter,
    snoozedUntil: state.snoozedUntil,
    batchKey: state.batchKey,
    resolvedAt: state.resolvedAt,
  };
}

/** Snoozed until a time still ahead: out of "Waiting on you" until then. */
export function isSnoozed(item: Pick<DeskItem, "snoozedUntil">, now: number): boolean {
  return !!item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now;
}

/** The three "Not now" times: in 3 hours, tomorrow at 8:00, next Monday at 8:00 (viewer's time). */
export function snoozeTimes(now: Date): { later: Date; tomorrow: Date; monday: Date } {
  const later = new Date(now.getTime() + 3 * 60 * 60_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const monday = new Date(now);
  const ahead = (8 - now.getDay()) % 7 || 7;
  monday.setDate(now.getDate() + ahead);
  monday.setHours(8, 0, 0, 0);
  return { later, tomorrow, monday };
}

/**
 * The input a change will be signed with: the person's edit (`payload.edited.input`) when there is
 * one, else the agent's.
 */
export function signedInput(payload: Record<string, unknown>): unknown {
  const edited = payload.edited;
  if (isPlainObject(edited) && isPlainObject(edited.input)) return edited.input;
  return payload.input;
}
