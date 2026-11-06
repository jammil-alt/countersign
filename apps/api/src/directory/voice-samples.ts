// Voice samples (ARCHITECTURE v0.12 §6.4, docs/plan.md §1.42): the operator and the client admin
// paste examples of how the client's people write; each is a knowledge entry of kind
// `voice_sample` (packages/documents), cleaned when saved (quoted history cut, card numbers
// redacted, 4,000 characters) and archived beyond 50 per person. Every read and write is in the
// one client's transaction (invariant 1). Mounted from routes/contacts.ts (the people routes).

import { readVoiceSampleMeta, routes, type VoiceSample } from "@countersign/core";
import { appUser, type Tx } from "@countersign/db";
import {
  addVoiceSample,
  archiveKnowledgeEntry,
  editVoiceSample,
  getKnowledgeEntry,
  type KnowledgeAuthor,
  type KnowledgeEntryView,
  KnowledgeError,
  listKnowledgeEntries,
} from "@countersign/documents";
import { inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";

async function samplesOut(tx: Tx, rows: KnowledgeEntryView[]): Promise<VoiceSample[]> {
  const metas = rows.map((r) => readVoiceSampleMeta(r.meta));
  const ids = [...new Set(metas.flatMap((m) => (m ? [m.personUserId] : [])))];
  const people = ids.length
    ? await tx
        .select({ id: appUser.id, name: appUser.name, email: appUser.email })
        .from(appUser)
        .where(inArray(appUser.id, ids))
    : [];
  const names = new Map(people.map((p) => [p.id, p.name ?? p.email]));
  return rows.flatMap((r, i) => {
    const m = metas[i];
    if (!m) return [];
    return [
      {
        id: r.id,
        status: r.status,
        version: r.version,
        title: r.title,
        text: r.body,
        channel: m.channel,
        person: { id: m.personUserId, name: names.get(m.personUserId) ?? null },
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      },
    ];
  });
}

async function one(tx: Tx, row: KnowledgeEntryView) {
  const [sample] = await samplesOut(tx, [row]);
  if (!sample) throw new Error("not a voice sample");
  return { sample };
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KnowledgeError) {
      if (error.code === "not_found") throw notFound("voice sample");
      if (error.code === "not_a_person" || error.code === "no_person") {
        throw new HttpError(422, error.code, error.message);
      }
      throw new HttpError(409, error.code, error.message);
    }
    throw error;
  }
}

async function archive(
  tx: Tx,
  tenantId: string,
  entryId: string,
  baseVersion: number,
  author: KnowledgeAuthor,
) {
  const entry = await getKnowledgeEntry(tx, tenantId, entryId);
  if (entry?.kind !== "voice_sample") throw notFound("voice sample");
  return guard(() => archiveKnowledgeEntry(tx, tenantId, entryId, { baseVersion, author }));
}

export function voiceSampleRouteHandlers(app: Hono<AppEnv>): void {
  // ── Back office ──
  mount(app, routes.opsVoiceSamples, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const rows = await listKnowledgeEntries(ctx.tx, ctx.params.id, {
      kind: "voice_sample",
      includeArchived: ctx.query.show === "all",
    });
    return { samples: await samplesOut(ctx.tx, rows) };
  });
  mount(app, routes.opsVoiceSampleCreate, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await guard(() =>
      addVoiceSample(ctx.tx, ctx.params.id, {
        ...ctx.body,
        author: { id: ctx.session.user.id, role: "operator" },
      }),
    );
    return one(ctx.tx, row);
  });
  mount(app, routes.opsVoiceSampleEdit, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await guard(() =>
      editVoiceSample(ctx.tx, ctx.params.id, ctx.params.entryId, {
        ...ctx.body,
        author: { id: ctx.session.user.id, role: "operator" },
      }),
    );
    return one(ctx.tx, row);
  });
  mount(app, routes.opsVoiceSampleArchive, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await archive(ctx.tx, ctx.params.id, ctx.params.entryId, ctx.body.baseVersion, {
      id: ctx.session.user.id,
      role: "operator",
    });
    return one(ctx.tx, row);
  });

  // ── Portal (client admin) ──
  mount(app, routes.portalVoiceSamples, async ({ tx, tenantIds, query }) => {
    const rows = await listKnowledgeEntries(tx, tenantIds[0] as string, {
      kind: "voice_sample",
      includeArchived: query.show === "all",
    });
    return { samples: await samplesOut(tx, rows) };
  });
  mount(app, routes.portalVoiceSampleCreate, async ({ tx, tenantIds, body, session }) => {
    const row = await guard(() =>
      addVoiceSample(tx, tenantIds[0] as string, {
        ...body,
        author: { id: session.user.id, role: "client_admin" },
      }),
    );
    return one(tx, row);
  });
  mount(app, routes.portalVoiceSampleEdit, async ({ tx, tenantIds, params, body, session }) => {
    const row = await guard(() =>
      editVoiceSample(tx, tenantIds[0] as string, params.id, {
        ...body,
        author: { id: session.user.id, role: "client_admin" },
      }),
    );
    return one(tx, row);
  });
  mount(app, routes.portalVoiceSampleArchive, async ({ tx, tenantIds, params, body, session }) => {
    const row = await archive(tx, tenantIds[0] as string, params.id, body.baseVersion, {
      id: session.user.id,
      role: "client_admin",
    });
    return one(tx, row);
  });
}
