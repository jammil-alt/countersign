// The per-client knowledge base (docs/plan.md §1.21). The back office manages a client's FAQs and
// policies, sees which of its documents are indexed and its agents' memory notes, and tries a
// search as an agent would; the client admin adds and edits the client's own FAQs and policies
// from the portal. Every save inserts a version (packages/documents' knowledge entries), and every
// read runs inside the one client's scope (invariant 1).
//
// The portal sees entries only: no documents index, no memory notes, nothing of an agent.

import type {
  KnowledgeDocument,
  KnowledgeEntry,
  KnowledgeEntryVersion,
  KnowledgeMemoryNote,
} from "@countersign/core";
import { routes } from "@countersign/core";
import { agent, appUser, memoryNote, type Tx } from "@countersign/db";
import {
  archiveKnowledgeEntry,
  createKnowledgeEntry,
  editKnowledgeEntry,
  getKnowledgeEntry,
  type IndexedDocumentView,
  indexDocuments,
  indexedDocuments,
  type KnowledgeAuthor,
  type KnowledgeEntryView,
  KnowledgeError,
  knowledgeEntryVersions,
  listKnowledgeEntries,
  searchKnowledge,
} from "@countersign/documents";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, iso, mount, notFound } from "../http";

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

async function entriesOut(
  tx: Tx,
  rows: KnowledgeEntryView[],
  audience: Audience,
): Promise<KnowledgeEntry[]> {
  const people = await names(
    tx,
    rows.map((r) => r.updatedBy.id),
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    version: r.version,
    title: r.title,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: author(r.updatedBy, people, audience),
  }));
}

async function entryOut(tx: Tx, row: KnowledgeEntryView, audience: Audience) {
  const [entry] = await entriesOut(tx, [row], audience);
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

async function memoryNotes(tx: Tx, tenantId: string) {
  // Live notes only: a test run's notes are tagged with the run and stay out (ARCHITECTURE §10.4).
  const where = and(eq(memoryNote.tenantId, tenantId), eq(memoryNote.scope, "agent"));
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
      entries: await entriesOut(tx, entries, "ops"),
      documents: (await indexedDocuments(tx, params.id)).map(documentOut),
      memoryNotes: await memoryNotes(tx, params.id),
    };
  });

  mount(app, routes.opsKnowledgeCreate, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const row = await createKnowledgeEntry(tx, params.id, {
      ...body,
      author: { id: session.user.id, role: "operator" },
    });
    return entryOut(tx, row, "ops");
  });

  mount(app, routes.opsKnowledgeEdit, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const row = await guard(() =>
      editKnowledgeEntry(tx, params.id, params.entryId, {
        ...body,
        author: { id: session.user.id, role: "operator" },
      }),
    );
    return entryOut(tx, row, "ops");
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
    return entryOut(tx, row, "ops");
  });

  mount(app, routes.opsKnowledgeVersions, async (ctx) => {
    const { tx, params } = ctx;
    ensureClient(ctx, params.id);
    const entry = await getKnowledgeEntry(tx, params.id, params.entryId);
    if (!entry) throw notFound("entry");
    const rows = await knowledgeEntryVersions(tx, params.id, params.entryId);
    const people = await names(
      tx,
      rows.map((r) => r.author.id),
    );
    return { versions: versionsOut(rows, people) };
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
    return { entries: await entriesOut(tx, rows, "portal") };
  });

  mount(app, routes.portalKnowledgeCreate, async ({ tx, tenantIds, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const row = await createKnowledgeEntry(tx, tenantId, {
      ...body,
      author: { id: session.user.id, role: "client_admin" },
    });
    return entryOut(tx, row, "portal");
  });

  mount(app, routes.portalKnowledgeEdit, async ({ tx, tenantIds, params, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const row = await guard(() =>
      editKnowledgeEntry(tx, tenantId, params.id, {
        ...body,
        author: { id: session.user.id, role: "client_admin" },
      }),
    );
    return entryOut(tx, row, "portal");
  });

  mount(app, routes.portalKnowledgeArchive, async ({ tx, tenantIds, params, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const row = await guard(() =>
      archiveKnowledgeEntry(tx, tenantId, params.id, {
        baseVersion: body.baseVersion,
        author: { id: session.user.id, role: "client_admin" },
      }),
    );
    return entryOut(tx, row, "portal");
  });
}
