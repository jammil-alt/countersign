// Questions (docs/plan.md §1.124.4; docs/cases-plan.md §3.3): activity on the client, not items in
// a pipeline. Sloan answers in the portal; a client's question in their account conversation that
// no client-audience reply answered within 4 business hours becomes the operator's to-do ("Hand
// you the hard ones"), once per message. Hourly from the cron.
//
// DECISION: the weekly line on questions is left for later (owner, 2026-11-17); a question asked
// 3 times in 30 days is counted here and becomes a to-do to draft a knowledge entry, at draft level.

import { processes } from "@countersign/core";
import { type Db, membership, message, tenant, thread, todo, withOperator } from "@countersign/db";
import { and, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { clientBusinessHours } from "../hours/hours";
import { reportHandled } from "../observability/report";
import { logPlay } from "../work/play-log";
import { addTodo } from "../work/todos-store";
import { mayAct } from "./autopilot";

export const QUESTION_ANSWER_WITHIN = "4 hours";
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const REPEAT_MS = 30 * 24 * 60 * 60 * 1000;

const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** One client's unanswered questions and repeats; returns the to-dos made. */
export async function questionsFor(db: Db, tenantId: string, now: Date): Promise<number> {
  return withOperator(db, [tenantId], async (tx) => {
    const [t] = await tx
      .select({ name: tenant.name, timezone: tenant.timezone, settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    if (!t) return 0;
    const hours = clientBusinessHours(t).hours;
    const clientPeople = new Set(
      (
        await tx
          .select({ userId: membership.userId })
          .from(membership)
          .where(and(eq(membership.tenantId, tenantId), ne(membership.role, "operator")))
      ).map((m) => m.userId),
    );
    const asked = await tx
      .select({
        id: message.id,
        threadId: message.threadId,
        senderId: message.senderId,
        text: sql<string>`${message.body}->>'text'`,
        at: message.createdAt,
      })
      .from(message)
      .innerJoin(
        thread,
        and(eq(thread.id, message.threadId), eq(thread.tenantId, message.tenantId)),
      )
      .where(
        and(
          eq(message.tenantId, tenantId),
          eq(thread.subjectType, "account"),
          eq(message.senderType, "user"),
          gte(message.createdAt, new Date(now.getTime() - REPEAT_MS)),
        ),
      )
      .orderBy(message.createdAt)
      .limit(500);
    const fromClient = asked.filter(
      (m) => m.senderId && clientPeople.has(m.senderId) && (m.text ?? "").trim(),
    );
    let made = 0;
    for (const m of fromClient) {
      if (m.at.getTime() < now.getTime() - LOOKBACK_MS) continue;
      const due = processes.dueAt(m.at, QUESTION_ANSWER_WITHIN, {
        hours: "business",
        businessHours: hours,
      });
      if (due > now) continue;
      const [answer] = await tx
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.tenantId, tenantId),
            eq(message.threadId, m.threadId),
            eq(message.audience, "client"),
            inArray(message.senderType, ["agent", "system"]),
            gt(message.createdAt, m.at),
          ),
        )
        .limit(1);
      if (answer) continue;
      const [had] = await tx
        .select({ id: todo.id })
        .from(todo)
        .where(eq(todo.dedupeKey, `question:${m.id}`));
      if (had) continue;
      const may = await mayAct(tx, {
        flow: "questions",
        stage: "all",
        play: "hand_hard_ones",
        action: "send",
      });
      if (may.allowed === "off") continue;
      await addTodo(tx, {
        title: `Answer ${t.name}: ${(m.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`,
        owner: "operator",
        clientId: tenantId,
        about: { kind: "client", id: tenantId },
        source: "question",
        playKey: "hand_hard_ones",
        why: "Not answered in 4 business hours.",
        detail: (m.text ?? "").slice(0, 4000),
        dueAt: due,
        dedupeKey: `question:${m.id}`,
      });
      made += 1;
      await logPlay(tx, {
        clientId: tenantId,
        flow: "questions",
        stage: "all",
        play: "hand_hard_ones",
        level: may.level,
        outcome: "done",
        internal: true,
        about: { kind: "client", id: tenantId },
        summary: `Handed you a question from ${t.name}`,
      });
    }
    // Asked 3 times in 30 days: draft a knowledge entry (the operator writes it at draft level).
    const counts = new Map<string, { n: number; text: string; ids: string[] }>();
    for (const m of fromClient) {
      const k = normal(m.text ?? "");
      if (k.length < 8) continue;
      const c = counts.get(k) ?? { n: 0, text: m.text ?? "", ids: [] };
      c.n += 1;
      c.ids.push(m.id);
      counts.set(k, c);
    }
    for (const [k, c] of counts) {
      if (c.n < 3) continue;
      const may = await mayAct(tx, {
        flow: "questions",
        stage: "all",
        play: "draft_knowledge_entry",
        action: "draft",
      });
      if (may.allowed === "off") continue;
      await addTodo(tx, {
        title: `Add to ${t.name}'s knowledge: "${c.text.replace(/\s+/g, " ").slice(0, 100)}"`,
        owner: "operator",
        clientId: tenantId,
        about: { kind: "client", id: tenantId },
        source: "question",
        playKey: "draft_knowledge_entry",
        why: `Asked ${c.n} times in 30 days: so Sloan answers it next time.`,
        dedupeKey: `knowledge:${tenantId}:${k}`.slice(0, 500),
      });
    }
    return made;
  });
}

/** Hourly: every live client's questions. */
export async function questionsTick(db: Db, now: Date): Promise<void> {
  const clients = await db.select({ id: tenant.id }).from(tenant).where(isNull(tenant.retiredAt));
  for (const c of clients) {
    await questionsFor(db, c.id, now).catch((error: unknown) =>
      reportHandled("questions pass failed for a client", error, {
        job: "backoffice_questions",
        tenant: c.id,
      }),
    );
  }
}
