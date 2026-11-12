// v0.17 (ARCHITECTURE §10.15, docs/plan.md §1.96, O4): a client's area owners, in the back office
// (everything: model, notes, review defaults, memory notes, the area of each process) and in the
// portal (each owner's name and area; the client admin may rename one). Invariant 11: no notes,
// model or cost reach the portal.

import {
  type OpsOwnerView,
  OWNER_AREAS,
  type OwnerArea,
  OwnerDefinition,
  ownerNameProblem,
  type PortalOwnerView,
  processArea,
  routes,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  areaOwner,
  areaOwnerVersion,
  memoryNote,
  type Tx,
} from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { ensureAreaOwner, packsOf } from "../owners/store";
import type { Platform } from "../platform";

/** A client's processes (its client agents, test copies left out), each with its area. */
async function processesOf(
  tx: Tx,
  tenantId: string,
  platform: Platform,
): Promise<{ agentId: string; name: string; area: OwnerArea; areaSet: boolean }[]> {
  const rows = await tx
    .select({
      id: agent.id,
      name: agent.name,
      serviceName: agent.serviceName,
      area: agent.area,
      bundle: agentVersion.bundle,
    })
    .from(agent)
    .leftJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
    )
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        ne(agent.status, "disabled"),
      ),
    )
    .orderBy(asc(agent.name));
  return rows.map((r) => {
    const definition = (
      r.bundle as { definition?: { area?: string; skills?: { skill: string }[] } }
    )?.definition;
    return {
      agentId: r.id,
      name: r.serviceName ?? r.name,
      area: processArea({
        set: r.area,
        declared: definition?.area,
        requiresPacks: packsOf(definition?.skills, (id) => platform.catalog.get(id)),
      }),
      areaSet: r.area !== null,
    };
  });
}

async function ownerView(
  tx: Tx,
  ownerId: string,
  tenantIds: readonly string[],
  platform: Platform,
): Promise<OpsOwnerView> {
  const [row] = await tx
    .select({ o: areaOwner, v: areaOwnerVersion })
    .from(areaOwner)
    .innerJoin(
      areaOwnerVersion,
      and(
        eq(areaOwnerVersion.id, areaOwner.liveVersionId),
        eq(areaOwnerVersion.tenantId, areaOwner.tenantId),
      ),
    )
    .where(and(eq(areaOwner.id, ownerId), inArray(areaOwner.tenantId, [...tenantIds])));
  if (!row) throw notFound("owner");
  const definition = OwnerDefinition.parse(row.v.definition);
  const processes = (await processesOf(tx, row.o.tenantId, platform))
    .filter((p) => p.area === row.o.area)
    .map(({ area: _a, ...p }) => p);
  const memory = await tx
    .select({ id: memoryNote.id, note: memoryNote.note, createdAt: memoryNote.createdAt })
    .from(memoryNote)
    .where(and(eq(memoryNote.tenantId, row.o.tenantId), eq(memoryNote.ownerId, row.o.id)))
    .orderBy(desc(memoryNote.createdAt))
    .limit(100);
  return {
    id: row.o.id,
    tenantId: row.o.tenantId,
    area: row.o.area,
    name: row.o.name,
    avatar: row.o.avatar,
    version: row.v.version,
    versionId: row.v.id,
    model: definition.model ?? null,
    notes: definition.notes,
    oversight: definition.oversight ?? null,
    processes,
    memory: memory.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
  };
}

async function ownerTenant(tx: Tx, ownerId: string, tenantIds: readonly string[]) {
  const [row] = await tx
    .select({ tenantId: areaOwner.tenantId, area: areaOwner.area, name: areaOwner.name })
    .from(areaOwner)
    .where(and(eq(areaOwner.id, ownerId), inArray(areaOwner.tenantId, [...tenantIds])));
  if (!row) throw notFound("owner");
  return row;
}

/** Renames an owner after the checks on a name (2 to 12 letters, not Sloan, not a sibling's). */
async function rename(tx: Tx, ownerId: string, tenantIds: readonly string[], name: string) {
  const { tenantId } = await ownerTenant(tx, ownerId, tenantIds);
  const others = await tx
    .select({ name: areaOwner.name })
    .from(areaOwner)
    .where(and(eq(areaOwner.tenantId, tenantId), ne(areaOwner.id, ownerId)));
  const problem = ownerNameProblem(
    name,
    others.map((o) => o.name),
  );
  if (problem) {
    const why = {
      length: "a name is 2 to 12 letters",
      letters: "a name is letters only (a hyphen or an apostrophe inside is fine)",
      reserved: "Sloan is your account assistant's name",
      taken: "another of your agents has that name",
    }[problem];
    throw new HttpError(422, `name_${problem}`, why);
  }
  await tx
    .update(areaOwner)
    .set({ name: name.trim() })
    .where(and(eq(areaOwner.id, ownerId), eq(areaOwner.tenantId, tenantId)));
}

const portalView = (o: typeof areaOwner.$inferSelect): PortalOwnerView => ({
  id: o.id,
  name: o.name,
  area: o.area,
  avatar: o.avatar,
});

export function ownerRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsClientOwners, async (ctx) => {
    const { tx, params, services } = ctx;
    ensureClient(ctx, params.id);
    // One owner for each area the client's processes are in, created on first look.
    const areas = new Set((await processesOf(tx, params.id, services.platform)).map((p) => p.area));
    for (const area of OWNER_AREAS) {
      if (areas.has(area)) await ensureAreaOwner(tx, params.id, area);
    }
    const ids = await tx
      .select({ id: areaOwner.id })
      .from(areaOwner)
      .where(eq(areaOwner.tenantId, params.id));
    const owners = await Promise.all(
      ids.map((o) => ownerView(tx, o.id, ctx.tenantIds, services.platform)),
    );
    const order = (a: OwnerArea) => OWNER_AREAS.indexOf(a);
    return { owners: owners.sort((a, b) => order(a.area) - order(b.area)) };
  });

  mount(app, routes.opsOwner, async (ctx) => {
    const { tx, params, services } = ctx;
    const owner = await ownerView(tx, params.id, ctx.tenantIds, services.platform);
    const versions = await tx
      .select({
        version: areaOwnerVersion.version,
        authorType: areaOwnerVersion.authorType,
        changeNote: areaOwnerVersion.changeNote,
        createdAt: areaOwnerVersion.createdAt,
      })
      .from(areaOwnerVersion)
      .where(
        and(eq(areaOwnerVersion.ownerId, owner.id), eq(areaOwnerVersion.tenantId, owner.tenantId)),
      )
      .orderBy(desc(areaOwnerVersion.version));
    return {
      owner,
      versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    };
  });

  mount(app, routes.opsOwnerVersion, async (ctx) => {
    const { tx, params, body, services, session } = ctx;
    const { tenantId } = await ownerTenant(tx, params.id, ctx.tenantIds);
    if (body.model && !knownModelIds().includes(body.model.id)) {
      throw new HttpError(422, "unknown_model", `${body.model.id} is not a model we can price`);
    }
    const definition = OwnerDefinition.parse({
      ...(body.model ? { model: body.model } : {}),
      notes: body.notes,
      ...(body.oversight ? { oversight: body.oversight } : {}),
    });
    const [last] = await tx
      .select({ version: areaOwnerVersion.version })
      .from(areaOwnerVersion)
      .where(and(eq(areaOwnerVersion.ownerId, params.id), eq(areaOwnerVersion.tenantId, tenantId)))
      .orderBy(desc(areaOwnerVersion.version))
      .limit(1);
    const [v] = await tx
      .insert(areaOwnerVersion)
      .values({
        tenantId,
        ownerId: params.id,
        version: (last?.version ?? 0) + 1,
        definition,
        authorType: "operator",
        authorId: session.user.id,
        changeNote: body.changeNote ?? null,
      })
      .returning({ id: areaOwnerVersion.id });
    if (!v) throw new Error("owner version insert returned nothing");
    await tx
      .update(areaOwner)
      .set({ liveVersionId: v.id })
      .where(and(eq(areaOwner.id, params.id), eq(areaOwner.tenantId, tenantId)));
    return { owner: await ownerView(tx, params.id, ctx.tenantIds, services.platform) };
  });

  mount(app, routes.opsOwnerRename, async (ctx) => {
    const { tx, params, body, services } = ctx;
    await rename(tx, params.id, ctx.tenantIds, body.name);
    return { owner: await ownerView(tx, params.id, ctx.tenantIds, services.platform) };
  });

  mount(app, routes.opsOwnerForget, async (ctx) => {
    const { tx, params } = ctx;
    const { tenantId } = await ownerTenant(tx, params.id, ctx.tenantIds);
    const gone = await tx
      .delete(memoryNote)
      .where(
        and(
          eq(memoryNote.id, params.noteId),
          eq(memoryNote.tenantId, tenantId),
          eq(memoryNote.ownerId, params.id),
        ),
      )
      .returning({ id: memoryNote.id });
    if (gone.length === 0) throw notFound("memory note");
    return { ok: true as const };
  });

  mount(app, routes.opsAgentArea, async (ctx) => {
    const { tx, params, body, services } = ctx;
    const [row] = await tx
      .select({ tenantId: agent.tenantId, kind: agent.kind })
      .from(agent)
      .where(and(eq(agent.id, params.id), inArray(agent.tenantId, [...ctx.tenantIds])));
    if (!row?.tenantId || row.kind !== "client") throw notFound("client agent");
    await tx
      .update(agent)
      .set({ area: body.area })
      .where(and(eq(agent.id, params.id), eq(agent.tenantId, row.tenantId)));
    const area =
      (await processesOf(tx, row.tenantId, services.platform)).find((p) => p.agentId === params.id)
        ?.area ?? "general";
    await ensureAreaOwner(tx, row.tenantId, area);
    return { agentId: params.id, area };
  });

  mount(app, routes.owners, async (ctx) => {
    const { tx, tenantIds } = ctx;
    const tenantId = tenantIds[0] as string;
    const rows = await tx.select().from(areaOwner).where(eq(areaOwner.tenantId, tenantId));
    const order = (a: OwnerArea) => OWNER_AREAS.indexOf(a);
    return { owners: rows.sort((a, b) => order(a.area) - order(b.area)).map(portalView) };
  });

  mount(app, routes.ownerRename, async (ctx) => {
    const { tx, params, body, tenantIds } = ctx;
    await rename(tx, params.id, tenantIds, body.name);
    const [row] = await tx.select().from(areaOwner).where(eq(areaOwner.id, params.id));
    if (!row) throw notFound("owner");
    return { owner: portalView(row) };
  });
}
