// The back office's words for a client's connectors (docs/connectors-plan.md §7, §7.1, §7.2): the
// client's standing say over our changes, what our edit's button says, a request's state, an
// agent's gaps and its readiness. Plain words, sentence case; the API sends the rows' own words.
import type {
  ChangeRequestView,
  GapView,
  MezonasMayView,
  OpsConnectionChangePreview,
  OpsConnectionChangeResult,
} from "@countersign/core";
import { EN } from "../../i18n/i18n";
import type { Tone } from "../../ui/primitives";

/** "Dec 20". */
export function dayWords(iso: string): string {
  return EN.fmt.day(iso);
}

/** "Pat Lee" → "Pat"; no name → "the client admin". */
export function firstName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first || "the client admin";
}

/**
 * The client's standing say on one connection, in our words (§7.2): "Hartley Millwork lets us:
 * make changes agents need, until Dec 20".
 */
export function mezonasMayWords(clientName: string, may: MezonasMayView | null): string {
  if (!may) return `${clientName} asks to approve each change here.`;
  if (!may.active) {
    return `${clientName}'s go-ahead here ended${may.until ? ` ${dayWords(may.until)}` : ""}. Each change goes to them to approve.`;
  }
  const what =
    may.choice === "needs" ? "make changes agents need" : "make any change, up to Ask me first";
  const until = may.until ? `, until ${dayWords(may.until)}` : ", until they turn it off";
  return `${clientName} lets us: ${what}${until}`;
}

/**
 * The footer's button for our edit, from the preview's outcome (§7.1, §7.2): tighter applies now;
 * an edit the client's go-ahead covers applies now and the client admin is told; anything else is
 * sent to the client. The Sandbox is ours: it applies.
 */
export function changeButtonWords(
  preview: Pick<OpsConnectionChangePreview, "outcome" | "mezonasMay">,
  clientName: string,
  sandbox: boolean,
): string {
  if (sandbox) return "Apply now";
  switch (preview.outcome) {
    case "apply":
      return "Apply now";
    case "apply_under_authorization":
      return `Apply now (${firstName(preview.mezonasMay?.setBy.name)} is told)`;
    case "request":
      return `Send to ${clientName} for approval`;
    default:
      return "Nothing to change";
  }
}

/** "2 changes, both looser", "1 change, tighter", "3 changes, some looser". */
export function changeSummaryWords(
  count: number,
  direction: OpsConnectionChangePreview["direction"],
): string {
  if (count === 0 || direction === "none") return "Nothing changes";
  const n = `${count} ${count === 1 ? "change" : "changes"}`;
  if (direction === "mixed") return `${n}, some looser, some tighter`;
  if (count === 1) return `${n}, ${direction}`;
  return `${n}, ${count === 2 ? "both" : "all"} ${direction}`;
}

/** What became of our edit, in a line. */
export function resultWords(
  result: OpsConnectionChangeResult,
  clientName: string,
  sandbox: boolean,
): string {
  if (result.outcome === "applied") {
    return sandbox ? "Applied." : `Applied. ${clientName} is told in their Inbox.`;
  }
  if (result.outcome === "applied_under_authorization") {
    return `Applied under ${clientName}'s go-ahead. ${firstName(result.authorization.setBy.name)} is told.`;
  }
  const replaced = result.replaced ? " It replaces the request that was open." : "";
  return `Sent to ${clientName} for approval: ${result.whyNot} Nothing changes until a client admin approves.${replaced}`;
}

/** A request's state as a pill: waiting on the client is signal, always with its word. */
export function requestState(
  r: Pick<ChangeRequestView, "status" | "outOfDate">,
  clientName: string,
): { words: string; tone: Tone } {
  if (r.status === "open") {
    return r.outOfDate
      ? { words: "Out of date", tone: "risk" }
      : { words: `Waiting on ${clientName}`, tone: "warning" };
  }
  const words: Record<Exclude<ChangeRequestView["status"], "open">, [string, Tone]> = {
    approved: ["Approved", "positive"],
    declined: ["Declined", "neutral"],
    replaced: ["Replaced", "neutral"],
    expired: ["Expired", "neutral"],
    withdrawn: ["Withdrawn", "neutral"],
  };
  const [w, tone] = words[r.status];
  return { words: w, tone };
}

/** A gap's kind in a few words. */
export const GAP_WORDS: Record<GapView["kind"], string> = {
  not_connected: "Not connected",
  broken: "Needs signing in again",
  not_bound: "Not bound",
  off_on_connection: "Off on the connection",
  scope_excludes: "Outside the connection's scope",
  off_in_grant: "Grant too narrow",
  could_run_alone: "Could run on its own",
};

/** Who fixes a gap. */
export function fixByWords(fixBy: GapView["fixBy"], clientName: string): string {
  return fixBy === "mezonas" ? "Us" : clientName;
}

export type ReadinessStateId =
  | "ready"
  | "not_connected"
  | "broken"
  | "needs_access"
  | "not_bound"
  | "grant_too_narrow"
  | "could_run_alone";

/** A connector's state on the Readiness panel: ready is positive, the rest wait, with words. */
export const READINESS_WORDS: Record<ReadinessStateId, [string, Tone]> = {
  ready: ["Ready", "positive"],
  could_run_alone: ["Ready", "positive"],
  not_connected: ["Not connected", "warning"],
  broken: ["Connection broken", "risk"],
  needs_access: ["Needs access", "warning"],
  not_bound: ["Not bound", "warning"],
  grant_too_narrow: ["Grant too narrow", "warning"],
};

/** "Reads 9 · changes 3 with approval · 1 on its own". */
export function accessWords(a: { reads: number; changesAsk: number; changesAuto: number }): string {
  const parts = [a.reads === 0 ? "Reads nothing" : `Reads ${a.reads}`];
  if (a.changesAsk === 0 && a.changesAuto === 0) parts.push("changes nothing");
  if (a.changesAsk > 0) parts.push(`changes ${a.changesAsk} with approval`);
  if (a.changesAuto > 0) parts.push(`${a.changesAuto} on its own`);
  return parts.join(" · ");
}

/** How the client connects a connector, in our words. */
export const AUTH_WORDS: Record<string, string> = {
  oauth2: "the client signs in from their portal",
  api_key: "the client adds a key from their portal",
  none: "no sign-in needed",
};
