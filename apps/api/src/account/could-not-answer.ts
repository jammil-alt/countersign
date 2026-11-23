// S2.1 (overnight fixes, 2026-11-23): when Sloan's run in a conversation ends without an answer
// (its step failed, stopped on a budget, or the run was lost and failed by the sweep), code posts
// one fixed message in the conversation, in the client's language: "I couldn't answer that. We've
// told your lead." The model never writes it, and nothing is posted when Sloan already answered in
// that run. The failed run itself reaches the operator as every failed run does (`run.failed`).
//
// DECISION: posted in the transaction that records the failure, so it exists exactly when the run
// is failed (as `run.failed` does), from the run's own trigger: the thread and the message it
// answers. A conversation with an area owner gets it in the owner's name, as its answers are.
// DECISION: the message emits `thread.message_posted` like an answer does; Sloan's own trigger
// takes only a person's messages, so it starts nothing new.

import {
  ACCOUNT_AGENT_SLUG,
  isPlainObject,
  sloanCouldNotAnswer,
  ThreadMessagePostedPayload,
} from "@countersign/core";
import { agent, areaOwner, message, run, type Tx } from "@countersign/db";
import { type EmitOptions, type EventRow, emit } from "@countersign/senses";
import { findThread, postMessage } from "@countersign/threads";
import { and, eq, sql } from "drizzle-orm";
import { tenantLocale } from "../routes/language";

export interface CouldNotAnswerRun {
  id: string;
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  mode: string;
}

/**
 * Posts Sloan's fixed "couldn't answer" message for a live account-conversation run that ended
 * failed without answering; returns the message (and its event, when one was emitted), or null
 * when nothing was posted.
 */
export async function postCouldNotAnswer(
  tx: Tx,
  r: CouldNotAnswerRun,
  options: Pick<EmitOptions, "registry"> = {},
): Promise<{ threadId: string; messageId: string; event: EventRow | null } | null> {
  if (r.mode !== "live") return null;
  const [a] = await tx
    .select({ kind: agent.kind, slug: agent.slug })
    .from(agent)
    .where(and(eq(agent.id, r.agentId), eq(agent.tenantId, r.tenantId)));
  if (a?.kind !== "client" || a.slug !== ACCOUNT_AGENT_SLUG) return null;
  const [row] = await tx
    .select({ trigger: run.trigger })
    .from(run)
    .where(and(eq(run.id, r.id), eq(run.tenantId, r.tenantId)));
  const trigger = isPlainObject(row?.trigger) ? row.trigger : {};
  if (trigger.type !== "event" || trigger.eventType !== "thread.message_posted") return null;
  const posted = ThreadMessagePostedPayload.safeParse(trigger.payload);
  if (
    !posted.success ||
    posted.data.subjectType !== "account" ||
    posted.data.senderType !== "user" ||
    posted.data.audience !== "client"
  ) {
    return null;
  }
  const t = await findThread(tx, [r.tenantId], posted.data.threadId);
  if (t?.subjectType !== "account") return null;
  // Sloan answered in this run before it failed: the person has an answer.
  const [answered] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.tenantId, r.tenantId),
        eq(message.threadId, t.id),
        eq(message.senderType, "agent"),
        eq(message.audience, "client"),
        sql`${message.body}->>'runId' = ${r.id}`,
      ),
    )
    .limit(1);
  if (answered) return null;
  // A conversation with an area owner is answered in its name (threads-port's rule).
  const [owner] = t.subjectId
    ? await tx
        .select({ id: areaOwner.id, name: areaOwner.name, area: areaOwner.area })
        .from(areaOwner)
        .where(and(eq(areaOwner.id, t.subjectId), eq(areaOwner.tenantId, r.tenantId)))
    : [];
  let event: EventRow | null = null;
  const made = await postMessage(
    tx,
    {
      tenantId: r.tenantId,
      thread: t,
      senderType: "agent",
      senderId: r.agentId,
      agentVersionId: r.agentVersionId,
      kind: "text",
      body: {
        text: sloanCouldNotAnswer(await tenantLocale(tx, r.tenantId)),
        ...(owner ? { as: { ownerId: owner.id, name: owner.name, area: owner.area } } : {}),
        runId: r.id,
        couldNotAnswer: true,
      },
      sources: [posted.data.messageId, r.id],
      audience: "client",
    },
    async (etx, e) => {
      event = await emit(
        etx,
        {
          tenantId: e.tenantId,
          type: e.type,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          payload: e.payload as unknown as Record<string, unknown>,
        },
        options,
      );
    },
  );
  return { threadId: t.id, messageId: made.id, event };
}
