// Your call (docs/plan.md §1.124.3; docs/cases-plan.md T1): the one list of what needs a person.
// To-do rows (operator-only, `todo`) plus what is read from its own table and never copied: open
// escalations (inbox items for us), runs queued for audit, build items we own, changes Reggie
// proposed, and for the clients' list the items on their Desks. Everything runs in the operator's
// transaction over the clients it serves (invariant 1); a to-do about no client is every
// operator's.

import {
  type CallKind,
  callKindOf,
  type HoldView,
  type TodoAboutKind,
  type TodoCounts,
  type TodoOwner,
  type TodoView,
  todoTag,
  type WorkUrgency,
} from "@countersign/core";
import {
  agent,
  appUser,
  build,
  buildItem,
  clientAsk,
  deal,
  inboxItem,
  issue,
  message,
  playLog,
  reggieAction,
  runAudit,
  runAuditMark,
  type Tx,
  tenant,
  thread,
  todo,
} from "@countersign/db";
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { iso } from "../http";
import { notWaitingReminder } from "../runs/run-wait";
import { holdViews } from "./holds";
import type { TodoRow } from "./todos-store";

/** At most this many lines per source, so one busy source never drowns the rest. */
const PER_SOURCE = 200;

/** A to-do row the operator's session may read: about a client it serves, or about none. */
export function todoScope(tenantIds: readonly string[]): SQL {
  return tenantIds.length
    ? (or(isNull(todo.clientId), inArray(todo.clientId, [...tenantIds])) as SQL)
    : isNull(todo.clientId);
}

/** Open, or snoozed until a time now past. */
export function todoOpen(now: Date): SQL {
  return or(
    eq(todo.state, "open"),
    and(eq(todo.state, "snoozed"), lte(todo.snoozedUntil, now)),
  ) as SQL;
}

/** A Dev queue request on the Feedback page's Dev queue tab (docs/plan.md §1.125). */
export function devQueueHref(id: string): string {
  return `/ops/utilities/feedback?tab=dev-queue&request=${encodeURIComponent(id)}`;
}

export function aboutHref(kind: string, id: string): string | null {
  switch (kind) {
    case "issue":
      return `/ops/issues/${id}`;
    case "enhancement":
      return `/ops/enhancements/${id}`;
    case "build":
      return `/ops/builds/${id}`;
    case "deal":
      return `/ops/deals/${id}`;
    case "run":
      return `/ops/runs/${id}`;
    case "client":
      return `/ops/clients/${id}`;
    case "code_request":
      return devQueueHref(id);
    default:
      return null;
  }
}

/**
 * Where a to-do is done: the page of the record it is about, else (an ask or a question, which
 * have no page of their own) its client's page.
 */
// DECISION (QA, 2026-11-22): every to-do about a record leads to a page, so its sheet always has
// a way to the work ("Record X's agreed price" opens the deal, where the terms form is).
export function todoHref(
  about: { kind: string; id: string },
  clientId: string | null,
): string | null {
  return aboutHref(about.kind, about.id) ?? (clientId ? aboutHref("client", clientId) : null);
}

/** "Head. Detail" or "Head: detail" into the why box's two parts. */
export function splitWhy(why: string | null): { head: string; detail: string } | null {
  if (!why) return null;
  const at = why.search(/[:.] /);
  if (at < 0) return { head: why.replace(/\.$/, ""), detail: "" };
  return { head: why.slice(0, at), detail: why.slice(at + 2) };
}

const textOf = (v: unknown): string | null =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string"
      ? (v as { text: string }).text
      : v && typeof v === "object" && typeof (v as { label?: unknown }).label === "string"
        ? (v as { label: string }).label
        : null;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(textOf).filter((s): s is string => !!s) : [];

interface AboutFacts {
  urgency: Map<string, { urgency: WorkUrgency; open: boolean }>;
  dealKind: Map<string, "new" | "expansion">;
  asks: Map<string, number>;
}

async function aboutFacts(tx: Tx, rows: TodoRow[]): Promise<AboutFacts> {
  const ids = (k: TodoAboutKind) => [
    ...new Set(rows.filter((r) => r.aboutKind === k && r.aboutId).map((r) => r.aboutId as string)),
  ];
  const issueIds = ids("issue");
  const dealIds = ids("deal");
  const enhIds = ids("enhancement");
  const urgency = new Map<string, { urgency: WorkUrgency; open: boolean }>();
  const dealKind = new Map<string, "new" | "expansion">();
  const asks = new Map<string, number>();
  if (issueIds.length) {
    for (const r of await tx
      .select({ id: issue.id, urgency: issue.urgency, stage: issue.stage })
      .from(issue)
      .where(inArray(issue.id, issueIds))) {
      urgency.set(r.id, { urgency: r.urgency as WorkUrgency, open: r.stage !== "closed" });
    }
  }
  if (dealIds.length) {
    for (const r of await tx
      .select({ id: deal.id, kind: deal.kind })
      .from(deal)
      .where(inArray(deal.id, dealIds))) {
      dealKind.set(r.id, r.kind as "new" | "expansion");
    }
  }
  if (enhIds.length) {
    // The count of asks across every client: an enhancement holds no client's words, only how
    // many asked (invariant 11). Read in the operator's scope, so it counts the clients served.
    for (const r of await tx
      .select({ id: clientAsk.enhancementId, n: sql<number>`count(*)::int` })
      .from(clientAsk)
      .where(inArray(clientAsk.enhancementId, enhIds))
      .groupBy(clientAsk.enhancementId)) {
      if (r.id) asks.set(r.id, r.n);
    }
  }
  return { urgency, dealKind, asks };
}

async function namesOf(tx: Tx, ids: (string | null)[], kind: "tenant" | "user") {
  const want = [...new Set(ids.filter((v): v is string => !!v))];
  const out = new Map<string, string>();
  if (!want.length) return out;
  if (kind === "tenant") {
    for (const r of await tx
      .select({ id: tenant.id, name: tenant.name })
      .from(tenant)
      .where(inArray(tenant.id, want))) {
      out.set(r.id, r.name);
    }
  } else {
    for (const r of await tx
      .select({ id: appUser.id, name: appUser.name, email: appUser.email })
      .from(appUser)
      .where(inArray(appUser.id, want))) {
      out.set(r.id, r.name ?? r.email);
    }
  }
  return out;
}

/** To-do rows as Your call shows them. */
export async function todoViews(tx: Tx, rows: TodoRow[]): Promise<TodoView[]> {
  if (!rows.length) return [];
  const [facts, clients, users] = await Promise.all([
    aboutFacts(tx, rows),
    namesOf(
      tx,
      rows.map((r) => r.clientId),
      "tenant",
    ),
    namesOf(
      tx,
      rows.map((r) => r.ownerUserId),
      "user",
    ),
  ]);
  return rows.map((r) => {
    const about = r.aboutKind && r.aboutId ? { kind: r.aboutKind, id: r.aboutId } : null;
    const iss = about?.kind === "issue" ? facts.urgency.get(about.id) : undefined;
    const clientName = r.clientId ? (clients.get(r.clientId) ?? null) : null;
    const draft = r.draft as {
      to?: string;
      channel?: string;
      text?: string;
    } | null;
    const action = r.primaryAction as { label?: string; kind?: TodoView["primary"] } | null;
    const primary =
      action && typeof action.label === "string" && typeof action.kind === "string"
        ? ({ label: action.label, kind: action.kind } as NonNullable<TodoView["primary"]>)
        : null;
    return {
      id: r.id,
      source: "todo",
      owner: r.owner,
      ownerUser: r.ownerUserId
        ? { id: r.ownerUserId, name: users.get(r.ownerUserId) ?? "An operator" }
        : null,
      kind: callKindOf(about?.kind ?? null),
      tag: todoTag(about?.kind ?? null, {
        urgency: iss?.urgency ?? null,
        dealKind: about?.kind === "deal" ? (facts.dealKind.get(about.id) ?? null) : null,
        asks: about?.kind === "enhancement" ? (facts.asks.get(about.id) ?? 0) : 0,
      }),
      title: r.title,
      detail: r.detail,
      client: r.clientId ? { id: r.clientId, name: clientName ?? "A client" } : null,
      about: about ? { ...about, href: todoHref(about, r.clientId) } : null,
      dueAt: iso(r.dueAt),
      state: r.state,
      snoozedUntil: iso(r.snoozedUntil),
      read: r.read,
      plan: strings(r.plan),
      why: splitWhy(r.why),
      sure: r.sure,
      draft:
        draft && typeof draft.text === "string"
          ? {
              to:
                draft.to === "client" || !draft.to
                  ? `To ${clientName ?? "the client"}`
                  : draft.to.startsWith("To ")
                    ? draft.to
                    : `To ${draft.to}`,
              text: draft.text,
              channel: draft.channel ?? "portal",
            }
          : null,
      form: null,
      options: r.options ? strings(r.options) : null,
      primary,
      alt: null,
      critical: !!iss && iss.open && iss.urgency === "critical",
      urgency: iss?.urgency ?? null,
      editable: true,
      createdAt: r.createdAt.toISOString(),
    } satisfies TodoView;
  });
}

/** A line read from its own table: shown on Your call, done on its own screen. */
function derived(
  v: Pick<TodoView, "id" | "source" | "owner" | "title" | "client" | "about" | "dueAt"> & {
    tag: string;
    kind: Exclude<CallKind, "all">;
    createdAt: Date;
    read?: string | null;
    why?: { head: string; detail: string } | null;
    primary: string;
    critical?: boolean;
  },
): TodoView {
  return {
    id: v.id,
    source: v.source,
    owner: v.owner,
    ownerUser: null,
    kind: v.kind,
    tag: v.tag,
    title: v.title,
    detail: "",
    client: v.client,
    about: v.about,
    dueAt: v.dueAt,
    state: "open",
    snoozedUntil: null,
    read: v.read ?? null,
    plan: [],
    why: v.why ?? null,
    sure: null,
    draft: null,
    form: null,
    options: null,
    primary: { label: v.primary, kind: "open" },
    alt: null,
    critical: v.critical ?? false,
    urgency: null,
    editable: false,
    createdAt: v.createdAt.toISOString(),
  };
}

/** Open escalations: inbox items for us at the clients served. */
async function escalations(tx: Tx, scope: readonly string[]): Promise<TodoView[]> {
  if (!scope.length) return [];
  const rows = await tx
    .select({
      id: inboxItem.id,
      title: inboxItem.title,
      kind: inboxItem.kind,
      tenantId: inboxItem.tenantId,
      dueAt: inboxItem.dueAt,
      createdAt: inboxItem.createdAt,
      clientName: tenant.name,
    })
    .from(inboxItem)
    .innerJoin(tenant, eq(tenant.id, inboxItem.tenantId))
    .where(
      and(
        inArray(inboxItem.tenantId, [...scope]),
        eq(inboxItem.status, "open"),
        eq(inboxItem.assigneeRole, "operator"),
        notWaitingReminder,
      ),
    )
    .orderBy(inboxItem.createdAt)
    .limit(PER_SOURCE);
  return rows.map((r) =>
    derived({
      id: r.id,
      source: "escalation",
      owner: "operator",
      kind: "other",
      tag: "Escalation",
      title: r.title,
      client: { id: r.tenantId, name: r.clientName },
      // The exact item, open in its side sheet (QA, 2026-11-22).
      about: { kind: "inbox", id: r.id, href: `/ops/inbox?client=${r.tenantId}&item=${r.id}` },
      dueAt: iso(r.dueAt),
      createdAt: r.createdAt,
      why: { head: "Waiting on us", detail: "An agent brought this to a person." },
      primary: "Open",
    }),
  );
}

/** Runs queued for a person to check, not yet marked. */
async function auditQueue(tx: Tx, scope: readonly string[]): Promise<TodoView[]> {
  if (!scope.length) return [];
  const rows = await tx
    .select({
      runId: runAudit.runId,
      tenantId: runAudit.tenantId,
      reason: runAudit.reason,
      createdAt: runAudit.createdAt,
      clientName: tenant.name,
      agentName: sql<string>`coalesce(${agent.serviceName}, ${agent.name})`,
    })
    .from(runAudit)
    .innerJoin(tenant, eq(tenant.id, runAudit.tenantId))
    .innerJoin(agent, and(eq(agent.id, runAudit.agentId), eq(agent.tenantId, runAudit.tenantId)))
    .where(
      and(
        inArray(runAudit.tenantId, [...scope]),
        sql`not exists (select 1 from ${runAuditMark} m where m.run_id = ${runAudit.runId} and m.tenant_id = ${runAudit.tenantId})`,
      ),
    )
    .orderBy(desc(runAudit.createdAt))
    .limit(PER_SOURCE);
  return rows.map((r) =>
    derived({
      id: r.runId,
      source: "run_audit",
      owner: "operator",
      kind: "other",
      tag: "Run held for review",
      title: `Check a run of ${r.agentName} at ${r.clientName}`,
      client: { id: r.tenantId, name: r.clientName },
      about: { kind: "run", id: r.runId, href: aboutHref("run", r.runId) },
      dueAt: null,
      createdAt: r.createdAt,
      why: { head: "Held for review", detail: "Reggie doesn't sign off on held runs." },
      primary: "Open the run",
    }),
  );
}

/** Build items we own on open builds (the Builder's checklist). */
async function buildItems(tx: Tx, scope: readonly string[]): Promise<TodoView[]> {
  const rows = await tx
    .select({
      id: buildItem.id,
      title: buildItem.title,
      buildId: buildItem.buildId,
      createdAt: buildItem.createdAt,
      buildTitle: build.title,
      clientId: build.clientId,
      promisedOn: build.promisedOn,
    })
    .from(buildItem)
    .innerJoin(build, eq(build.id, buildItem.buildId))
    .where(
      and(
        eq(buildItem.owner, "operator"),
        eq(buildItem.state, "open"),
        eq(build.status, "open"),
        scope.length
          ? (or(isNull(build.clientId), inArray(build.clientId, [...scope])) as SQL)
          : isNull(build.clientId),
      ),
    )
    .orderBy(buildItem.createdAt)
    .limit(PER_SOURCE);
  const names = await namesOf(
    tx,
    rows.map((r) => r.clientId),
    "tenant",
  );
  return rows.map((r) =>
    derived({
      id: r.id,
      source: "build_item",
      owner: "operator",
      kind: "builds",
      tag: "Agent build",
      title: r.title,
      client: r.clientId ? { id: r.clientId, name: names.get(r.clientId) ?? "A client" } : null,
      about: { kind: "build", id: r.buildId, href: aboutHref("build", r.buildId) },
      dueAt: r.promisedOn ? `${r.promisedOn}T23:59:59.000Z` : null,
      createdAt: r.createdAt,
      read: `On the build "${r.buildTitle}".`,
      primary: "Open the build",
    }),
  );
}

/** Changes Reggie proposed to this operator, waiting for its card to be confirmed. */
async function reggieCards(tx: Tx, scope: readonly string[], userId: string): Promise<TodoView[]> {
  const rows = await tx
    .select({
      id: reggieAction.id,
      tool: reggieAction.tool,
      preview: reggieAction.preview,
      clientId: reggieAction.clientId,
      conversationId: reggieAction.conversationId,
      createdAt: reggieAction.createdAt,
    })
    .from(reggieAction)
    .where(
      and(
        eq(reggieAction.userId, userId),
        eq(reggieAction.status, "proposed"),
        scope.length
          ? (or(isNull(reggieAction.clientId), inArray(reggieAction.clientId, [...scope])) as SQL)
          : isNull(reggieAction.clientId),
      ),
    )
    .orderBy(reggieAction.createdAt)
    .limit(PER_SOURCE);
  const names = await namesOf(
    tx,
    rows.map((r) => r.clientId),
    "tenant",
  );
  return rows.map((r) => {
    const p = r.preview as { title?: unknown; lines?: unknown };
    const lines = strings(p.lines);
    return {
      ...derived({
        id: r.id,
        source: "reggie_card",
        owner: "operator",
        kind: "other",
        tag: "Reggie's card",
        title: typeof p.title === "string" ? p.title : r.tool,
        client: r.clientId ? { id: r.clientId, name: names.get(r.clientId) ?? "A client" } : null,
        about: {
          kind: "reggie",
          id: r.conversationId,
          href: `/ops/reggie/${r.conversationId}`,
        },
        dueAt: null,
        createdAt: r.createdAt,
        why: { head: "A change", detail: "Reggie proposes; only you confirm." },
        primary: "Open the card",
      }),
      plan: lines,
    };
  });
}

/** What waits on the clients: open Desk items and forms for their people. */
async function deskItems(tx: Tx, scope: readonly string[]): Promise<TodoView[]> {
  if (!scope.length) return [];
  const rows = await tx
    .select({
      id: inboxItem.id,
      title: inboxItem.title,
      kind: inboxItem.kind,
      subjectType: inboxItem.subjectType,
      subjectId: inboxItem.subjectId,
      payload: inboxItem.payload,
      tenantId: inboxItem.tenantId,
      dueAt: inboxItem.dueAt,
      createdAt: inboxItem.createdAt,
      clientName: tenant.name,
    })
    .from(inboxItem)
    .innerJoin(tenant, eq(tenant.id, inboxItem.tenantId))
    .where(
      and(
        inArray(inboxItem.tenantId, [...scope]),
        eq(inboxItem.status, "open"),
        or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator")),
        or(isNull(inboxItem.snoozedUntil), lte(inboxItem.snoozedUntil, new Date())),
        notWaitingReminder,
      ),
    )
    .orderBy(sql`${inboxItem.dueAt} asc nulls last`, inboxItem.createdAt)
    .limit(PER_SOURCE);
  return rows.map((r) => {
    const buildId =
      r.subjectType === "requirements_request"
        ? ((r.payload as { buildId?: unknown }).buildId as string | undefined)
        : undefined;
    return derived({
      id: r.id,
      source: "desk",
      owner: "client",
      kind: buildId ? "builds" : r.subjectType === "issue" ? "issues" : "other",
      tag: buildId ? "Agent build" : "Desk",
      title: r.title,
      client: { id: r.tenantId, name: r.clientName },
      about: buildId
        ? { kind: "build", id: buildId, href: aboutHref("build", buildId) }
        : { kind: "desk", id: r.id, href: `/ops/clients/${r.tenantId}` },
      dueAt: iso(r.dueAt),
      createdAt: r.createdAt,
      primary: "Open",
    });
  });
}

export interface TodoQuery {
  owner: TodoOwner;
  client?: string | undefined;
  kind: CallKind;
  mine: boolean;
  about?: { kind: string; id: string } | undefined;
}

/** The to-do rows for an owner (or about one item), open now. */
async function rowsFor(
  tx: Tx,
  tenantIds: readonly string[],
  userId: string,
  q: Omit<TodoQuery, "kind">,
  now: Date,
): Promise<TodoRow[]> {
  const where: SQL[] = [todoScope(tenantIds), todoOpen(now)];
  if (q.about) {
    where.push(eq(todo.aboutKind, q.about.kind as TodoAboutKind), eq(todo.aboutId, q.about.id));
  } else {
    where.push(eq(todo.owner, q.owner));
  }
  if (q.client) where.push(eq(todo.clientId, q.client));
  // DECISION: "Mine" shows the to-dos named to you and those named to no one; without it, every
  // operator's (owner, 2026-11-17: an optional named operator).
  if (q.mine) where.push(or(isNull(todo.ownerUserId), eq(todo.ownerUserId, userId)) as SQL);
  return tx
    .select()
    .from(todo)
    .where(and(...where))
    .orderBy(sql`${todo.dueAt} asc nulls last`, todo.createdAt)
    .limit(500);
}

/** Critical first, then by due date (undated last), then oldest. */
export function callOrder(a: TodoView, b: TodoView): number {
  if (a.critical !== b.critical) return a.critical ? -1 : 1;
  const ad = a.dueAt ?? "9999";
  const bd = b.dueAt ?? "9999";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** Everything on one owner's list, in the order the page shows it. */
export async function listFor(
  tx: Tx,
  tenantIds: readonly string[],
  userId: string,
  q: Omit<TodoQuery, "kind">,
  now = new Date(),
): Promise<TodoView[]> {
  const scope = q.client ? tenantIds.filter((t) => t === q.client) : tenantIds;
  const rows = await todoViews(tx, await rowsFor(tx, tenantIds, userId, q, now));
  if (q.about) return rows;
  const extra: TodoView[] = [];
  if (q.owner === "operator") {
    extra.push(
      ...(await escalations(tx, scope)),
      ...(await auditQueue(tx, scope)),
      ...(await buildItems(tx, scope)).filter((v) => !q.client || v.client?.id === q.client),
      ...(await reggieCards(tx, scope, userId)).filter(
        (v) => !q.client || v.client?.id === q.client,
      ),
    );
  } else if (q.owner === "client") {
    // A Desk item a client to-do already mirrors shows once, as the to-do.
    const mirrored = new Set(
      (
        await tx
          .select({ id: todo.deskItemId })
          .from(todo)
          .where(and(todoScope(tenantIds), sql`${todo.deskItemId} is not null`))
      ).map((r) => r.id),
    );
    extra.push(...(await deskItems(tx, scope)).filter((v) => !mirrored.has(v.id)));
  }
  return [...rows, ...extra].sort(callOrder);
}

const endOfToday = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
const startOfToday = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Questions from client people in their account conversations (Sloan) since a time, and the
 * median minutes to the first answer after each.
 */
export async function questionFigures(
  tx: Tx,
  scope: readonly string[],
  since: Date,
): Promise<{ asked: number; medianMinutes: number | null }> {
  if (!scope.length) return { asked: 0, medianMinutes: null };
  const [r] = await tx
    .select({
      asked: sql<number>`count(*)::int`,
      median: sql<number | null>`percentile_cont(0.5) within group (order by (
        select extract(epoch from (a.created_at - ${message.createdAt})) / 60
        from ${message} a
        where a.thread_id = ${message.threadId} and a.tenant_id = ${message.tenantId}
          and a.sender_type = 'agent' and a.created_at > ${message.createdAt}
        order by a.created_at limit 1
      ))`,
    })
    .from(message)
    .innerJoin(thread, and(eq(thread.id, message.threadId), eq(thread.tenantId, message.tenantId)))
    .where(
      and(
        inArray(message.tenantId, [...scope]),
        eq(thread.subjectType, "account"),
        eq(message.senderType, "user"),
        gte(message.createdAt, since),
      ),
    );
  return {
    asked: r?.asked ?? 0,
    medianMinutes: r?.median == null ? null : Math.round(Number(r.median)),
  };
}

export async function playsToday(tx: Tx, tenantIds: readonly string[], now: Date) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(playLog)
    .where(
      and(
        gte(playLog.createdAt, startOfToday(now)),
        inArray(playLog.outcome, ["sent", "done"]),
        tenantIds.length
          ? (or(isNull(playLog.clientId), inArray(playLog.clientId, [...tenantIds])) as SQL)
          : isNull(playLog.clientId),
      ),
    );
  return r?.n ?? 0;
}

/** Your call: one owner's list and the counts over all three. */
export async function todoList(
  tx: Tx,
  tenantIds: readonly string[],
  userId: string,
  q: TodoQuery,
  now = new Date(),
): Promise<{ items: TodoView[]; counts: TodoCounts; holds: HoldView[]; today: string }> {
  const base = { client: q.client, mine: q.mine };
  const [yours, reggie, client] = [
    await listFor(tx, tenantIds, userId, { ...base, owner: "operator" }, now),
    await listFor(tx, tenantIds, userId, { ...base, owner: "reggie" }, now),
    await listFor(tx, tenantIds, userId, { ...base, owner: "client" }, now),
  ];
  const scope = q.client ? tenantIds.filter((t) => t === q.client) : tenantIds;
  const holds = await holdViews(tx, scope);
  const questions = await questionFigures(tx, scope, new Date(now.getTime() - 7 * 86_400_000));
  const eod = endOfToday(now).toISOString();
  const sod = startOfToday(now).toISOString();
  const pick = q.about
    ? await listFor(tx, tenantIds, userId, { ...base, owner: q.owner, about: q.about }, now)
    : q.owner === "operator"
      ? yours
      : q.owner === "reggie"
        ? reggie
        : client;
  const items = q.kind === "all" ? pick : pick.filter((v) => v.kind === q.kind);
  return {
    items,
    counts: {
      yours: yours.length,
      reggie: reggie.length,
      client: client.length,
      doneToday: await playsToday(tx, scope, now),
      dueToday: yours.filter((v) => v.dueAt && v.dueAt < eod).length,
      criticalHeld: holds.length,
      lateClient: client.filter((v) => v.dueAt && v.dueAt < sod).length,
      questionsWeek: questions.asked,
      medianAnswerMinutes: questions.medianMinutes,
    },
    holds,
    today: now.toISOString().slice(0, 10),
  };
}
