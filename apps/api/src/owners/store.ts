// v0.17 (ARCHITECTURE §10.15, docs/plan.md §1.96, O3): a client's area owners in the database.
// An owner is created the first time it is needed (a process in its area runs, or the back office
// lists the client's owners), so existing clients get theirs without a backfill script. Every
// function runs inside the caller's client-scoped transaction (invariant 1).

import {
  defaultOwnerDefinition,
  nextOwnerName,
  type OwnerArea,
  OwnerDefinition,
  type PinnedAreaOwner,
  processArea,
  type SkillDefinition,
} from "@countersign/core";
import { agent, areaOwner, areaOwnerVersion, memoryNote, type Tx } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";

/** The packs a bundle's skills need, read from the skill catalog. */
export function packsOf(
  skills: readonly { skill: string }[] | undefined,
  skill: (id: string) => Pick<SkillDefinition, "requiresPacks"> | undefined,
): string[] {
  const out = new Set<string>();
  for (const s of skills ?? []) {
    const id = s.skill.split("@")[0] ?? s.skill;
    for (const p of skill(id)?.requiresPacks ?? []) out.add(p);
  }
  return [...out];
}

/** The area a client agent's process belongs to (`processArea` over its row and bundle). */
export async function areaOfAgent(
  tx: Tx,
  tenantId: string,
  agentId: string,
  definition: { area?: string | undefined; skills?: readonly { skill: string }[] } | undefined,
  skill: (id: string) => Pick<SkillDefinition, "requiresPacks"> | undefined,
): Promise<OwnerArea> {
  const [row] = await tx
    .select({ area: agent.area })
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)));
  return processArea({
    set: row?.area,
    declared: definition?.area,
    requiresPacks: packsOf(definition?.skills, skill),
  });
}

async function pinnedOf(
  tx: Tx,
  tenantId: string,
  area: OwnerArea,
): Promise<PinnedAreaOwner | null> {
  const [row] = await tx
    .select({
      ownerId: areaOwner.id,
      name: areaOwner.name,
      versionId: areaOwnerVersion.id,
      definition: areaOwnerVersion.definition,
    })
    .from(areaOwner)
    .innerJoin(
      areaOwnerVersion,
      and(
        eq(areaOwnerVersion.id, areaOwner.liveVersionId),
        eq(areaOwnerVersion.tenantId, areaOwner.tenantId),
      ),
    )
    .where(and(eq(areaOwner.tenantId, tenantId), eq(areaOwner.area, area)));
  if (!row) return null;
  return {
    ownerId: row.ownerId,
    versionId: row.versionId,
    name: row.name,
    area,
    definition: OwnerDefinition.parse(row.definition),
  };
}

/**
 * The client's owner of an area, created with its first version when there is none: the next
 * name in the client's rotation, no model of its own and no notes (`defaultOwnerDefinition`).
 */
export async function ensureAreaOwner(
  tx: Tx,
  tenantId: string,
  area: OwnerArea,
): Promise<PinnedAreaOwner> {
  const found = await pinnedOf(tx, tenantId, area);
  if (found) return found;
  const names = await tx
    .select({ name: areaOwner.name })
    .from(areaOwner)
    .where(eq(areaOwner.tenantId, tenantId));
  const [made] = await tx
    .insert(areaOwner)
    .values({
      tenantId,
      area,
      name: nextOwnerName(
        tenantId,
        names.map((n) => n.name),
      ),
    })
    .onConflictDoNothing()
    .returning({ id: areaOwner.id });
  if (made) {
    const [v] = await tx
      .insert(areaOwnerVersion)
      .values({
        tenantId,
        ownerId: made.id,
        version: 1,
        definition: defaultOwnerDefinition(),
        authorType: "system",
        changeNote: "Created for the area's first process",
      })
      .returning({ id: areaOwnerVersion.id });
    if (!v) throw new Error("owner version insert returned nothing");
    await tx.update(areaOwner).set({ liveVersionId: v.id }).where(eq(areaOwner.id, made.id));
  }
  // Made here, or by a run that got there first: read what is live.
  const pinned = await pinnedOf(tx, tenantId, area);
  if (!pinned) throw new Error(`no owner of ${area} after creating one`);
  return pinned;
}

/** An owner's memory notes, newest first: what its review reads as data (§10.15). */
export async function ownerMemory(
  tx: Tx,
  tenantId: string,
  ownerId: string,
  limit: number,
): Promise<string[]> {
  const rows = await tx
    .select({ note: memoryNote.note })
    .from(memoryNote)
    .where(and(eq(memoryNote.tenantId, tenantId), eq(memoryNote.ownerId, ownerId)))
    .orderBy(desc(memoryNote.createdAt))
    .limit(limit);
  return rows.map((r) => r.note);
}
