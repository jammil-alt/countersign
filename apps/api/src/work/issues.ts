// Issues (docs/plan.md §1.123.1; docs/cases-plan.md §3.2, B2–B4): a client's problem, numbered per
// client, with its conversation (a thread, `subject_type='issue'`), its history (`issue_event`,
// insert only), its targets and, on a critical one, the agent's safety hold. Raised from the
// portal, Sloan's pass_to_lead, Feedback, an error report, the back office, Reggie or email; old
// change requests are adopted (legacy.ts). Every function runs in the caller's transaction; RLS
// keeps each client's issues to itself (invariant 1).

import {
  type IssueDetail,
  type IssueEventView,
  type IssueMessageView,
  issueTargets,
  type OpsIssue,
  readReggieRead,
  standingOf,
  WORK_WORDS,
  type WorkUrgency,
} from "@countersign/core";
import {
  agent,
  appUser,
  clientAsk,
  issue,
  issueEvent,
  membership,
  message,
  type Tx,
  tenant,
  thread,
} from "@countersign/db";
import { leadDisplayName, leadOf, postMessage } from "@countersign/threads";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { clientBusinessHours } from "../hours/hours";
import { HttpError, iso, notFound } from "../http";
import { holdViews, placeHold } from "./holds";
import { closeTodosAbout, inOperatorTx, todosAbout } from "./todos-store";

export type IssueRow = typeof issue.$inferSelect;
export type IssueSource = IssueRow["source"];
export type EventActor = (typeof issueEvent.$inferInsert)["actor"];

export const ISSUE_SUBJECT = "issue";

const TITLE_MAX = 200;

/** A one-line title: the subject, else the first line of the text, clipped to 200. */
export function issueTitle(subject: string | null | undefined, text: string): string {
  const line = (subject?.trim() || text.split("\n").find((l) => l.trim()) || text).trim();
  const t = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
  return t || "Request";
}

async function clientHours(tx: Tx, tenantId: string) {
  const [t] = await tx
    .select({ timezone: tenant.timezone, settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return clientBusinessHours(t ?? { timezone: "UTC", settings: {} }).hours;
}

export interface CreateIssueInput {
  tenantId: string;
  title: string;
  description?: string;
  urgency?: WorkUrgency | undefined;
  agentId?: string | null;
  source: IssueSource;
  raisedBy?: string | null;
  raisedByEmail?: string | null;
  legacyItemId?: string | null;
  feedbackId?: string | null;
  originRunId?: string | null;
  actor: EventActor;
  /** The person acting (the raiser, or the operator). */
  userId: string | null;
  /** The opening message on its conversation, from the raiser (none from the back office). */
  openingText?: string | null;
  now?: Date;
}

/**
 * Opens an issue: the next number for the client (under a lock on the client), its thread, the
 * row with its targets, and its `created` event. A client's issue waits for Reggie's read
 * (`needs_read_at`). A critical issue about an agent puts that agent on a safety hold.
 */
export async function createIssue(tx: Tx, input: CreateIssueInput): Promise<IssueRow> {
  const now = input.now ?? new Date();
  const urgency = input.urgency ?? "normal";
  if (input.agentId) {
    const [a] = await tx
      .select({ id: agent.id })
      .from(agent)
      .where(
        and(
          eq(agent.id, input.agentId),
          eq(agent.tenantId, input.tenantId),
          eq(agent.kind, "client"),
        ),
      );
    if (!a) throw notFound("agent");
  }
  // DECISION: numbers are per client, from 1, with no cross-client count (§1.123); the lock keeps
  // two issues raised at once from taking the same number.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`issue:${input.tenantId}`}))`);
  const [max] = await tx
    .select({ n: sql<number>`coalesce(max(${issue.number}), 0)::int` })
    .from(issue)
    .where(eq(issue.tenantId, input.tenantId));
  const number = (max?.n ?? 0) + 1;
  const [th] = await tx
    .insert(thread)
    .values({
      tenantId: input.tenantId,
      subjectType: ISSUE_SUBJECT,
      title: `Request #${number}`,
      createdBy: input.raisedBy ?? null,
    })
    .returning();
  if (!th) throw new Error("thread insert returned nothing");
  const targets = issueTargets(urgency, now, await clientHours(tx, input.tenantId));
  const fromClient = input.actor === "client" || input.source === "email";
  const [row] = await tx
    .insert(issue)
    .values({
      tenantId: input.tenantId,
      number,
      title: issueTitle(input.title, input.description ?? ""),
      description: (input.description ?? "").slice(0, 4000),
      urgency,
      agentId: input.agentId ?? null,
      source: input.source,
      raisedBy: input.raisedBy ?? null,
      raisedByEmail: input.raisedByEmail ?? null,
      threadId: th.id,
      replyBy: targets.replyBy,
      fixBy: targets.fixBy,
      legacyItemId: input.legacyItemId ?? null,
      feedbackId: input.feedbackId ?? null,
      originRunId: input.originRunId ?? null,
      // Reggie's pass reads what a client raised (B2's pass picks these up).
      needsReadAt: fromClient ? now : null,
      stageAt: now,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("issue insert returned nothing");
  await tx
    .update(thread)
    .set({ subjectId: row.id })
    .where(and(eq(thread.id, th.id), eq(thread.tenantId, input.tenantId)));
  await tx.insert(issueEvent).values({
    tenantId: input.tenantId,
    issueId: row.id,
    kind: "created",
    toValue: "reported",
    actor: input.actor,
    userId: input.userId,
    payload: { source: input.source, urgency },
  });
  if (input.openingText?.trim()) {
    await postMessage(tx, {
      tenantId: input.tenantId,
      thread: th,
      senderType: input.raisedBy ? "user" : "system",
      senderId: input.raisedBy ?? null,
      kind: "text",
      body: { text: input.openingText.trim().slice(0, 4000) },
      sources: [],
      audience: "client",
    });
  }
  if (urgency === "critical" && row.agentId) {
    await placeHold(tx, {
      agentId: row.agentId,
      issueId: row.id,
      by: input.actor === "reggie" ? "reggie" : "operator",
      userId: input.actor === "operator" ? input.userId : null,
      reason: `Critical issue #${number}: ${row.title}`.slice(0, 500),
      now,
    });
  }
  return row;
}

/** The issue in the request's clients, locked when asked. */
export async function readIssue(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
  lock = false,
): Promise<IssueRow> {
  if (tenantIds.length === 0) throw notFound("issue");
  const q = tx
    .select()
    .from(issue)
    .where(and(eq(issue.id, id), inArray(issue.tenantId, [...tenantIds])));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("issue");
  return row;
}

export async function addIssueEvent(
  tx: Tx,
  row: Pick<IssueRow, "id" | "tenantId">,
  e: {
    kind: (typeof issueEvent.$inferInsert)["kind"];
    from?: string | null;
    to?: string | null;
    reason?: string | null;
    actor: EventActor;
    userId: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(issueEvent).values({
    tenantId: row.tenantId,
    issueId: row.id,
    kind: e.kind,
    fromValue: e.from ?? null,
    toValue: e.to ?? null,
    reason: e.reason ?? null,
    actor: e.actor,
    userId: e.userId,
    payload: e.payload ?? {},
  });
}

/** Whether the item is done in the work's sense (closed). */
export const issueDone = (r: Pick<IssueRow, "stage">) => r.stage === "closed";

export interface PostOnThread {
  tenantId: string;
  threadId: string;
  senderType: "user" | "agent" | "system";
  senderId: string | null;
  text: string;
  audience: "client" | "operator";
  sources?: readonly string[];
}

/** Posts on an issue's or ask's conversation. */
export async function postOnThread(tx: Tx, p: PostOnThread) {
  const [th] = await tx
    .select()
    .from(thread)
    .where(and(eq(thread.id, p.threadId), eq(thread.tenantId, p.tenantId)));
  if (!th) throw notFound("conversation");
  return postMessage(tx, {
    tenantId: p.tenantId,
    thread: th,
    senderType: p.senderType,
    senderId: p.senderId,
    kind: "text",
    body: { text: p.text },
    sources: [...(p.sources ?? [])],
    audience: p.audience,
  });
}

/**
 * The operator's message on an issue: a reply to the client (the first sets `first_reply_at`,
 * writes a `reply` event and closes the to-dos to tell the client) or an internal note, which
 * stays in the back office.
 */
export async function operatorMessage(
  tx: Tx,
  row: IssueRow,
  input: {
    userId: string;
    text: string;
    audience: "client" | "operator";
    sources?: readonly string[];
  },
): Promise<void> {
  const posted = await postOnThread(tx, {
    tenantId: row.tenantId,
    threadId: row.threadId,
    senderType: "user",
    senderId: input.userId,
    text: input.text,
    audience: input.audience,
    sources: input.sources ?? [],
  });
  if (input.audience === "operator") {
    await addIssueEvent(tx, row, {
      kind: "note",
      actor: "operator",
      userId: input.userId,
      payload: { messageId: posted.id },
    });
    return;
  }
  await addIssueEvent(tx, row, {
    kind: "reply",
    actor: "operator",
    userId: input.userId,
    payload: { messageId: posted.id },
  });
  await tx
    .update(issue)
    .set({ firstReplyAt: row.firstReplyAt ?? new Date() })
    .where(and(eq(issue.id, row.id), eq(issue.tenantId, row.tenantId)));
  if (await inOperatorTx(tx)) {
    await closeTodosAbout(tx, "issue", row.id, input.userId, { titlePrefix: "Tell " });
    await closeTodosAbout(tx, "issue", row.id, input.userId, { titlePrefix: "First reply" });
  }
}

/** Closes the issue, with the note to the client when there is one. */
export async function closeIssue(
  tx: Tx,
  row: IssueRow,
  input: { note?: string | undefined; actor: EventActor; userId: string | null },
): Promise<void> {
  if (row.stage === "closed") throw new HttpError(409, "already_closed", "this issue is closed");
  if (row.causeKind === "not_a_bug" && !input.note?.trim() && input.actor === "operator") {
    throw new HttpError(422, "note_required", "say why it isn't a bug: the client reads it");
  }
  const now = new Date();
  if (input.note?.trim()) {
    await postOnThread(tx, {
      tenantId: row.tenantId,
      threadId: row.threadId,
      senderType: "user",
      senderId: input.userId,
      text: input.note.trim(),
      audience: "client",
    });
  }
  await tx
    .update(issue)
    .set({
      stage: "closed",
      closedAt: now,
      stageAt: now,
      waitingOn: "operator",
      stuck: false,
      needsReadAt: null,
    })
    .where(and(eq(issue.id, row.id), eq(issue.tenantId, row.tenantId)));
  await addIssueEvent(tx, row, {
    kind: "close",
    from: row.stage,
    to: "closed",
    reason: input.note ?? null,
    actor: input.actor,
    userId: input.userId,
  });
  if (await inOperatorTx(tx)) await closeTodosAbout(tx, "issue", row.id, input.userId);
}

/** Opens a closed (or verifying) issue again, back at the fix. */
export async function reopenIssue(
  tx: Tx,
  row: IssueRow,
  input: { actor: EventActor; userId: string | null; stage?: "reported" | "fix" },
): Promise<void> {
  const to = input.stage ?? "fix";
  const now = new Date();
  await tx
    .update(issue)
    .set({
      stage: to,
      closedAt: null,
      stageAt: now,
      waitingOn: "operator",
      ...(input.actor === "client" ? { needsReadAt: now } : {}),
    })
    .where(and(eq(issue.id, row.id), eq(issue.tenantId, row.tenantId)));
  await addIssueEvent(tx, row, {
    kind: "reopen",
    from: row.stage,
    to,
    actor: input.actor,
    userId: input.userId,
  });
}

/** "It isn't a fault": the issue becomes an ask on the client's list, and closes. */
export async function convertToAsk(tx: Tx, row: IssueRow, userId: string): Promise<string> {
  if (row.askId) return row.askId;
  const [th] = await tx
    .insert(thread)
    .values({
      tenantId: row.tenantId,
      subjectType: "client_ask",
      title: row.title,
      createdBy: row.raisedBy,
    })
    .returning();
  if (!th) throw new Error("thread insert returned nothing");
  const [ask] = await tx
    .insert(clientAsk)
    .values({
      tenantId: row.tenantId,
      title: row.title,
      text: row.description.trim() || row.title,
      source: row.source,
      raisedBy: row.raisedBy,
      raisedByEmail: row.raisedByEmail,
      agentId: row.agentId,
      threadId: th.id,
      issueId: row.id,
    })
    .returning();
  if (!ask) throw new Error("ask insert returned nothing");
  await tx
    .update(thread)
    .set({ subjectId: ask.id })
    .where(and(eq(thread.id, th.id), eq(thread.tenantId, row.tenantId)));
  await postOnThread(tx, {
    tenantId: row.tenantId,
    threadId: row.threadId,
    senderType: "user",
    senderId: userId,
    text: WORK_WORDS.convertedToAsk,
    audience: "client",
  });
  const now = new Date();
  await tx
    .update(issue)
    .set({
      askId: ask.id,
      causeKind: "not_a_bug",
      stage: "closed",
      closedAt: now,
      stageAt: now,
      needsReadAt: null,
    })
    .where(and(eq(issue.id, row.id), eq(issue.tenantId, row.tenantId)));
  await addIssueEvent(tx, row, {
    kind: "converted",
    from: row.stage,
    to: "closed",
    actor: "operator",
    userId,
    payload: { askId: ask.id },
  });
  if (await inOperatorTx(tx)) await closeTodosAbout(tx, "issue", row.id, userId);
  return ask.id;
}

// ── Views ────────────────────────────────────────────────────────────────────────────────────────

export async function userNames(tx: Tx, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  for (const u of await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, wanted))) {
    out.set(u.id, u.name?.trim() || u.email);
  }
  return out;
}

/** Of the users, those who are operators of the client. */
export async function operatorsOf(tx: Tx, tenantId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (wanted.length === 0) return new Set<string>();
  const rows = await tx
    .select({ userId: membership.userId })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, tenantId),
        eq(membership.role, "operator"),
        inArray(membership.userId, wanted),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

export type MessageRow = typeof message.$inferSelect;

export async function threadMessages(
  tx: Tx,
  tenantId: string,
  threadId: string,
  audiences: ("client" | "operator")[],
) {
  return tx
    .select()
    .from(message)
    .where(
      and(
        eq(message.tenantId, tenantId),
        eq(message.threadId, threadId),
        inArray(message.audience, audiences),
      ),
    )
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(500);
}

const textOf = (m: Pick<MessageRow, "body">) => {
  const t = (m.body as { text?: unknown } | null)?.text;
  return typeof t === "string" ? t : "";
};

/** The conversation as the back office reads it (notes included), oldest first. */
export async function opsMessages(
  tx: Tx,
  tenantId: string,
  threadId: string,
): Promise<IssueMessageView[]> {
  const rows = await threadMessages(tx, tenantId, threadId, ["client", "operator"]);
  const names = await userNames(
    tx,
    rows.map((r) => r.senderId),
  );
  const ops = await operatorsOf(
    tx,
    tenantId,
    rows.map((r) => r.senderId),
  );
  return rows.map((m) => {
    const kind =
      m.senderType === "system"
        ? ("system" as const)
        : m.senderType === "agent"
          ? ("reggie" as const)
          : m.senderId && ops.has(m.senderId)
            ? ("operator" as const)
            : ("client" as const);
    const name =
      kind === "system"
        ? "Mezonas"
        : kind === "reggie"
          ? "Reggie"
          : (m.senderId && names.get(m.senderId)) || "Someone";
    return {
      id: m.id,
      at: m.createdAt.toISOString(),
      audience: m.audience,
      who: { kind, name },
      text: textOf(m),
      sources: Array.isArray(m.sources) ? m.sources : [],
    };
  });
}

export function issueStanding(r: IssueRow, held: boolean) {
  return standingOf({ doneish: issueDone(r), waitingOn: r.waitingOn, stuck: r.stuck, held });
}

export async function opsIssue(tx: Tx, r: IssueRow): Promise<OpsIssue> {
  const [client] = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, r.tenantId));
  const [a] = r.agentId
    ? await tx
        .select({
          id: agent.id,
          name: agent.name,
          serviceName: agent.serviceName,
          hold: agent.hold,
        })
        .from(agent)
        .where(and(eq(agent.id, r.agentId), eq(agent.tenantId, r.tenantId)))
    : [];
  const names = await userNames(tx, [r.raisedBy]);
  const held = !!a?.hold && (a.hold as { issueId?: string }).issueId === r.id;
  return {
    id: r.id,
    number: r.number,
    client: client ?? { id: r.tenantId, name: "" },
    title: r.title,
    description: r.description,
    urgency: r.urgency,
    stage: r.stage,
    causeKind: r.causeKind ?? null,
    agent: a ? { id: a.id, name: a.serviceName ?? a.name } : null,
    source: r.source,
    raisedBy:
      r.raisedBy || r.raisedByEmail
        ? { id: r.raisedBy, name: (r.raisedBy && names.get(r.raisedBy)) || r.raisedByEmail || "" }
        : null,
    waitingOn: r.waitingOn,
    statusLine: r.statusLine,
    stuck: r.stuck,
    standing: issueStanding(r, held),
    replyBy: iso(r.replyBy),
    fixBy: iso(r.fixBy),
    firstReplyAt: iso(r.firstReplyAt),
    reggieRead: readReggieRead(r.reggieRead),
    askId: r.askId ?? null,
    createdAt: r.createdAt.toISOString(),
    stageAt: r.stageAt.toISOString(),
    closedAt: iso(r.closedAt),
  };
}

export async function issueDetail(tx: Tx, r: IssueRow): Promise<IssueDetail> {
  const events = await tx
    .select()
    .from(issueEvent)
    .where(and(eq(issueEvent.tenantId, r.tenantId), eq(issueEvent.issueId, r.id)))
    .orderBy(asc(issueEvent.createdAt), asc(issueEvent.id))
    .limit(500);
  const names = await userNames(
    tx,
    events.map((e) => e.userId),
  );
  const holds = r.agentId ? await holdViews(tx, [r.tenantId], { agentId: r.agentId }) : [];
  return {
    issue: await opsIssue(tx, r),
    messages: await opsMessages(tx, r.tenantId, r.threadId),
    events: events.map(
      (e): IssueEventView => ({
        id: e.id,
        kind: e.kind,
        from: e.fromValue,
        to: e.toValue,
        reason: e.reason,
        actor: e.actor,
        who: e.userId ? (names.get(e.userId) ?? null) : e.actor === "reggie" ? "Reggie" : null,
        at: e.createdAt.toISOString(),
      }),
    ),
    todos: (await inOperatorTx(tx)) ? await todosAbout(tx, "issue", r.id) : [],
    hold: holds[0] ?? null,
  };
}

/** The name the client reads for anyone at Mezonas: the lead's name, else "Your Mezonas lead". */
export async function leadNameFor(tx: Tx, tenantId: string): Promise<string> {
  const lead = await leadOf(tx, tenantId);
  return lead ? leadDisplayName(lead) : "Your Mezonas lead";
}
