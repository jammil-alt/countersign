// The per-client knowledge base (docs/plan.md §1.21). The back office manages a client's FAQs and
// policies, sees which of its documents are indexed and its agents' memory notes, and tries a
// search as an agent would; the client admin adds and edits the client's own FAQs and policies
// from the portal. Every save inserts a version (packages/documents' knowledge entries), and every
// read runs inside the one client's scope (invariant 1).
//
// The portal sees entries only: no documents index, no memory notes, nothing of an agent.
//
// B6 (docs/builder-plan.md §8): a policy may be the client's charter or a tagged policy (the
// version's meta: tier, tags, who confirmed it). We draft the charter from onboarding's facts; the
// client admin confirms it, and agents read only its latest confirmed version. What the client
// admin writes in the portal is confirmed as they save it; what we write waits for them.

import type {
  KnowledgeDocument,
  KnowledgeEntry,
  KnowledgeEntryVersion,
  KnowledgeMemoryNote,
} from "@countersign/core";
import { type KnowledgeEntryInput, routes } from "@countersign/core";
import { agent, appUser, memoryNote, type Tx } from "@countersign/db";
import {
  archiveKnowledgeEntry,
  charterEntry,
  confirmKnowledgeEntry,
  createKnowledgeEntry,
  editKnowledgeEntry,
  getKnowledgeEntry,
  governanceMeta,
  type IndexedDocumentView,
  indexDocuments,
  indexedDocuments,
  type KnowledgeAuthor,
  type KnowledgeEntryView,
  KnowledgeError,
  type KnowledgeMeta,
  knowledgeEntryVersions,
  latestConfirmedVersion,
  listKnowledgeEntries,
  nextMeta,
  searchKnowledge,
} from "@countersign/documents";
import { and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Hono } from "hono";
import { clientModels } from "../compliance/models";
import { type AppEnv, ensureClient, HttpError, iso, mount, mountLong, notFound } from "../http";
import { charterFacts, draftCharter, saveCharterDraft } from "../knowledge/charter";
import { meterDepsOf, meteredLlm } from "../metering";

/** Where the names come from: the operator's view shows everyone; the portal says "us" for ours. */
type Audience = "ops" | "portal";

async function names(tx: Tx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (wanted.length === 0) return new Map<string, string | null>();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name ?? r.email]));
}

function author(
  a: KnowledgeAuthor,
  people: Map<string, string | null>,
  audience: Audience,
): { role: KnowledgeAuthor["role"]; name: string | null } {
  // DECISION: the portal names the client's own people but not ours; it shows "us" for the
  // operator, as the rest of the portal speaks for Mezonas.
  if (audience === "portal" && a.role === "operator") return { role: a.role, name: null };
  return { role: a.role, name: a.id ? (people.get(a.id) ?? null) : null };
}

/** B6: a version's tier, tags and confirmation, as the API shows them. */
function governanceOut(meta: KnowledgeMeta, people: Map<string, string | null>) {
  const g = governanceMeta(meta);
  return {
    tier: g.tier,
    tags: g.tags,
    confirmed: g.confirmedAt
      ? { by: g.confirmedBy ? (people.get(g.confirmedBy) ?? null) : null, at: g.confirmedAt }
      : null,
  };
}

async function entriesOut(
  tx: Tx,
  tenantId: string,
  rows: KnowledgeEntryView[],
  audience: Audience,
): Promise<KnowledgeEntry[]> {
  // Voice samples (migration 0025) aren't FAQs or policies: they get their own list (W1-G).
  const listed = rows.filter(
    (r): r is KnowledgeEntryView & { kind: KnowledgeEntry["kind"] } => r.kind !== "voice_sample",
  );
  // B6: the version of the charter agents read now.
  const inUse = new Map<string, number | null>();
  for (const r of listed) {
    if (governanceMeta(r.meta).tier !== "charter") continue;
    inUse.set(r.id, (await latestConfirmedVersion(tx, tenantId, r.id))?.version ?? null);
  }
  const people = await names(tx, [
    ...listed.map((r) => r.updatedBy.id),
    ...listed.map((r) => governanceMeta(r.meta).confirmedBy),
  ]);
  return listed.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    version: r.version,
    title: r.title,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: author(r.updatedBy, people, audience),
    ...governanceOut(r.meta, people),
    ...(inUse.has(r.id) ? { inUseVersion: inUse.get(r.id) ?? null } : {}),
  }));
}

async function entryOut(tx: Tx, tenantId: string, row: KnowledgeEntryView, audience: Audience) {
  const [entry] = await entriesOut(tx, tenantId, [row], audience);
  if (!entry) throw new Error("no entry");
  return { entry };
}

function documentOut(d: IndexedDocumentView): KnowledgeDocument {
  return {
    id: d.id,
    filename: d.filename,
    source: d.source,
    status: d.status,
    receivedAt: d.receivedAt.toISOString(),
    title: d.title,
    passages: d.passages,
    indexed: d.indexed,
  };
}

/** Knowledge errors as HTTP: a stale edit or a second archive is a conflict. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KnowledgeError) {
      if (error.code === "not_found") throw notFound("entry");
      throw new HttpError(409, error.code, error.message);
    }
    throw error;
  }
}

// v0.12 W1-G: a voice sample is edited through its own routes, which clean its text (§1.42).
async function faqOrPolicy(tx: Tx, tenantId: string, entryId: string) {
  const entry = await getKnowledgeEntry(tx, tenantId, entryId);
  if (!entry || entry.kind === "voice_sample") throw notFound("entry");
  return entry;
}

/** B6: a new entry's meta: its tier and tags; one the client admin writes is confirmed by them. */
async function newMeta(
  tx: Tx,
  tenantId: string,
  body: KnowledgeEntryInput,
  confirm: { by: string; at: Date } | undefined,
): Promise<KnowledgeMeta> {
  if (body.kind !== "policy") return {};
  // One charter per client: a second one is refused; the first is edited instead.
  if (body.tier === "charter" && (await charterEntry(tx, tenantId))) {
    throw new HttpError(409, "charter_exists", "This client already has a charter: edit it.");
  }
  return nextMeta(
    { ...(body.tier ? { tier: body.tier } : {}) },
    { tags: body.tags, ...(body.tier && confirm ? { confirm } : {}) },
  );
}

async function memoryNotes(tx: Tx, tenantId: string) {
  // Live notes only: a test run's notes are tagged with the run and stay out (ARCHITECTURE §10.4).
  // An agent's own notes: an area owner's (ARCHITECTURE v0.19 §10.15) are on the owner's page.
  const where = and(
    eq(memoryNote.tenantId, tenantId),
    eq(memoryNote.scope, "agent"),
    isNotNull(memoryNote.agentId),
  );
  const [total] = await tx.select({ n: count() }).from(memoryNote).where(where);
  const rows = await tx
    .select({
      id: memoryNote.id,
      note: memoryNote.note,
      createdAt: memoryNote.createdAt,
      agentId: agent.id,
      agentName: agent.name,
      serviceName: agent.serviceName,
    })
    .from(memoryNote)
    .innerJoin(
      agent,
      and(eq(agent.id, memoryNote.agentId), eq(agent.tenantId, memoryNote.tenantId)),
    )
    .where(where)
    .orderBy(desc(memoryNote.createdAt), desc(memoryNote.id))
    .limit(50);
  const recent: KnowledgeMemoryNote[] = rows.map((r) => ({
    id: r.id,
    agent: { id: r.agentId, name: r.serviceName ?? r.agentName },
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
  return { count: Number(total?.n ?? 0), recent };
}

function versionsOut(
  rows: Awaited<ReturnType<typeof knowledgeEntryVersions>>,
  people: Map<string, string | null>,
): KnowledgeEntryVersion[] {
  return rows.map((v) => ({
    id: v.id,
    version: v.version,
    title: v.title,
    body: v.body,
    status: v.status,
    author: author(v.author, people, "ops"),
    createdAt: iso(v.createdAt) ?? v.createdAt.toISOString(),
    ...governanceOut(v.meta, people),
  }));
}

export function knowledgeRouteHandlers(app: Hono<AppEnv>): void {
  // ── Back office ────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.opsKnowledge, async (ctx) => {
    const { tx, params, query } = ctx;
    ensureClient(ctx, params.id);
    // Documents new or read again since they were last indexed are indexed now (lazily).
    await indexDocuments(tx, params.id);
    const entries = await listKnowledgeEntries(tx, params.id, {
      includeArchived: query.show === "all",
    });
    return {
      entries: await entriesOut(tx, params.id, entries, "ops"),
      documents: (await indexedDocuments(tx, params.id)).map(documentOut),
      memoryNotes: await memoryNotes(tx, params.id),
    };
  });

  mount(app, routes.opsKnowledgeCreate, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const row = await createKnowledgeEntry(tx, params.id, {
      kind: body.kind,
      title: body.title,
      body: body.body,
      // What we write is not confirmed: the client admin confirms it.
      meta: await newMeta(tx, params.id, body, undefined),
      author: { id: session.user.id, role: "operator" },
    });
    return entryOut(tx, params.id, row, "ops");
  });

  mount(app, routes.opsKnowledgeEdit, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const current = await faqOrPolicy(tx, params.id, params.entryId);
    const row = await guard(() =>
      editKnowledgeEntry(tx, params.id, params.entryId, {
        title: body.title,
        body: body.body,
        baseVersion: body.baseVersion,
        // B6: our edit is never confirmed; agents keep reading the confirmed charter until then.
        meta: nextMeta(current.meta, { tags: current.kind === "policy" ? body.tags : undefined }),
        author: { id: session.user.id, role: "operator" },
      }),
    );
    return entryOut(tx, params.id, row, "ops");
  });

  mount(app, routes.opsKnowledgeArchive, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const row = await guard(() =>
      archiveKnowledgeEntry(tx, params.id, params.entryId, {
        baseVersion: body.baseVersion,
        author: { id: session.user.id, role: "operator" },
      }),
    );
    return entryOut(tx, params.id, row, "ops");
  });

  mount(app, routes.opsKnowledgeVersions, async (ctx) => {
    const { tx, params } = ctx;
    ensureClient(ctx, params.id);
    const entry = await getKnowledgeEntry(tx, params.id, params.entryId);
    if (!entry) throw notFound("entry");
    const rows = await knowledgeEntryVersions(tx, params.id, params.entryId);
    const people = await names(tx, [
      ...rows.map((r) => r.author.id),
      ...rows.map((r) => governanceMeta(r.meta).confirmedBy),
    ]);
    return { versions: versionsOut(rows, people) };
  });

  // B6: the charter drafted from onboarding's facts. The model call runs between two short
  // transactions (`mountLong`), never inside one.
  mountLong(app, routes.opsKnowledgeCharterDraft, async (ctx) => {
    const { params, services, session } = ctx;
    ensureClient(ctx, params.id);
    const facts = await ctx.inTx(({ tx }) => charterFacts(tx, params.id));
    // §1.210: our own cost, as the back office's other model calls are: recorded as ours once
    // the request ends, never the client's usage.
    const { llm } = meteredLlm(meterDepsOf(ctx), {
      transport: clientModels(services, { clients: [params.id], read: services.db }),
      tenantId: params.id,
      source: "assist",
    });
    const draft = await draftCharter(llm, facts);
    return ctx.inTx(async ({ tx }) => {
      const row = await saveCharterDraft(tx, params.id, draft.body, {
        id: session.user.id,
        role: "operator",
      });
      return {
        ...(await entryOut(tx, params.id, row, "ops")),
        from: { facts: facts.facts.length, about: facts.about.length },
      };
    });
  });

  mount(app, routes.opsKnowledgeSearch, async (ctx) => {
    const { tx, params, query } = ctx;
    ensureClient(ctx, params.id);
    await indexDocuments(tx, params.id);
    // DECISION: the back office's preview searches every agent's live memory notes of the client
    // (an agent's own search sees only its own), so the operator sees all that could be found.
    const results = await searchKnowledge(tx, params.id, {
      query: query.q,
      limit: query.limit,
      memory: "all",
    });
    return { results };
  });

  // ── Portal (client admin) ──────────────────────────────────────────────────────────────────────
  // DECISION: only the client admin manages the client's FAQs and policies; client users don't
  // see them in the portal (agents use them; people ask the admin).
  mount(app, routes.portalKnowledge, async ({ tx, tenantIds, query }) => {
    const tenantId = tenantIds[0] as string;
    const rows = await listKnowledgeEntries(tx, tenantId, {
      includeArchived: query.show === "all",
    });
    return { entries: await entriesOut(tx, tenantId, rows, "portal") };
  });

  mount(app, routes.portalKnowledgeCreate, async ({ tx, tenantIds, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const row = await createKnowledgeEntry(tx, tenantId, {
      kind: body.kind,
      title: body.title,
      body: body.body,
      // The client admin's own charter or policy is confirmed as they save it.
      meta: await newMeta(tx, tenantId, body, { by: session.user.id, at: new Date() }),
      author: { id: session.user.id, role: "client_admin" },
    });
    return entryOut(tx, tenantId, row, "portal");
  });

  mount(app, routes.portalKnowledgeEdit, async ({ tx, tenantIds, params, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const current = await faqOrPolicy(tx, tenantId, params.id);
    const governed = governanceMeta(current.meta).tier !== null;
    const row = await guard(() =>
      editKnowledgeEntry(tx, tenantId, params.id, {
        title: body.title,
        body: body.body,
        baseVersion: body.baseVersion,
        // DECISION (B6): the client admin's edit of their charter or a tiered policy confirms it:
        // they wrote the words, so agents read them at once.
        meta: nextMeta(current.meta, {
          tags: current.kind === "policy" ? body.tags : undefined,
          ...(governed ? { confirm: { by: session.user.id, at: new Date() } } : {}),
        }),
        author: { id: session.user.id, role: "client_admin" },
      }),
    );
    return entryOut(tx, tenantId, row, "portal");
  });

  mount(app, routes.portalKnowledgeConfirm, async ({ tx, tenantIds, params, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const current = await faqOrPolicy(tx, tenantId, params.id);
    if (current.kind !== "policy") throw notFound("entry");
    const row = await guard(() =>
      confirmKnowledgeEntry(tx, tenantId, params.id, {
        baseVersion: body.baseVersion,
        author: { id: session.user.id, role: "client_admin" },
        at: new Date(),
      }),
    );
    return entryOut(tx, tenantId, row, "portal");
  });

  mount(app, routes.portalKnowledgeArchive, async ({ tx, tenantIds, params, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const row = await guard(() =>
      archiveKnowledgeEntry(tx, tenantId, params.id, {
        baseVersion: body.baseVersion,
        author: { id: session.user.id, role: "client_admin" },
      }),
    );
    return entryOut(tx, tenantId, row, "portal");
  });
}
