// P-4: a conversation step on the run pages (ARCHITECTURE §10.12; docs/plan.md §1.66). The back
// office sees the transcript with each turn's model and cost; the portal sees only the client's
// side of the conversation (the messages and when), never a prompt, a model or a cost
// (invariant 11). Both read the conversation's message rows (`reach_out`, subject
// `converse:<run>:<key>`) of one run of one client.

import {
  type ConverseChannel,
  type ConverseOpsView,
  type ConverseOutcome,
  type ConversePortalView,
  Decimal,
  pickMessage,
  type ReachReply,
} from "@countersign/core";
import { reachOut, type Tx } from "@countersign/db";
import { and, eq, like } from "drizzle-orm";

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
  if (row.outcome === "declined") return "not_approved";
  return row.status === "ended" ? "not_sent" : "sending";
}

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
  const out = new Map<string, ConverseOpsView>();
  for (const list of bySubject.values()) {
    list.sort((a, b) => (metaOf(a)?.turn ?? 0) - (metaOf(b)?.turn ?? 0));
    const first = list[0];
    const setup = first ? metaOf(first)?.setup : undefined;
    if (!first?.stepRunId || !setup) continue;
    const messages: ConverseOpsView["messages"] = [];
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
      });
      const reply = r.reply as ReachReply | null;
      if (reply) {
        messages.push({
          turn: meta.turn,
          direction: "in",
          text: reply.text,
          at: reply.at,
          status: "received",
        });
      }
    }
    out.set(first.stepRunId, {
      channel: setup.input.channel,
      who: { id: setup.contactId, name: setup.contactName },
      outcome,
      messages,
      costUsd: cost.toFixed(4),
    });
  }
  return out;
}

/** The portal's: only what was said and when (no drafts awaiting a signature, no model, no cost). */
export function portalConversation(view: ConverseOpsView | undefined): ConversePortalView {
  if (!view) return { messages: [] };
  return {
    messages: view.messages
      .filter((m) => m.direction === "in" || m.status === "sent")
      .map((m) => ({ direction: m.direction, text: m.text, at: m.at })),
  };
}
