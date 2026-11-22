// Needs us rows in words (the command center and Escalations): the chip, what waits on whom and
// why, and where to go for it. Back office only, English.
import { APPROVAL_OVERDUE_HOURS, type Escalation } from "@countersign/core";
import { EN } from "../../i18n/i18n";
import type { ChipState } from "../../ui/status";
import { OPS_PATHS } from "../paths";
import { age, NOBODY_TO_ACT_MANY_WORDS, NOBODY_TO_ACT_WORDS, waitOnWords } from "../run/words";

export function escalationChip(e: Escalation): { state: ChipState; words: string } {
  switch (e.kind) {
    case "approval":
    case "item":
      return { state: "waiting", words: `Waiting ${age(e.blockedSince)}` };
    case "low_confidence":
      return { state: "waiting", words: "Low confidence" };
    default:
      return { state: "blocked", words: `Blocked ${age(e.blockedSince)}` };
  }
}

/** A Needs us row's accent (design pass): its chip's colour, gold for waiting, risk for blocked. */
export function escalationTone(state: ChipState): "signal" | "risk" | undefined {
  if (state === "waiting") return "signal";
  if (state === "blocked" || state === "failed") return "risk";
  return undefined;
}

/** A title as the start of a sentence's end: "Is it right?" stays, "Itemize bill 20418" gets ".". */
function sentence(text: string): string {
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

/** How many of a client's items an approval escalation covers (one, without a list). */
export function escalationItems(e: Pick<Escalation, "itemIds" | "wait">): number {
  return e.itemIds?.length ?? e.wait?.items ?? 1;
}

/**
 * What waits, on whom and why it needs us: "Waiting for approval · client admin: Itemize bill
 * 20418. Everyone who may approve it is still invited and hasn't signed in." Several of a
 * client's items for one reason: "… client admin: 24 items, the oldest Add Dana Reyes to the
 * directory. Everyone who may approve them …".
 */
export function escalationLine(e: Escalation): string {
  switch (e.kind) {
    case "approval": {
      const w = e.wait;
      const who = w ? `Waiting for approval · ${waitOnWords(w)}` : "Waiting for approval";
      const n = escalationItems(e);
      const why = w?.nobodyToAct
        ? n > 1
          ? NOBODY_TO_ACT_MANY_WORDS[w.nobodyToAct]
          : NOBODY_TO_ACT_WORDS[w.nobodyToAct]
        : `Waiting over ${APPROVAL_OVERDUE_HOURS} hours.`;
      const what = n > 1 ? `${n} items, the oldest ${sentence(e.title)}` : sentence(e.title);
      return `${who}: ${what} ${why}`;
    }
    case "failed_run":
      return e.title;
    case "connection":
      return `The ${e.title} connection failed. The client signs in again from their portal.`;
    case "low_confidence":
      return `${e.title} was read under the confidence threshold today.`;
    default:
      return e.title;
  }
}

/**
 * Where a Needs us row goes. An item opens itself in Escalations (`?item=`, in its side sheet and
 * marked in the list); a client's approvals open in Waiting on clients, the one item itself, or
 * several marked (`?stuck=`, this escalation's id); a failed run its run; the rest the page to
 * act on.
 */
// DECISION (QA, 2026-11-22): "Open item" opens that item, never only the client's list. An
// approval opens its item rather than its run: the item's sheet links the run.
export function escalationAction(e: Escalation): { to: string; label: string } {
  switch (e.kind) {
    case "item":
      return { to: `${OPS_PATHS.escalations}?item=${e.id}`, label: "Open item" };
    case "approval": {
      // An answer from before `itemIds` named its run, not its item: that opens the run.
      if (!e.itemIds && e.runId) return { to: `/ops/runs/${e.runId}`, label: "Open run" };
      const list = `${OPS_PATHS.escalations}?view=clients&client=${e.client.id}`;
      const ids = e.itemIds ?? [e.id];
      return ids.length > 1
        ? { to: `${list}&stuck=${e.id}`, label: `Open ${ids.length} items` }
        : { to: `${list}&item=${ids[0] ?? e.id}`, label: "Open item" };
    }
    case "connection":
      return { to: `/ops/clients/${e.client.id}/connections`, label: "Open connections" };
    case "low_confidence":
      return { to: `/ops/clients/${e.client.id}/documents`, label: "Open documents" };
    default:
      return e.runId
        ? { to: `/ops/runs/${e.runId}`, label: "Open run" }
        : { to: OPS_PATHS.escalations, label: "Open escalations" };
  }
}

/** How urgent a Needs us entry is, by how long the client has been waiting on us. */
export type Urgency = "urgent" | "high" | "new";

// DECISION: urgency is by age alone (2026-11-10): urgent past 2 days, high from 1 day, new
// under a day. Age is what a client feels, and it reads the same for every kind of escalation.
export const URGENCY: {
  id: Urgency;
  label: string;
  range: string;
  tone: "risk" | "signal" | "slate";
}[] = [
  { id: "urgent", label: "Urgent", range: "Over 2 days", tone: "risk" },
  { id: "high", label: "High", range: "1 to 2 days", tone: "signal" },
  { id: "new", label: "New", range: "Under a day", tone: "slate" },
];

export function urgencyOf(e: Pick<Escalation, "blockedSince">, now: Date = new Date()): Urgency {
  const hours = (now.getTime() - new Date(e.blockedSince).getTime()) / 3_600_000;
  if (hours >= 48) return "urgent";
  if (hours >= 24) return "high";
  return "new";
}

/** "8 Nov, 14:05": when the wait started, on a row. */
export function sinceDate(iso: string): string {
  return EN.fmt.dateTime(iso);
}

/**
 * Escalations' two calls for a view, a status and a client, in one place so anything that fills
 * the store ahead of the screen (1.6) uses the same options in the same order and shares its
 * stored answer. Defaults: Needs us, open, every client.
 */
export function escalationsCalls({
  view = "us",
  status = "open",
  client = "",
}: {
  view?: "us" | "clients";
  status?: "open" | "resolved";
  client?: string;
} = {}) {
  return {
    inbox: {
      query: {
        assigned: view === "clients" ? "all" : "operator",
        status,
        ...(client ? { client } : {}),
      },
    },
    needsUs: { query: client ? { client } : {} },
  } as const;
}
