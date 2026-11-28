// The back office's cron work (docs/plan.md §1.124.4), one line in `runCron`: every minute Reggie's
// read pass and the email replies on issues that came by email; hourly the chases and the
// questions; nightly expansion spotting. Each part's failure is reported and the rest go on.

import { type Processor, readRequirements } from "@countersign/core";
import { activeClient, build, type Db, playLog, tenant, todo, withOperator } from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import { leadOf, leadThread, postMessage } from "@countersign/threads";
import { and, eq, gte, isNotNull, ne } from "drizzle-orm";
import type { Mailer } from "../notify/mailer";
import { reportHandled } from "../observability/report";
import { logPlay } from "../work/play-log";
import { addTodo } from "../work/todos-store";
import { mayAct } from "./autopilot";
import { sendIssueEmails } from "./outbound-email";
import { questionsTick } from "./questions";
import { readPending } from "./reggie-pass";
import { spottingTick } from "./spotting";

// DECISION: the hourly back office passes (chases, questions) run at minute 37, clear of the
// usage sweep and the legacy adoption.
export const BACKOFFICE_HOURLY_MINUTE = 37;
const DAY = 24 * 60 * 60 * 1000;

export interface BackOfficeDeps {
  db: Db;
  transport: LlmTransport | null;
  mailer: Mailer;
  domain: string | null | undefined;
  /** The processors with a BAA (`BAA_PROCESSORS`). */
  covered: ReadonlySet<Processor>;
}

/**
 * Requirements requests: a reminder 2 days before the due date and on it, at the play's level (a
 * to-do for the operator at draft; a message from the lead at send). Once per build and day.
 */
export async function chaseRequirements(db: Db, now: Date): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const inTwo = new Date(now.getTime() + 2 * DAY).toISOString().slice(0, 10);
  const clients = await db.select({ id: tenant.id }).from(tenant).where(activeClient());
  if (clients.length === 0) return 0;
  const rows = await withOperator(
    db,
    clients.map((c) => c.id),
    (tx) =>
      tx
        .select({
          id: build.id,
          title: build.title,
          clientId: build.clientId,
          requirements: build.requirements,
        })
        .from(build)
        .where(
          and(isNotNull(build.requirements), isNotNull(build.clientId), ne(build.status, "live")),
        ),
  );
  let chased = 0;
  for (const b of rows) {
    const req = readRequirements(b.requirements);
    const clientId = b.clientId as string;
    if (!req || req.answered >= req.total || (req.dueOn !== today && req.dueOn !== inTwo)) continue;
    try {
      await withOperator(db, [clientId], async (tx) => {
        const may = await mayAct(tx, {
          flow: "builds",
          stage: "requirements",
          play: "chase_requirements",
          action: "send",
        });
        if (may.allowed === "off") return;
        const left = req.total - req.answered;
        const text = `A reminder: ${left} of ${req.total} answers for "${b.title}" are still open, due ${req.dueOn}. They're on your Desk.`;
        const key = `chase:req:${b.id}:${today}`;
        // Once a day: a send today, or its to-do, is enough.
        const [sentToday] = await tx
          .select({ id: playLog.id })
          .from(playLog)
          .where(
            and(
              eq(playLog.aboutId, b.id),
              eq(playLog.play, "chase_requirements"),
              gte(playLog.createdAt, new Date(`${today}T00:00:00Z`)),
            ),
          );
        if (sentToday) return;
        const lead = may.allowed === "send" ? await leadOf(tx, clientId) : null;
        if (may.allowed === "send" && lead) {
          const th = await leadThread(tx, clientId);
          await postMessage(tx, {
            tenantId: clientId,
            thread: th,
            senderType: "user",
            senderId: lead.userId,
            kind: "text",
            body: { text },
            sources: [],
            audience: "client",
          });
          await logPlay(tx, {
            clientId,
            flow: "builds",
            stage: "requirements",
            play: "chase_requirements",
            level: may.level,
            outcome: "sent",
            about: { kind: "build", id: b.id },
            summary: `Chased the requirements for ${b.title}`,
          });
        } else {
          const [had] = await tx.select({ id: todo.id }).from(todo).where(eq(todo.dedupeKey, key));
          if (had) return;
          await addTodo(tx, {
            title: `Chase the requirements for ${b.title}`,
            owner: "operator",
            clientId,
            about: { kind: "build", id: b.id },
            source: "play",
            playKey: "chase_requirements",
            why: `${left} of ${req.total} answers open; due ${req.dueOn}.`,
            dueAt: new Date(`${req.dueOn}T17:00:00Z`),
            draft: { to: "client", channel: "portal", text },
            primaryAction: { label: "Send", kind: "send_reply", ref: { buildId: b.id } },
            dedupeKey: key,
          });
          await logPlay(tx, {
            clientId,
            flow: "builds",
            stage: "requirements",
            play: "chase_requirements",
            level: may.level,
            outcome: "drafted",
            about: { kind: "build", id: b.id },
            summary: `Drafted a chase for ${b.title}`,
          });
        }
        chased += 1;
      });
    } catch (error) {
      reportHandled("chasing requirements failed", error, {
        job: "backoffice_chase",
        tenant: clientId,
      });
    }
  }
  return chased;
}

export async function backOfficeTick(deps: BackOfficeDeps, at: Date): Promise<void> {
  await readPending({
    db: deps.db,
    transport: deps.transport,
    covered: deps.covered,
    now: () => at,
  }).catch((error: unknown) =>
    reportHandled("Reggie's read pass failed", error, { job: "reggie_read" }),
  );
  await sendIssueEmails(deps.db, deps.mailer, deps.domain, at, deps.covered).catch(
    (error: unknown) => reportHandled("issue emails failed", error, { job: "backoffice_email" }),
  );
  if (at.getUTCMinutes() === BACKOFFICE_HOURLY_MINUTE) {
    await chaseRequirements(deps.db, at).catch((error: unknown) =>
      reportHandled("chases failed", error, { job: "backoffice_chase" }),
    );
    await questionsTick(deps.db, at).catch((error: unknown) =>
      reportHandled("questions failed", error, { job: "backoffice_questions" }),
    );
  }
  await spottingTick(deps.db, at).catch((error: unknown) =>
    reportHandled("expansion spotting failed", error, { job: "backoffice_spotting" }),
  );
}
