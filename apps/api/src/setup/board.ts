// The back office's Setup tab (docs/setup-plan.md §8; docs/plan.md §1.199, SU6): stream OPS. Each
// agent being set up by chapter with who it waits on, read from Getting started's own overview (as
// the client admin would see it), so the board and the client's page never disagree; the people
// waiting with when they were last here; the client's open change asks; the runbook (§8.1); Nudge,
// an email from the lead; and Do it on a call, the lead's answers to the open intake, sourced
// `call`, which count once the client says yes to them (owner, §1.199 q4). The lead can never
// connect a tool, sign the scope or fill a seat for the client (§8): none of that is here.

import {
  type BoardAgent,
  type BoardCell,
  type BoardWaiting,
  type CallAnswerBody,
  type ChapterProgress,
  checkAnswer,
  fieldFor,
  type GettingStartedView,
  notificationLink,
  type OpsSetupBoard,
  parseCoveredProcessors,
  type RunbookStep,
  readTenantGuide,
  runbook,
  SETUP_CHAPTERS,
  type SetupLeft,
} from "@countersign/core";
import {
  agent,
  agentChange,
  appUser,
  auditEvent,
  intake,
  intakeAnswer,
  intakeEvent,
  membership,
  notification,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError, notFound } from "../http";
import { mailerFromEnv } from "../notify/mailer";
import { originOf } from "../notify/outbox";
import { onboardingEmailRefusal } from "../onboarding/emails";
import {
  currentIntake,
  ensureOpen,
  loadIntake,
  progressOf,
  readIntake,
} from "../onboarding/intake";
import { openAsks } from "./asks";
import { shownVersion } from "./checklist";
import { gettingStarted, type OverviewInput, setupAgents } from "./overview";

const RUNBOOK_LABELS: Record<RunbookStep["key"], string> = {
  invite: "Invite sent",
  kickoff: "Kickoff call, 30 minutes: the walkthrough and a try",
  trial: "Scope signed, Start trial",
  checkin: "Trial check-in",
  live: "Sign-off and live",
};

const nameOf = (u: { name: string | null; email: string }) => u.name?.trim() || u.email;

/** "Connect Gmail and 2 more". */
function noteOf(lines: readonly SetupLeft[]): string | null {
  const [first] = lines;
  if (!first) return null;
  return lines.length === 1 ? first.label : `${first.label} and ${lines.length - 1} more`;
}

/** Who a chapter's lines wait on, by name ("Dana Ruiz, Mark Lee"). */
function waitingOnOf(lines: readonly SetupLeft[]): string | null {
  const names = [...new Set(lines.flatMap((l) => (l.who ? [l.who.name] : [])))];
  return names.length ? names.join(", ") : null;
}

/**
 * One agent's cell for a chapter, from its own lines and the chapter's state across the client.
 * The business chapter is the intake's, shared by every agent: with no question of the agent's
 * own left, the cell reads as the intake does.
 */
// DECISION: a chapter nobody has started yet reads "not started" on every agent; one that some
// agent has finished reads "done" on an agent with nothing left in it.
function cellOf(
  chapter: BoardCell["chapter"],
  lines: readonly SetupLeft[],
  client: ChapterProgress | undefined,
  intakeNote: string | null,
  admin: string | null,
): BoardCell {
  const mine = lines.filter((l) => l.chapter === chapter);
  if (mine.length) {
    return {
      chapter,
      state: client?.state === "not_started" ? "not_started" : "open",
      waitingOn: waitingOnOf(mine),
      note: noteOf(mine),
    };
  }
  if (chapter === "business" && client && client.state !== "done") {
    return {
      chapter,
      state: client.state,
      waitingOn: client.state === "not_needed" ? null : admin,
      note: client.state === "not_needed" ? null : intakeNote,
    };
  }
  if (!client || client.state === "not_needed")
    return { chapter, state: "not_needed", waitingOn: null, note: null };
  if (client.state === "not_started")
    return { chapter, state: "not_started", waitingOn: null, note: null };
  return { chapter, state: "done", waitingOn: null, note: null };
}

/** When the person was last here: their newest audited request at this client. */
async function lastSeen(tx: Tx, tenantId: string, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ at: auditEvent.createdAt })
    .from(auditEvent)
    .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.actorUserId, userId)))
    .orderBy(desc(auditEvent.createdAt))
    .limit(1);
  return row?.at.toISOString() ?? null;
}

export interface BoardInput {
  tenantId: string;
  now: Date;
  /** The platform's registry context, for the setup checklist's facts (as the portal reads them). */
  ctx?: OverviewInput["ctx"];
}

export async function setupBoard(tx: Tx, input: BoardInput): Promise<OpsSetupBoard> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
  if (!t) throw notFound("client");
  const admins = await tx
    .select({ userId: membership.userId, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, t.id), eq(membership.role, "client_admin")))
    .orderBy(asc(membership.createdAt));
  const admin = admins[0] ?? null;

  // Getting started as the client admin reads it, every agent being set up.
  const view: GettingStartedView = await gettingStarted(tx, {
    tenantId: t.id,
    userId: admin?.userId ?? "",
    sees: null,
    ...(input.ctx ? { ctx: input.ctx } : {}),
    now: input.now,
  });
  const rows = await setupAgents(tx, t.id, null);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chapters = new Map(view.chapters.map((c) => [c.key, c]));

  // The intake's cards, for the business chapter and the client admin's list.
  const [open] = await currentIntake(tx, t.id, input.now);
  let intakeNote: string | null = null;
  let intakeLeft: string | null = null;
  if (open) {
    const progress = progressOf(await loadIntake(tx, open));
    const done = progress.filter((p) => p.answered + p.notSure >= p.total).length;
    if (done < progress.length) {
      intakeNote = `${done} of ${progress.length} cards`;
      intakeLeft = `Answer the intake's cards (${done} of ${progress.length} done)`;
    }
  }
  const adminName = admin ? nameOf(admin) : null;

  const agents: BoardAgent[] = [];
  for (const a of view.agents) {
    const row = byId.get(a.agentId);
    const v = row ? await shownVersion(tx, row) : null;
    agents.push({
      agentId: a.agentId,
      name: a.name,
      stage: a.stage,
      version: v?.version ?? null,
      cells: SETUP_CHAPTERS.map((c) => cellOf(c, a.left, chapters.get(c), intakeNote, adminName)),
      holds: a.left.map((l) => (l.who ? `${l.label} (${l.who.name})` : l.label)),
    });
  }

  // Waiting on whom: every line by its person, the intake's cards with the client admin.
  const people = new Map<string, BoardWaiting>();
  const add = (userId: string | null, name: string, item: string) => {
    const key = userId ?? `name:${name}`;
    const w = people.get(key) ?? { userId, name, items: [], lastSeenAt: null };
    if (!w.items.includes(item)) w.items.push(item);
    people.set(key, w);
  };
  if (intakeLeft && admin) add(admin.userId, nameOf(admin), intakeLeft);
  for (const a of view.agents) {
    for (const l of a.left) {
      if (!l.who) continue;
      add(l.who.userId, l.who.name, view.agents.length > 1 ? `${a.name}: ${l.label}` : l.label);
    }
  }
  const waiting = [...people.values()];
  for (const w of waiting) {
    if (w.userId) w.lastSeenAt = await lastSeen(tx, t.id, w.userId);
  }

  const asks = (await openAsks(tx, { tenantId: t.id, agentIds: rows.map((r) => r.id) })).map(
    (o) => ({
      requestId: o.id,
      // DECISION: an ask (an idea) has no number; it reads 0 and opens Build, where asks are kept.
      number: o.number ?? 0,
      agentId: o.agentId,
      agentName: o.agentId
        ? (byId.get(o.agentId)?.serviceName ?? byId.get(o.agentId)?.name ?? null)
        : null,
      stepId: o.stepId,
      text: o.title === o.text ? o.text : `${o.title}: ${o.text}`,
      byName: o.raisedByName,
      at: o.at.toISOString(),
    }),
  );

  return {
    client: { id: t.id, name: t.name },
    agents,
    waiting,
    asks,
    runbook: await runbookOf(tx, t, view, input.now),
    intakeId: open?.id ?? null,
  };
}

/**
 * The runbook (§8.1) from what has happened: the invite is the client's newest intake (else the
 * client itself), the trial the first agent's, the go-live the first agent's move to live.
 */
async function runbookOf(
  tx: Tx,
  t: typeof tenant.$inferSelect,
  view: GettingStartedView,
  now: Date,
): Promise<RunbookStep[]> {
  const [newest] = await tx
    .select({ createdAt: intake.createdAt })
    .from(intake)
    .where(eq(intake.tenantId, t.id))
    .orderBy(desc(intake.createdAt))
    .limit(1);
  const invitedAt = (newest?.createdAt ?? t.createdAt).toISOString();
  const all = await tx
    .select({ id: agent.id, stageState: agent.stageState, testCopy: agent.testCopy })
    .from(agent)
    .where(and(eq(agent.tenantId, t.id), eq(agent.kind, "client")));
  const starts = all
    .filter((a) => !a.testCopy)
    .flatMap((a) => {
      const at = (a.stageState as { trial?: { startedAt?: unknown } } | null)?.trial?.startedAt;
      return typeof at === "string" ? [at] : [];
    })
    .sort();
  const [live] = await tx
    .select({ at: agentChange.createdAt })
    .from(agentChange)
    .where(
      and(
        eq(agentChange.tenantId, t.id),
        sql`${agentChange.change} ->> 'kind' = 'stage'`,
        sql`${agentChange.change} ->> 'to' = 'live'`,
      ),
    )
    .orderBy(asc(agentChange.createdAt))
    .limit(1);
  const trialStartedAt = starts[0] ?? null;
  const kickoffDone =
    trialStartedAt !== null ||
    view.chapters.some((c) => c.key !== "business" && c.state === "done" && c.total > 0);
  const steps = runbook(
    { invitedAt, trialStartedAt, liveAt: live?.at.toISOString() ?? null, now: now.toISOString() },
    kickoffDone,
  );
  const first = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({
    key: s.key,
    day: s.day,
    label: RUNBOOK_LABELS[s.key],
    at: s.at,
    state: s.done ? "done" : i === first ? "now" : "next",
  }));
}

// ── Nudge ──────────────────────────────────────────────────────────────────────────────────────

/** The calendar day of an instant in the client's time zone ("2026-11-22"). */
function dayIn(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export interface NudgeInput {
  tenantId: string;
  userId: string;
  by: string;
  now: Date;
  env: Bindings;
  ctx?: OverviewInput["ctx"];
}

/**
 * Owner: Nudge, an email from the lead listing what's left, at most once a day per person (in the
 * client's time zone), kept in `tenant.settings.setupGuide.nudges`. Written to the notifications
 * outbox as `intake_reminder`; the caller sends the queue after the commit.
 */
export async function nudge(
  tx: Tx,
  input: NudgeInput,
): Promise<{ sent: boolean; reason: string | null }> {
  const [m] = await tx
    .select({ role: membership.role })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, input.tenantId),
        eq(membership.userId, input.userId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    );
  if (!m) throw notFound("person");
  const board = await setupBoard(tx, {
    tenantId: input.tenantId,
    now: input.now,
    ...(input.ctx ? { ctx: input.ctx } : {}),
  });
  const items = board.waiting.find((w) => w.userId === input.userId)?.items ?? [];
  if (items.length === 0) return { sent: false, reason: "nothing_left" };

  const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
  if (!t) throw notFound("client");
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  const last = readTenantGuide(settings).nudges?.[input.userId];
  const today = dayIn(input.now, t.timezone);
  if (last && dayIn(new Date(last), t.timezone) === today) {
    return { sent: false, reason: "already_today" };
  }
  // HIPAA mode (§1.35, invariant 14): the email names the client and its person to Resend.
  if (onboardingEmailRefusal(settings, parseCoveredProcessors(input.env.BAA_PROCESSORS))) {
    return { sent: false, reason: "hipaa" };
  }
  if (!mailerFromEnv(input.env).isConfigured) return { sent: false, reason: "not_configured" };

  const [made] = await tx
    .insert(notification)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      contactId: null,
      channel: "email",
      kind: "intake_reminder",
      dedupeKey: `intake_reminder:${input.userId}:${today}`,
      link: notificationLink(originOf(input.env), "/start"),
      counts: { items: items.length },
      status: "queued",
      createdAt: input.now,
    })
    .onConflictDoNothing({
      target: [notification.tenantId, notification.channel, notification.dedupeKey],
    })
    .returning({ id: notification.id });
  if (!made) return { sent: false, reason: "already_today" };
  const at = input.now.toISOString();
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb), '{setupGuide}', coalesce(${tenant.settings} -> 'setupGuide', '{}'::jsonb) || jsonb_build_object(
        'nudges', coalesce(${tenant.settings} -> 'setupGuide' -> 'nudges', '{}'::jsonb) || jsonb_build_object(${input.userId}::text, ${at}::text),
        'nudgeItems', coalesce(${tenant.settings} -> 'setupGuide' -> 'nudgeItems', '{}'::jsonb) || jsonb_build_object(${input.userId}::text, ${JSON.stringify(items.slice(0, 30).map((i) => i.slice(0, 300)))}::jsonb)))`,
    })
    .where(eq(tenant.id, input.tenantId));
  return { sent: true, reason: null };
}

// ── Do it on a call ────────────────────────────────────────────────────────────────────────────

/**
 * The lead's answers on a call, sourced `call`, for the client to say yes to. Each is checked
 * against its field's kind as the client's own are (core `checkAnswer`). A tool is never connected
 * and no file added for the client: those fields are refused.
 */
export async function callAnswers(
  tx: Tx,
  input: { tenantIds: readonly string[]; intakeId: string; body: CallAnswerBody; by: string },
): Promise<number> {
  const row = await readIntake(tx, input.tenantIds, input.intakeId, true);
  ensureOpen(row);
  const d = await loadIntake(tx, row);
  const sections = d.guide.sections.map((s) => s.key);
  const values: (typeof intakeAnswer.$inferInsert)[] = [];
  for (const a of input.body.answers) {
    const field = fieldFor(d.guide, a.fieldKey, sections);
    if (!field || field.state === "known") {
      throw new HttpError(422, "unknown_field", `${a.fieldKey} isn't a question on this intake`);
    }
    // DECISION: the lead connects no tool and adds no document for the client on a call (§8).
    if (field.kind === "tool" || field.kind === "files") {
      throw new HttpError(
        422,
        "not_on_a_call",
        `${field.label}: the client does this themselves, from Getting started`,
      );
    }
    const checked = checkAnswer(field, a.value);
    if (!checked.ok) {
      throw new HttpError(422, "invalid_answer", `${field.label}: ${checked.message}`);
    }
    values.push({
      tenantId: row.tenantId,
      intakeId: row.id,
      fieldKey: field.key,
      value: checked.value,
      state: "answered",
      source: "call",
      userId: input.by,
    });
  }
  await tx.insert(intakeAnswer).values(values);
  await tx.insert(intakeEvent).values({
    tenantId: row.tenantId,
    intakeId: row.id,
    kind: "answered",
    personId: null,
    meta: { fields: values.map((v) => v.fieldKey), source: "call" },
  });
  return values.length;
}
