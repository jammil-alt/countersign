// P-4: a conversation step on the run pages (ARCHITECTURE §10.12; docs/plan.md §1.66). The back
// office sees the transcript with each turn's model and cost; the portal sees only the client's
// side of the conversation (the messages and when), never a prompt, a model or a cost
// (invariant 11). Both read the conversation's message rows (`reach_out`, subject
// `converse:<run>:<key>`) of one run of one client.

import {
  type ConverseActor,
  type ConverseChannel,
  type ConverseEvent,
  type ConverseOpsView,
  type ConverseOutcome,
  type ConversePortalView,
  Decimal,
  pickMessage,
  type ReachReply,
} from "@countersign/core";
import { appUser, reachOut, type Tx } from "@countersign/db";
import { and, eq, inArray, like } from "drizzle-orm";
// P-7
import { translationsFor } from "../translate/views";

interface Meta {
  key: string;
  turn: number;
  kind: string;
  model?: string;
  costUsd?: string;
  setup?: {
    input: { channel: ConverseChannel };
    contactId: string;
    contactName: string;
  };
  end?: { outcome: ConverseOutcome };
  // P-6: take-overs and ends, kept on the row that was current then (docs/plan.md §1.68).
  events?: StoredEvent[];
}

// P-6: what a row keeps of people stepping in and editing (docs/plan.md §1.68).
/** A take-over or an end, as stored: who by id, and whether it was us (the operator). */
export interface StoredEvent {
  kind: ConverseEvent["kind"];
  at: string;
  by: string;
  byUs: boolean;
  reason: string | null;
}

/** A message changed before it was approved: the agent's text kept as `original`. */
export interface StoredEdit {
  original: string | null;
  text: string;
  by: string;
  byUs: boolean;
  at: string;
  // P-7: the person's own words, translated into the contact's language to become `text`.
  translated?: TranslatedEdit;
}

/** P-7: a person's words translated before signing (docs/plan.md §1.69). */
export interface TranslatedEdit {
  /** What the person wrote; `text` is its translation, what is signed and sent. */
  original: string;
  from: string;
  to: string;
  translationId: string;
}

function editOf(row: Row): StoredEdit | null {
  const plan = row.plan as { edited?: StoredEdit } | null;
  return plan?.edited ?? null;
}

type Row = typeof reachOut.$inferSelect;

function metaOf(row: Row): Meta | null {
  const plan = row.plan as { converse?: Meta } | null;
  return plan?.converse ?? null;
}

function textOf(row: Row): string {
  const plan = row.plan as {
    message?: { template?: Record<string, string> };
    language?: string;
  } | null;
  const t = plan?.message?.template;
  return t ? pickMessage(t as never, (plan?.language ?? "en") as never) : "";
}

function sentAt(row: Row): string | null {
  const a = ((row.attempts ?? []) as { status?: string; at?: string }[]).find(
    (x) => x.status === "sent",
  );
  return a?.at ?? null;
}

function statusOf(row: Row): string {
  if (sentAt(row)) return "sent";
  if (row.status === "awaiting_approval") return "waiting_for_approval";
  if (row.status === "open" && row.nextAttemptAt) return "held_for_quiet_hours";
  // P-6: a message a person took over from, or ended, before it went.
  if (row.outcome === "declined" && row.reason?.startsWith(TAKEN_OVER)) return "taken_over";
  if (row.outcome === "declined" && row.reason?.startsWith(ENDED)) return "ended";
  if (row.outcome === "declined") return "not_approved";
  return row.status === "ended" ? "not_sent" : "sending";
}

/** The reason a message ends with when a person takes the conversation over (P-6). */
export const TAKEN_OVER = "taken over";
/** The reason a message ends with when a person ends the conversation (P-6). */
export const ENDED = "ended by";

/** A run's conversations, by the step run they belong to. */
export async function runConversations(
  tx: Tx,
  tenantId: string,
  runId: string,
): Promise<Map<string, ConverseOpsView>> {
  const rows = await tx
    .select()
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.runId, runId),
        like(reachOut.subject, `converse:${runId}:%`),
      ),
    );
  const bySubject = new Map<string, Row[]>();
  for (const r of rows) {
    const list = bySubject.get(r.subject) ?? [];
    list.push(r);
    bySubject.set(r.subject, list);
  }
  // P-6: the names of the people who edited, took over or ended (the back office sees them all).
  const people = new Set<string>();
  for (const r of rows) {
    const e = editOf(r);
    if (e) people.add(e.by);
    for (const ev of metaOf(r)?.events ?? []) people.add(ev.by);
  }
  const names = new Map<string, string | null>();
  if (people.size > 0) {
    const found = await tx
      .select({ id: appUser.id, name: appUser.name, email: appUser.email })
      .from(appUser)
      .where(inArray(appUser.id, [...people]));
    for (const u of found) names.set(u.id, u.name ?? u.email);
  }
  const actor = (by: string, byUs: boolean): ConverseActor => ({
    us: byUs,
    name: names.get(by) ?? null,
  });
  // P-7: each reply's translation, beside its raw record (docs/plan.md §1.69).
  const replyIds = rows
    .map((r) => (r.reply as ReachReply | null)?.rawRecordId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const translated = await translationsFor(tx, tenantId, { rawRecordIds: replyIds }, "ops");
  const out = new Map<string, ConverseOpsView>();
  for (const list of bySubject.values()) {
    list.sort((a, b) => (metaOf(a)?.turn ?? 0) - (metaOf(b)?.turn ?? 0));
    const first = list[0];
    const setup = first ? metaOf(first)?.setup : undefined;
    if (!first?.stepRunId || !setup) continue;
    const messages: ConverseOpsView["messages"] = [];
    const events: ConverseEvent[] = [];
    let cost = new Decimal(0);
    let outcome: ConverseOutcome | null = null;
    for (const r of list) {
      const meta = metaOf(r);
      if (!meta) continue;
      cost = cost.plus(meta.costUsd || "0");
      if (meta.end) outcome = meta.end.outcome;
      messages.push({
        turn: meta.turn,
        direction: "out",
        text: textOf(r),
        at: sentAt(r),
        status: statusOf(r),
        ...(meta.model ? { model: meta.model } : {}),
        ...(meta.costUsd ? { costUsd: meta.costUsd } : {}),
        // P-6: edited before it was approved: the agent's text and who changed it.
        ...(() => {
          const e = editOf(r);
          return e ? { edited: { original: e.original, by: actor(e.by, e.byUs), at: e.at } } : {};
        })(),
      });
      for (const ev of meta.events ?? []) {
        events.push({ kind: ev.kind, at: ev.at, by: actor(ev.by, ev.byUs), reason: ev.reason });
      }
      const reply = r.reply as ReachReply | null;
      if (reply) {
        messages.push({
          turn: meta.turn,
          direction: "in",
          text: reply.text,
          at: reply.at,
          status: "received",
          ...(() => {
            const t = reply.rawRecordId ? translated.get(reply.rawRecordId) : undefined;
            return t ? { translation: t } : {};
          })(),
        });
      }
    }
    out.set(first.stepRunId, {
      channel: setup.input.channel,
      who: { id: setup.contactId, name: setup.contactName },
      outcome,
      messages,
      costUsd: cost.toFixed(4),
      ...(events.length ? { events } : {}),
    });
  }
  return out;
}

/** The portal's: only what was said and when (no drafts awaiting a signature, no model, no cost). */
export function portalConversation(
  view: ConverseOpsView | undefined,
  // P-6: whether this person may take the conversation over or end it (its approver).
  mayControl = false,
): ConversePortalView {
  if (!view) return { messages: [] };
  // P-6: the portal never names our people: "Mezonas" (the screens' words) when it was us.
  const portalActor = (a: ConverseActor): ConverseActor => (a.us ? { us: true, name: null } : a);
  return {
    messages: view.messages
      .filter((m) => m.direction === "in" || m.status === "sent")
      .map((m) => ({
        direction: m.direction,
        text: m.text,
        at: m.at,
        ...(m.edited ? { edited: { by: portalActor(m.edited.by) } } : {}),
        // P-7: the translation without its model or cost (invariant 11).
        ...(m.translation
          ? {
              translation: {
                id: m.translation.id,
                status: m.translation.status,
                reason: m.translation.reason,
                from: m.translation.from,
                to: m.translation.to,
                text: m.translation.text,
                truncated: m.translation.truncated,
                at: m.translation.at,
              },
            }
          : {}),
      })),
    ...(view.events?.length
      ? { events: view.events.map((e) => ({ ...e, by: portalActor(e.by) })) }
      : {}),
    live: view.outcome === null,
    ...(mayControl && view.outcome === null ? { mayControl: true } : {}),
  };
}
