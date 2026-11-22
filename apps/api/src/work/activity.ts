// A client's activity on its page in the back office (docs/plan.md §1.124.3; docs/cases-plan.md
// T1), read across the tables that keep it and never copied: messages on the lead's, issues' and
// asks' conversations (notes marked as ours), questions in the client's account conversations with
// the time to Sloan's answer, runs, and decisions and changes (issue history, the client's deals'
// activity, setting and agent changes, writes signed or turned down). Operator only: it runs in
// the operator's transaction, and the route checks the client is served.

import {
  ACTIVITY_PAGE,
  type ActivityFilter,
  type ActivityItem,
  type ClientActivity,
} from "@countersign/core";
import {
  agent,
  agentChange,
  appUser,
  deal,
  dealActivity,
  externalAction,
  issue,
  issueEvent,
  membership,
  message,
  run,
  type Tx,
  tenantChange,
  thread,
} from "@countersign/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

type Part = Omit<ActivityItem, "at"> & { at: Date };

const SUBJECT_LABEL: Record<string, string> = {
  lead: "Lead thread",
  issue: "Request",
  client_ask: "Ask",
};

const textOf = (body: unknown): string => {
  const t = (body as { text?: unknown } | null)?.text;
  return typeof t === "string" ? t : "";
};

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * G10: a setup checklist item or a client adjustment in words, for the back office's change list:
 * "Setup checklist: "Your vendor list" sent (by the client)." Null for any other change, and for
 * rows logged before they carried a label (they read as the change's kind, as before).
 */
export function setupChangeWords(change: unknown): string | null {
  const c = (change ?? {}) as Record<string, unknown>;
  const label = typeof c.label === "string" ? c.label : null;
  if (!label) return null;
  const side = c.side === "client" ? " (by the client)" : c.side === "operator" ? " (by us)" : "";
  if (c.kind === "setup") {
    if (c.done === false) return `Setup checklist: "${label}" taken back${side}.`;
    const verb =
      c.itemKind === "file" ? "sent" : c.itemKind === "confirm" ? "confirmed" : "answered";
    return `Setup checklist: "${label}" ${verb}${side}.`;
  }
  if (c.kind === "adjust") {
    const value = typeof c.value === "string" ? ` ${c.value}` : "";
    return c.outcome === "requested"
      ? `Asked to change "${label}" to${value}, past its limits: a request to us.`
      : `"${label}" changed to${value}${side}.`;
  }
  return null;
}

const RUN_WORDS: Record<string, string> = {
  queued: "queued",
  running: "started",
  waiting: "is waiting on a person",
  succeeded: "finished",
  failed: "failed",
  cancelled: "was cancelled",
};

const EVENT_WORDS: Record<string, string> = {
  created: "Opened",
  stage: "Moved",
  urgency: "Urgency changed",
  cause: "Cause set",
  hold: "Safety hold placed",
  release: "Safety hold released",
  rollback: "Rolled back",
  close: "Closed",
  reopen: "Reopened",
  converted: "Made an ask",
  assign: "Assigned",
  moved: "Moved in the work order",
};

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** The people of this client by id: whose words are the client's. */
async function people(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email, role: membership.role })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(eq(membership.tenantId, tenantId));
  return new Map(
    rows.map((r) => [r.id, { name: r.name ?? r.email, client: r.role !== "operator" }]),
  );
}

async function userNames(tx: Tx, ids: (string | null)[]) {
  const want = [...new Set(ids.filter((v): v is string => !!v))];
  if (!want.length) return new Map<string, string>();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, want));
  return new Map(rows.map((r) => [r.id, r.name ?? r.email]));
}

async function messages(tx: Tx, tenantId: string, before: Date): Promise<Part[]> {
  const rows = await tx
    .select({
      id: message.id,
      senderType: message.senderType,
      senderId: message.senderId,
      body: message.body,
      audience: message.audience,
      createdAt: message.createdAt,
      subjectType: thread.subjectType,
      subjectId: thread.subjectId,
    })
    .from(message)
    .innerJoin(thread, and(eq(thread.id, message.threadId), eq(thread.tenantId, message.tenantId)))
    .where(
      and(
        eq(message.tenantId, tenantId),
        inArray(thread.subjectType, ["lead", "issue", "client_ask"]),
        lt(message.createdAt, before),
      ),
    )
    .orderBy(desc(message.createdAt))
    .limit(ACTIVITY_PAGE + 1);
  const who = await people(tx, tenantId);
  const others = await userNames(
    tx,
    rows.map((r) => (r.senderId && !who.has(r.senderId) ? r.senderId : null)),
  );
  const issueIds = rows
    .filter((r) => r.subjectType === "issue" && r.subjectId)
    .map((r) => r.subjectId as string);
  const numbers = new Map<string, number>();
  if (issueIds.length) {
    for (const r of await tx
      .select({ id: issue.id, number: issue.number })
      .from(issue)
      .where(and(eq(issue.tenantId, tenantId), inArray(issue.id, [...new Set(issueIds)])))) {
      numbers.set(r.id, r.number);
    }
  }
  return rows.map((r) => {
    const person = r.senderId ? who.get(r.senderId) : undefined;
    const fromClient = r.senderType === "contact" || (r.senderType === "user" && !!person?.client);
    const note = r.audience === "operator";
    const name =
      r.senderType === "agent"
        ? "Agent"
        : r.senderType === "system"
          ? null
          : (person?.name ?? (r.senderId ? others.get(r.senderId) : null) ?? "Someone");
    const label =
      r.subjectType === "issue" && r.subjectId && numbers.has(r.subjectId)
        ? `Request #${numbers.get(r.subjectId)}`
        : (SUBJECT_LABEL[r.subjectType ?? ""] ?? "Conversation");
    return {
      id: `m:${r.id}`,
      kind: note ? "note" : r.senderType === "system" ? "sys" : fromClient ? "in" : "out",
      filter: "messages",
      at: r.createdAt,
      who: name,
      agent: r.senderType === "agent",
      channel: note ? "Internal note" : "Portal",
      text: clip(textOf(r.body)),
      answer: null,
      link:
        r.subjectType === "issue" && r.subjectId
          ? { href: `/ops/issues/${r.subjectId}`, label }
          : null,
    } satisfies Part;
  });
}

async function questions(tx: Tx, tenantId: string, before: Date): Promise<Part[]> {
  const answeredAt = sql<Date | null>`(select a.created_at from ${message} a
    where a.thread_id = ${message.threadId} and a.tenant_id = ${message.tenantId}
      and a.sender_type = 'agent' and a.created_at > ${message.createdAt}
    order by a.created_at limit 1)`;
  const rows = await tx
    .select({
      id: message.id,
      senderId: message.senderId,
      body: message.body,
      createdAt: message.createdAt,
      answeredAt,
    })
    .from(message)
    .innerJoin(thread, and(eq(thread.id, message.threadId), eq(thread.tenantId, message.tenantId)))
    .where(
      and(
        eq(message.tenantId, tenantId),
        eq(thread.subjectType, "account"),
        eq(message.senderType, "user"),
        lt(message.createdAt, before),
      ),
    )
    .orderBy(desc(message.createdAt))
    .limit(ACTIVITY_PAGE + 1);
  const who = await people(tx, tenantId);
  return rows.map((r) => {
    const answered = r.answeredAt ? new Date(r.answeredAt) : null;
    return {
      id: `q:${r.id}`,
      kind: "q",
      filter: "questions",
      at: r.createdAt,
      who: (r.senderId && who.get(r.senderId)?.name) || "Someone",
      agent: false,
      channel: "Portal",
      text: clip(textOf(r.body)),
      answer: answered
        ? `Answered by Sloan in ${minutes(answered.getTime() - r.createdAt.getTime())} min`
        : "Not answered yet",
      link: null,
    } satisfies Part;
  });
}

async function runs(tx: Tx, tenantId: string, before: Date): Promise<Part[]> {
  const at = sql<Date>`coalesce(${run.finishedAt}, ${run.startedAt}, ${run.createdAt})`;
  const rows = await tx
    .select({
      id: run.id,
      status: run.status,
      at,
      agentName: sql<string>`coalesce(${agent.serviceName}, ${agent.name})`,
    })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .where(and(eq(run.tenantId, tenantId), eq(run.mode, "live"), lt(at, before)))
    .orderBy(desc(at))
    .limit(ACTIVITY_PAGE + 1);
  return rows.map((r) => ({
    id: `r:${r.id}`,
    kind: "run",
    filter: "runs",
    at: new Date(r.at),
    who: r.agentName,
    agent: true,
    channel: null,
    text: `Run ${r.id.slice(-6).toUpperCase()} ${RUN_WORDS[r.status] ?? r.status}.`,
    answer: null,
    link: { href: `/ops/runs/${r.id}`, label: "Run" },
  }));
}

async function decisions(tx: Tx, tenantId: string, before: Date): Promise<Part[]> {
  const out: Part[] = [];
  const events = await tx
    .select({
      id: issueEvent.id,
      kind: issueEvent.kind,
      from: issueEvent.fromValue,
      to: issueEvent.toValue,
      reason: issueEvent.reason,
      actor: issueEvent.actor,
      userId: issueEvent.userId,
      createdAt: issueEvent.createdAt,
      issueId: issueEvent.issueId,
      number: issue.number,
      title: issue.title,
    })
    .from(issueEvent)
    .innerJoin(
      issue,
      and(eq(issue.id, issueEvent.issueId), eq(issue.tenantId, issueEvent.tenantId)),
    )
    .where(
      and(
        eq(issueEvent.tenantId, tenantId),
        inArray(issueEvent.kind, Object.keys(EVENT_WORDS) as never[]),
        lt(issueEvent.createdAt, before),
      ),
    )
    .orderBy(desc(issueEvent.createdAt))
    .limit(ACTIVITY_PAGE + 1);
  const deals = await tx
    .select({
      id: dealActivity.id,
      kind: dealActivity.kind,
      actor: dealActivity.actor,
      userId: dealActivity.userId,
      body: dealActivity.body,
      createdAt: dealActivity.createdAt,
      dealId: dealActivity.dealId,
      title: deal.title,
    })
    .from(dealActivity)
    .innerJoin(deal, eq(deal.id, dealActivity.dealId))
    .where(
      and(
        eq(deal.clientId, tenantId),
        inArray(dealActivity.kind, ["stage", "system", "terms", "note", "call", "meeting"]),
        lt(dealActivity.createdAt, before),
      ),
    )
    .orderBy(desc(dealActivity.createdAt))
    .limit(ACTIVITY_PAGE + 1);
  const settings = await tx
    .select({
      id: tenantChange.id,
      actorId: tenantChange.actorId,
      reason: tenantChange.reason,
      createdAt: tenantChange.createdAt,
    })
    .from(tenantChange)
    .where(and(eq(tenantChange.tenantId, tenantId), lt(tenantChange.createdAt, before)))
    .orderBy(desc(tenantChange.createdAt))
    .limit(ACTIVITY_PAGE + 1);
  const agents = await tx
    .select({
      id: agentChange.id,
      actorId: agentChange.actorId,
      change: agentChange.change,
      createdAt: agentChange.createdAt,
      agentName: sql<string>`coalesce(${agent.serviceName}, ${agent.name})`,
    })
    .from(agentChange)
    .innerJoin(agent, eq(agent.id, agentChange.agentId))
    .where(and(eq(agentChange.tenantId, tenantId), lt(agentChange.createdAt, before)))
    .orderBy(desc(agentChange.createdAt))
    .limit(ACTIVITY_PAGE + 1);
  const writes = await tx
    .select({
      id: externalAction.id,
      tool: externalAction.tool,
      status: externalAction.status,
      approvedBy: externalAction.approvedBy,
      at: sql<Date>`coalesce(${externalAction.approvedAt}, ${externalAction.createdAt})`,
    })
    .from(externalAction)
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        inArray(externalAction.status, ["approved", "rejected", "done"]),
        sql`${externalAction.approvedBy} is not null`,
        lt(sql`coalesce(${externalAction.approvedAt}, ${externalAction.createdAt})`, before),
      ),
    )
    .orderBy(desc(sql`coalesce(${externalAction.approvedAt}, ${externalAction.createdAt})`))
    .limit(ACTIVITY_PAGE + 1);
  const names = await userNames(tx, [
    ...events.map((e) => e.userId),
    ...deals.map((d) => d.userId),
    ...settings.map((s) => s.actorId),
    ...agents.map((a) => a.actorId),
    ...writes.map((w) => w.approvedBy),
  ]);

  for (const e of events) {
    const change = e.from && e.to ? `: ${e.from} to ${e.to}` : e.to ? `: ${e.to}` : "";
    out.push({
      id: `e:${e.id}`,
      kind: "sys",
      filter: "decisions",
      at: e.createdAt,
      who: e.actor === "reggie" ? "Reggie" : e.userId ? (names.get(e.userId) ?? null) : null,
      agent: e.actor === "reggie",
      channel: null,
      text: `${EVENT_WORDS[e.kind] ?? e.kind}${change}. Request #${e.number}, ${e.title}.${e.reason ? ` ${e.reason}` : ""}`,
      answer: null,
      link: { href: `/ops/issues/${e.issueId}`, label: `Request #${e.number}` },
    });
  }
  for (const d of deals) {
    out.push({
      id: `d:${d.id}`,
      kind: d.kind === "note" || d.kind === "call" || d.kind === "meeting" ? "note" : "sys",
      filter: "decisions",
      at: d.createdAt,
      who: d.actor === "reggie" ? "Reggie" : d.userId ? (names.get(d.userId) ?? null) : null,
      agent: d.actor === "reggie",
      channel: null,
      text: clip(`${d.title}: ${d.body}`),
      answer: null,
      link: { href: `/ops/deals/${d.dealId}`, label: "Deal" },
    });
  }
  for (const s of settings) {
    out.push({
      id: `t:${s.id}`,
      kind: "sys",
      filter: "decisions",
      at: s.createdAt,
      who: s.actorId ? (names.get(s.actorId) ?? null) : null,
      agent: false,
      channel: null,
      text: clip(`Setting changed: ${s.reason}`),
      answer: null,
      link: null,
    });
  }
  for (const a of agents) {
    const kind = (a.change as { kind?: unknown; type?: unknown } | null) ?? {};
    const what =
      typeof kind.kind === "string"
        ? kind.kind
        : typeof kind.type === "string"
          ? kind.type
          : "a change";
    const words = setupChangeWords(a.change);
    out.push({
      id: `a:${a.id}`,
      kind: "sys",
      filter: "decisions",
      at: a.createdAt,
      who: a.actorId ? (names.get(a.actorId) ?? null) : null,
      agent: false,
      channel: null,
      text: clip(`${a.agentName}: ${words ?? `${what.replace(/_/g, " ")}.`}`),
      answer: null,
      link: null,
    });
  }
  for (const w of writes) {
    out.push({
      id: `x:${w.id}`,
      kind: "sys",
      filter: "decisions",
      at: new Date(w.at),
      who: w.approvedBy ? (names.get(w.approvedBy) ?? null) : null,
      agent: false,
      channel: null,
      text: `${w.status === "rejected" ? "Turned down" : "Signed"}: ${w.tool.replace(/[._]/g, " ")}.`,
      answer: null,
      link: null,
    });
  }
  return out;
}

/** One page of a client's activity, newest first. */
export async function clientActivity(
  tx: Tx,
  tenantId: string,
  filter: ActivityFilter,
  before: Date = new Date(Date.now() + 60_000),
): Promise<ClientActivity> {
  const parts: Part[] = [];
  if (filter === "all" || filter === "messages")
    parts.push(...(await messages(tx, tenantId, before)));
  if (filter === "all" || filter === "questions")
    parts.push(...(await questions(tx, tenantId, before)));
  if (filter === "all" || filter === "runs") parts.push(...(await runs(tx, tenantId, before)));
  if (filter === "all" || filter === "decisions")
    parts.push(...(await decisions(tx, tenantId, before)));
  parts.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1));
  const page = parts.slice(0, ACTIVITY_PAGE);
  const more = parts.length > ACTIVITY_PAGE;
  return {
    items: page.map((p) => ({ ...p, at: p.at.toISOString() })),
    next: more && page.length ? (page[page.length - 1]?.at.toISOString() ?? null) : null,
  };
}
