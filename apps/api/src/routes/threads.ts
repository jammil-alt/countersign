// Threads, the lead and `/commands` (ARCHITECTURE §11.2, §14; docs/plan.md §1.38), over
// packages/threads. The portal reads and posts in its client's lead thread, its services' threads
// and its account threads (a client user only their own); operator-only notes never reach it, and
// no other operator than the lead is named there. The back office reads every thread of the
// clients it serves and posts as itself, to the client or as a note. Posting emits
// `thread.message_posted` in the request's transaction and dispatches it after commit; a `/name`
// message names the agent the message trigger (W2-E) starts.

// P-7: message translation
import {
  clientTranslation,
  latestTranslations,
  opsTranslationView,
  translateAndStore,
  translationView,
} from "@countersign/agents";
import {
  firstName,
  type OpsLead,
  type OpsMessage,
  type OpsThread,
  OWNER_WORDS,
  OwnerArea,
  ownerRole,
  type PortalMessage,
  type PortalThread,
  routes,
  SUPERVISOR_SLUG,
  type ThreadKind,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  areaOwner,
  type Db,
  membership,
  type Tx,
  tenantChange,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import {
  agentThread,
  canPost,
  canRead,
  findThread,
  leadDisplayName,
  leadOf,
  leadThread,
  listMessages,
  listThreads,
  type MessageRow,
  markRead,
  messageText,
  postAsPerson,
  senseEmitPosted,
  servesClient,
  setLead,
  startAccountThread,
  type ThreadRow,
  threadActivity,
  type Viewer,
  visibleAudiences,
} from "@countersign/threads";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, iso, mount, notFound } from "../http";
import { dispatchEvents } from "../runs/dispatch";
import { translateLater, translationDepsFor } from "../translate/service";
import { tenantLocale } from "./language";
import { findRecord } from "./records";

const CLIENT_KINDS: readonly ThreadKind[] = ["lead", "account", "agent"];

type AgentRow = Pick<typeof agent.$inferSelect, "id" | "slug" | "name" | "serviceName">;
const serviceName = (a: Pick<AgentRow, "serviceName" | "name">) => a.serviceName ?? a.name;

/** The agents of the given ids in one client (thread subjects, message senders). */
async function agentsById(tx: Tx, tenantId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (wanted.length === 0) return new Map<string, AgentRow>();
  const rows = await tx
    .select({ id: agent.id, slug: agent.slug, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), inArray(agent.id, wanted)));
  return new Map(rows.map((a) => [a.id, a]));
}

/** The agent each version belongs to (older agent messages name only their version). */
async function agentsByVersion(tx: Tx, tenantId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (wanted.length === 0) return new Map<string, AgentRow>();
  const rows = await tx
    .select({
      versionId: agentVersion.id,
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      serviceName: agent.serviceName,
    })
    .from(agentVersion)
    .innerJoin(agent, eq(agent.id, agentVersion.agentId))
    .where(and(eq(agentVersion.tenantId, tenantId), inArray(agentVersion.id, wanted)));
  return new Map(rows.map((r) => [r.versionId, r]));
}

async function usersById(tx: Tx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (wanted.length === 0) return new Map<string, { name: string | null; email: string }>();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(rows.map((u) => [u.id, { name: u.name, email: u.email }]));
}

/** Of the given users, those who are operators of the client. */
async function operatorsOf(tx: Tx, tenantId: string, ids: (string | null)[]) {
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

/** A service the client sees (its overview's list): a client agent, not a test copy, on or paused. */
async function clientService(tx: Tx, tenantId: string, id: string): Promise<AgentRow> {
  const [row] = await tx
    .select({ id: agent.id, slug: agent.slug, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(
      and(
        eq(agent.id, id),
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        inArray(agent.runStatus, ["active", "paused"]),
      ),
    );
  if (!row) throw notFound("service");
  return row;
}

/** One of the client's own agents, for the back office (any status, not a Sandbox test copy). */
async function clientAgent(tx: Tx, tenantId: string, id: string): Promise<AgentRow> {
  const [row] = await tx
    .select({ id: agent.id, slug: agent.slug, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(
      and(
        eq(agent.id, id),
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
      ),
    );
  if (!row) throw notFound("agent");
  return row;
}

/** Every source must name one of this client's records (invariant 10; the records resolver). */
async function checkSources(tx: Tx, tenantId: string, sources: readonly string[]) {
  for (const id of new Set(sources)) {
    if (!(await findRecord(tx, tenantId, id))) {
      throw new HttpError(422, "invalid_source", "cite only this client's own records");
    }
  }
}

// ── Read models ────────────────────────────────────────────────────────────────────────────────

async function portalThreads(
  tx: Tx,
  tenantId: string,
  viewer: Viewer,
  rows: ThreadRow[],
): Promise<PortalThread[]> {
  const visible = rows.filter((t) => canRead(viewer, t));
  const activity = await threadActivity(
    tx,
    tenantId,
    visible.map((t) => t.id),
    viewer.userId,
    visibleAudiences(viewer),
  );
  const agents = await agentsById(
    tx,
    tenantId,
    visible.filter((t) => t.subjectType === "agent").map((t) => t.subjectId),
  );
  const users = await usersById(
    tx,
    visible.map((t) => t.createdBy),
  );
  // v0.17: the area owner a conversation is with (an account thread's subject).
  const ownerIds = visible
    .filter((t) => t.subjectType === "account" && t.subjectId)
    .map((t) => t.subjectId as string);
  const owners = ownerIds.length
    ? new Map(
        (
          await tx
            .select({ id: areaOwner.id, name: areaOwner.name, area: areaOwner.area })
            .from(areaOwner)
            .where(and(eq(areaOwner.tenantId, tenantId), inArray(areaOwner.id, ownerIds)))
        ).map((o) => [o.id, o]),
      )
    : new Map<string, { id: string; name: string; area: OwnerArea }>();
  const locale = owners.size ? await tenantLocale(tx, tenantId) : "en";
  return visible.map((t): PortalThread => {
    const a = t.subjectType === "agent" && t.subjectId ? agents.get(t.subjectId) : undefined;
    const by = t.subjectType === "account" && t.createdBy ? t.createdBy : null;
    const act = activity.get(t.id);
    return {
      id: t.id,
      subject: t.subjectType as ThreadKind,
      service: a ? { id: a.id, name: serviceName(a) } : null,
      startedBy: by ? { id: by, name: users.get(by)?.name ?? null } : null,
      owner: (() => {
        const o = t.subjectType === "account" && t.subjectId ? owners.get(t.subjectId) : undefined;
        return o ? { ...o, role: ownerRole(locale, o.area) } : null;
      })(),
      lastMessageAt: iso(act?.lastMessageAt),
      unread: act?.unread ?? 0,
      createdAt: t.createdAt.toISOString(),
    };
  });
}

async function portalMessages(
  tx: Tx,
  tenantId: string,
  viewer: Viewer,
  rows: MessageRow[],
): Promise<PortalMessage[]> {
  const people = rows.filter((m) => m.senderType === "user").map((m) => m.senderId);
  const users = await usersById(tx, people);
  const operators = await operatorsOf(tx, tenantId, people);
  const lead = await leadOf(tx, tenantId);
  const byAgent = await agentsById(
    tx,
    tenantId,
    rows.filter((m) => m.senderType === "agent").map((m) => m.senderId),
  );
  const byVersion = await agentsByVersion(
    tx,
    tenantId,
    rows.filter((m) => m.senderType === "agent").map((m) => m.agentVersionId),
  );
  // P-7: only what was translated for the client (the lead's words in its working language); a
  // client member's own words translated for us are the back office's (docs/plan.md §1.69).
  const translated = await latestTranslations(tx, tenantId, { messageIds: rows.map((m) => m.id) });
  // v0.17: each agent's answer says who it is ("Pia · purchasing agent", "Sloan · account
  // assistant"), in the client's language.
  const locale = await tenantLocale(tx, tenantId);
  return rows.map((m): PortalMessage => {
    const tr = translated.get(m.id);
    let name: string | null = null;
    let role: string | null = null;
    const isLead = m.senderType === "user" && !!lead && m.senderId === lead.userId;
    if (m.senderType === "user" && m.senderId) {
      const u = users.get(m.senderId);
      // The lead is the one operator person a client sees named; other operators are "Mezonas"
      // (ARCHITECTURE §4), shown by the portal for a null name.
      if (isLead && lead) name = leadDisplayName(lead);
      else if (!operators.has(m.senderId)) name = u?.name ?? null;
    } else if (m.senderType === "agent") {
      const a =
        (m.senderId ? byAgent.get(m.senderId) : undefined) ??
        (m.agentVersionId ? byVersion.get(m.agentVersionId) : undefined);
      // v0.17 (§10.15 "Talking to an owner"): Sloan's answer in an owner's name shows under it.
      const owner = ownerOf(m.body);
      name = owner?.name ?? (a ? serviceName(a) : null);
      role = owner
        ? ownerRole(locale, owner.area)
        : a?.slug === SUPERVISOR_SLUG
          ? OWNER_WORDS[locale].assistant
          : null;
    }
    return {
      id: m.id,
      kind: m.kind,
      sender: {
        type: m.senderType,
        name,
        role,
        you: m.senderType === "user" && m.senderId === viewer.userId,
        lead: isLead,
      },
      text: messageText(m),
      command: m.command,
      sources: m.sources,
      createdAt: m.createdAt.toISOString(),
      ...(tr && tr.direction === "out" ? { translation: translationView(tr) } : {}),
    };
  });
}

async function opsThreads(
  tx: Tx,
  tenantId: string,
  userId: string,
  rows: ThreadRow[],
): Promise<OpsThread[]> {
  const activity = await threadActivity(
    tx,
    tenantId,
    rows.map((t) => t.id),
    userId,
    ["client", "operator"],
  );
  const agents = await agentsById(
    tx,
    tenantId,
    rows.filter((t) => t.subjectType === "agent").map((t) => t.subjectId),
  );
  const users = await usersById(
    tx,
    rows.map((t) => t.createdBy),
  );
  return rows.map((t): OpsThread => {
    const a = t.subjectType === "agent" && t.subjectId ? agents.get(t.subjectId) : undefined;
    const act = activity.get(t.id);
    return {
      id: t.id,
      clientId: t.tenantId,
      subjectType: t.subjectType,
      subjectId: t.subjectId,
      title: t.title,
      status: t.status,
      createdBy: t.createdBy
        ? { id: t.createdBy, name: users.get(t.createdBy)?.name ?? null }
        : null,
      agent: a ? { id: a.id, slug: a.slug, name: a.name } : null,
      lastMessageAt: iso(act?.lastMessageAt),
      unread: act?.unread ?? 0,
      createdAt: t.createdAt.toISOString(),
    };
  });
}

async function opsMessages(tx: Tx, tenantId: string, rows: MessageRow[]): Promise<OpsMessage[]> {
  const users = await usersById(
    tx,
    rows.filter((m) => m.senderType === "user").map((m) => m.senderId),
  );
  const byAgent = await agentsById(
    tx,
    tenantId,
    rows.filter((m) => m.senderType === "agent").map((m) => m.senderId),
  );
  const byVersion = await agentsByVersion(
    tx,
    tenantId,
    rows.filter((m) => m.senderType === "agent").map((m) => m.agentVersionId),
  );
  // P-7: a client member's words in English, or the lead's in the working language (§1.69).
  const translated = await latestTranslations(tx, tenantId, { messageIds: rows.map((m) => m.id) });
  return rows.map((m): OpsMessage => {
    const tr = translated.get(m.id);
    let name: string | null = null;
    if (m.senderType === "user" && m.senderId) {
      const u = users.get(m.senderId);
      name = u ? (u.name ?? u.email) : null;
    } else if (m.senderType === "agent") {
      const a =
        (m.senderId ? byAgent.get(m.senderId) : undefined) ??
        (m.agentVersionId ? byVersion.get(m.agentVersionId) : undefined);
      // v0.17: the back office sees whose voice it was, beside the agent that wrote it.
      const owner = ownerName(m.body);
      name = owner ? `${owner} (${a?.name ?? "Sloan"})` : (a?.name ?? null);
    }
    return {
      id: m.id,
      kind: m.kind,
      sender: { type: m.senderType, id: m.senderId, name },
      agentVersionId: m.agentVersionId,
      text: messageText(m),
      command: m.command,
      audience: m.audience,
      sources: m.sources,
      createdAt: m.createdAt.toISOString(),
      ...(tr ? { translation: opsTranslationView(tr) } : {}),
    };
  });
}

function opsLead(lead: Awaited<ReturnType<typeof leadOf>>): OpsLead | null {
  return lead ? { userId: lead.userId, name: lead.name, email: lead.email } : null;
}

function portalViewer(role: string, userId: string): Viewer {
  if (role !== "client_admin" && role !== "client_user") {
    throw new HttpError(403, "forbidden", "threads in the portal are for the client's people");
  }
  return { kind: "client", role, userId };
}

async function threadIn(tx: Tx, tenantIds: readonly string[], id: string, viewer: Viewer) {
  const t = await findThread(tx, tenantIds, id);
  // Someone who may not read it learns nothing of it (404, not 403).
  if (!t || !canRead(viewer, t)) throw notFound("thread");
  return t;
}

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────

export function threadRouteHandlers(app: Hono<AppEnv>): void {
  // ── Portal ─────────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.portalThreads, async ({ tx, tenantIds, role, session, query }) => {
    const tenantId = tenantIds[0] as string;
    const viewer = portalViewer(role, session.user.id);
    // DECISION: asking for the lead thread, or a service's thread, opens it on first ask (one
    // row, idempotent), so the person can post at once; listing never opens anything else.
    let rows: ThreadRow[];
    if (query.subject === "lead") {
      rows = [await leadThread(tx, tenantId)];
    } else if (query.subject === "agent" && query.service) {
      rows = [await agentThread(tx, tenantId, await clientService(tx, tenantId, query.service))];
    } else {
      rows = await listThreads(tx, tenantId, {
        subjectTypes: query.subject ? [query.subject] : CLIENT_KINDS,
        accountCreatedBy:
          viewer.kind === "client" && viewer.role === "client_user" ? viewer.userId : undefined,
      });
    }
    const lead = await leadOf(tx, tenantId);
    return {
      lead: lead ? { name: leadDisplayName(lead) } : null,
      threads: await portalThreads(tx, tenantId, viewer, rows),
    };
  });

  mount(app, routes.portalStartThread, async ({ tx, tenantIds, role, session, body }) => {
    const tenantId = tenantIds[0] as string;
    const viewer = portalViewer(role, session.user.id);
    // v0.17: a conversation with one of the client's own area owners.
    let owner: { id: string; name: string } | undefined;
    if (body.ownerId) {
      const [o] = await tx
        .select({ id: areaOwner.id, name: areaOwner.name })
        .from(areaOwner)
        .where(and(eq(areaOwner.id, body.ownerId), eq(areaOwner.tenantId, tenantId)));
      if (!o) throw notFound("agent");
      owner = o;
    }
    const t = await startAccountThread(tx, tenantId, session.user.id, owner);
    const [thread] = await portalThreads(tx, tenantId, viewer, [t]);
    if (!thread) throw new Error("no thread");
    return { thread };
  });

  mount(
    app,
    routes.portalThreadMessages,
    async ({ tx, tenantIds, role, session, params, query }) => {
      const tenantId = tenantIds[0] as string;
      const viewer = portalViewer(role, session.user.id);
      const t = await threadIn(tx, tenantIds, params.id, viewer);
      const rows = await listMessages(tx, t, {
        audiences: visibleAudiences(viewer),
        before: query.before ? new Date(query.before) : undefined,
        limit: query.limit,
      });
      const [thread] = await portalThreads(tx, tenantId, viewer, [t]);
      if (!thread) throw notFound("thread");
      return { thread, messages: await portalMessages(tx, tenantId, viewer, rows) };
    },
  );

  mount(app, routes.portalPostMessage, async (ctx) => {
    const { tx, tenantIds, role, session, params, body, services } = ctx;
    const tenantId = tenantIds[0] as string;
    const viewer = portalViewer(role, session.user.id);
    const t = await threadIn(tx, tenantIds, params.id, viewer);
    if (!canPost(viewer, t)) throw notFound("thread");
    if (t.status !== "open") throw new HttpError(409, "closed", "this conversation is closed");
    await checkSources(tx, tenantId, body.sources);
    const collect: EventRow[] = [];
    // A client member's message is always for the client's own thread readers (and the operators).
    const posted = await postAsPerson(
      tx,
      {
        tenantId,
        thread: t,
        userId: session.user.id,
        operator: false,
        text: body.text,
        sources: body.sources,
        audience: "client",
        locale: await tenantLocale(tx, tenantId),
      },
      senseEmitPosted({ registry: services.platform.events, collect }),
    );
    if (collect.length > 0) {
      ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
    }
    // P-7: the member's words, translated for the back office where the client has it on.
    if ((await clientTranslation(tx, tenantId)).settings.threads) {
      const deps = translationDepsFor(services);
      ctx.defer(() => translateLater(deps, tenantId));
    }
    return { messages: await portalMessages(tx, tenantId, viewer, posted) };
  });

  mount(app, routes.portalReadThread, async ({ tx, tenantIds, role, session, params }) => {
    const viewer = portalViewer(role, session.user.id);
    const t = await threadIn(tx, tenantIds, params.id, viewer);
    await markRead(tx, t, session.user.id);
    return { ok: true as const };
  });

  // ── Back office ────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.opsThreads, async (ctx) => {
    const { tx, params, query, session } = ctx;
    ensureClient(ctx, params.id);
    const tenantId = params.id;
    let rows: ThreadRow[];
    if (query.subject === "lead") {
      rows = [await leadThread(tx, tenantId)];
    } else if (query.subject === "agent" && query.subjectId) {
      rows = [await agentThread(tx, tenantId, await clientAgent(tx, tenantId, query.subjectId))];
    } else {
      rows = await listThreads(tx, tenantId, {
        subjectType: query.subject,
        subjectId: query.subjectId,
      });
    }
    return {
      lead: opsLead(await leadOf(tx, tenantId)),
      threads: await opsThreads(tx, tenantId, session.user.id, rows),
    };
  });

  mount(app, routes.opsThreadMessages, async ({ tx, tenantIds, session, params, query }) => {
    const viewer: Viewer = { kind: "operator", userId: session.user.id };
    const t = await threadIn(tx, tenantIds, params.id, viewer);
    const rows = await listMessages(tx, t, {
      audiences: visibleAudiences(viewer),
      before: query.before ? new Date(query.before) : undefined,
      limit: query.limit,
    });
    const [thread] = await opsThreads(tx, t.tenantId, session.user.id, [t]);
    if (!thread) throw notFound("thread");
    return { thread, messages: await opsMessages(tx, t.tenantId, rows) };
  });

  mount(app, routes.opsPostMessage, async (ctx) => {
    const { tx, tenantIds, session, params, body, services } = ctx;
    const viewer: Viewer = { kind: "operator", userId: session.user.id };
    const t = await threadIn(tx, tenantIds, params.id, viewer);
    if (!canPost(viewer, t)) {
      throw new HttpError(409, "not_here", "a contact's thread holds only messages sent to them");
    }
    if (t.status !== "open") throw new HttpError(409, "closed", "this thread is closed");
    await checkSources(tx, t.tenantId, body.sources);
    // P-7: the lead's words in the client's working language too, stored beside them (§1.69).
    const translation = body.translate ? (await clientTranslation(tx, t.tenantId)).settings : null;
    if (translation && (!translation.working || !translation.outgoing)) {
      throw new HttpError(
        409,
        "translation_off",
        "this client has no working language to translate into",
      );
    }
    if (translation && body.audience !== "client") {
      throw new HttpError(422, "not_for_client", "only a message to the client is translated");
    }
    const collect: EventRow[] = [];
    const posted = await postAsPerson(
      tx,
      {
        tenantId: t.tenantId,
        thread: t,
        userId: session.user.id,
        operator: true,
        text: body.text,
        sources: body.sources,
        audience: body.audience,
        locale: await tenantLocale(tx, t.tenantId),
      },
      senseEmitPosted({ registry: services.platform.events, collect }),
    );
    if (collect.length > 0) {
      ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
    }
    const first = posted[0];
    if (translation?.working && first) {
      const deps = translationDepsFor(services);
      const to = translation.working;
      ctx.defer(() =>
        translateAndStore(deps.db, deps.transport(t.tenantId), {
          tenantId: t.tenantId,
          source: { kind: "message", id: first.id },
          direction: "out",
          text: body.text,
          to,
          settings: translation,
          requestedBy: session.user.id,
        }),
      );
    }
    return { messages: await opsMessages(tx, t.tenantId, posted) };
  });

  mount(app, routes.opsReadThread, async ({ tx, tenantIds, session, params }) => {
    const t = await threadIn(tx, tenantIds, params.id, {
      kind: "operator",
      userId: session.user.id,
    });
    await markRead(tx, t, session.user.id);
    return { ok: true as const };
  });

  mount(app, routes.opsSetLead, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const tenantId = params.id;
    if (body.userId && !(await servesClient(tx, tenantId, body.userId))) {
      throw new HttpError(422, "not_an_operator", "the lead is an operator who serves this client");
    }
    const before = await setLead(tx, tenantId, body.userId);
    if (before !== body.userId) {
      await tx.insert(tenantChange).values({
        tenantId,
        actorId: session.user.id,
        change: { setting: "lead", from: before, to: body.userId },
        reason: body.reason,
      });
    }
    return { lead: opsLead(await leadOf(tx, tenantId)) };
  });
}

/** The active client's lead for the session payload ("Message Ana"), or null. */
export async function sessionLead(
  db: Db,
  tenantId: string | null,
): Promise<{ name: string } | null> {
  if (!tenantId) return null;
  const lead = await leadOf(db, tenantId);
  return lead ? { name: leadDisplayName(lead) } : null;
}

/** A lead check's first name for the client's timeline, or null. */
export async function leadFirstName(tx: Tx, tenantId: string): Promise<string | null> {
  const lead = await leadOf(tx, tenantId);
  return lead ? firstName(leadDisplayName(lead)) : null;
}

/** v0.17: the owner an account agent's answer was written as, when it was (`body.as`). */
function ownerOf(body: unknown): { name: string; area: OwnerArea } | null {
  const as = (body as { as?: { name?: unknown; area?: unknown } } | null)?.as;
  if (typeof as?.name !== "string") return null;
  const area = OwnerArea.safeParse(as.area);
  return { name: as.name, area: area.success ? area.data : "general" };
}

function ownerName(body: unknown): string | null {
  return ownerOf(body)?.name ?? null;
}
