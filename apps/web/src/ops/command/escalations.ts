// Needs us rows in words (the command center and Escalations): the chip, what waits on whom and
// why, and where to go for it. Back office only, English.
import { APPROVAL_OVERDUE_HOURS, type Escalation } from "@countersign/core";
import type { ChipState } from "../../ui/status";
import { OPS_PATHS } from "../paths";
import { age, NOBODY_TO_ACT_WORDS, waitOnWords } from "../run/words";

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

/**
 * What waits, on whom and why it needs us: "Waiting for approval · client admin: Itemize bill
 * 20418. Everyone who may approve it is still invited and hasn't signed in."
 */
export function escalationLine(e: Escalation): string {
  switch (e.kind) {
    case "approval": {
      const w = e.wait;
      const who = w ? `Waiting for approval · ${waitOnWords(w)}` : "Waiting for approval";
      const why = w?.nobodyToAct
        ? NOBODY_TO_ACT_WORDS[w.nobodyToAct]
        : `Waiting over ${APPROVAL_OVERDUE_HOURS} hours.`;
      return `${who}: ${sentence(e.title)} ${why}`;
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

/** Where a Needs us row goes: its run, else the page to act on. */
export function escalationAction(e: Escalation): { to: string; label: string } {
  if (e.runId && e.kind !== "item") return { to: `/ops/runs/${e.runId}`, label: "Open run" };
  switch (e.kind) {
    case "approval":
      return {
        to: `${OPS_PATHS.escalations}?view=clients&client=${e.client.id}`,
        label: "Open item",
      };
    case "connection":
      return { to: `/ops/clients/${e.client.id}/connections`, label: "Open connections" };
    case "low_confidence":
      return { to: `/ops/clients/${e.client.id}/documents`, label: "Open documents" };
    default:
      return { to: OPS_PATHS.escalations, label: "Open escalations" };
  }
}
