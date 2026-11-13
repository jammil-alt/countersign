// The Desk's pure rules on the phone, mirroring apps/web's desk/model.ts: what an item asks of the
// person, its quick answers, why it needs them (the gate's reasons, in core's words), the "Not
// now" times and the undo window. The API decides everything; this only arranges what it sent.
import {
  DESK_WORDS,
  isPlainObject,
  type Locale,
  type LocalizedText,
  type PortalInboxItem,
  pickLocalized,
  readWhyApproval,
} from "@countersign/core";
import type { z } from "zod";

export type DeskItem = z.output<typeof PortalInboxItem>;

/** What an open item asks: a signature, an answer, a release code, "Done", or a request. */
export type DeskNeed = "sign" | "answer" | "code" | "done" | "request";

export function needOf(item: Pick<DeskItem, "kind" | "payload">): DeskNeed {
  if (isPlainObject(item.payload.accessRelease)) return "code";
  if (item.kind === "change_request") return "request";
  if (item.kind === "request") return "answer";
  if (item.kind === "review" && typeof item.payload.fingerprint === "string") return "done";
  return "sign";
}

/** The item is a change to a client's tool, signed with the phone's key. */
export const isChange = (item: Pick<DeskItem, "kind">) =>
  item.kind === "external_action" || item.kind === "approval";

/** A question's one-tap answers (`payload.choices`), or null when it takes free text. */
export function quickAnswers(
  payload: Record<string, unknown>,
  locale: Locale,
): { value: string; label: string }[] | null {
  const raw = payload.choices;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: { value: string; label: string }[] = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) return null;
    const { value, label } = c as { value?: unknown; label?: unknown };
    if (typeof value !== "string") return null;
    const text =
      typeof label === "string" || (typeof label === "object" && label !== null)
        ? pickLocalized(label as LocalizedText, locale)
        : value;
    out.push({ value, label: text });
  }
  return out;
}

/** Why a change waits for this person, in their language: the gate's reasons, never the agent's. */
export function whyLines(item: Pick<DeskItem, "payload">, locale: Locale): string[] {
  const why = readWhyApproval(item.payload.whyApproval);
  if (!why) return [];
  const words = DESK_WORDS[locale] ?? DESK_WORDS.en;
  const lines = why.reasons.map((r) =>
    r === "stage" ? words.stage[why.stage ?? "trial"] : words.why[r],
  );
  if (why.route?.source === "rule") lines.push(words.byRule);
  return lines;
}

/** Snoozed until a time still ahead. */
export function isSnoozed(item: Pick<DeskItem, "snoozedUntil">, now: number): boolean {
  return !!item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now;
}

/** The three "Not now" times: in 3 hours, tomorrow at 8:00, next Monday at 8:00 (phone's time). */
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

/** Seconds left in the undo window (0 once it has passed). */
export function undoLeft(item: Pick<DeskItem, "deliverAfter">, now: number): number {
  if (!item.deliverAfter) return 0;
  return Math.max(0, Math.ceil((new Date(item.deliverAfter).getTime() - now) / 1000));
}

/** "0:52" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The input a change will be written with: the person's edit when there is one, else the agent's. */
export function signedInput(payload: Record<string, unknown>): unknown {
  const edited = payload.edited;
  if (isPlainObject(edited) && isPlainObject(edited.input)) return edited.input;
  return payload.input;
}

/** "12 min ago", "3 hr ago", "2 days ago". */
export function ago(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
