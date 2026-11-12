// v0.17 O6 (ARCHITECTURE §10.15 "Home", docs/plan.md §1.96): Home's "Your agents" and "Ideas".
// Each owner of the client with its health in a word, its processes' runs this week, how many of
// them it corrected and finished, and the last thing it did in the platform's words; and the areas
// the client doesn't use yet. Portal data only (invariant 11): no notes, model or cost.

import {
  AREA_IDEAS,
  type HomeIdea,
  type HomeOwner,
  type Locale,
  OWNER_AREAS,
  type OwnerArea,
  oversightLine,
  ownerDid,
  type SkillDefinition,
} from "@countersign/core";
import { agent, areaOwner, inboxItem, oversightDecision, run, type Tx } from "@countersign/db";
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { ensureAreaOwner, processesOf } from "./store";

export async function homeOwners(
  tx: Tx,
  tenantId: string,
  input: {
    since: Date;
    locale: Locale;
    catalog: { get(id: string): Pick<SkillDefinition, "requiresPacks"> | undefined };
  },
): Promise<{ owners: HomeOwner[]; ideas: HomeIdea[] }> {
  const processes = await processesOf(tx, tenantId, { catalog: input.catalog });
  const areas = [...new Set(processes.map((p) => p.area))];
  for (const area of areas) await ensureAreaOwner(tx, tenantId, area);
  const rows = await tx.select().from(areaOwner).where(eq(areaOwner.tenantId, tenantId));
  const order = (a: OwnerArea) => OWNER_AREAS.indexOf(a);

  const owners: HomeOwner[] = [];
  for (const o of rows.sort((a, b) => order(a.area) - order(b.area))) {
    const ids = processes.filter((p) => p.area === o.area).map((p) => p.agentId);
    if (ids.length === 0) {
      owners.push({
        id: o.id,
        name: o.name,
        area: o.area,
        processes: 0,
        health: "working",
        runs: 0,
        corrected: 0,
        last: null,
      });
      continue;
    }
    const runs = await tx
      .select({ id: run.id })
      .from(run)
      .where(
        and(
          eq(run.tenantId, tenantId),
          inArray(run.agentId, ids),
          eq(run.mode, "live"),
          gte(run.createdAt, input.since),
        ),
      );
    const runIds = runs.map((r) => r.id);
    const decisions = runIds.length
      ? await tx
          .select({ action: oversightDecision.action, field: oversightDecision.nodeId })
          .from(oversightDecision)
          .where(
            and(
              eq(oversightDecision.tenantId, tenantId),
              inArray(oversightDecision.runId, runIds),
              ne(oversightDecision.action, "stop"),
            ),
          )
          .orderBy(desc(oversightDecision.createdAt))
      : [];
    const [waiting] = await tx
      .select({ id: inboxItem.id })
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, tenantId),
          inArray(inboxItem.agentId, ids),
          eq(inboxItem.status, "open"),
          ne(inboxItem.assigneeRole, "operator"),
        ),
      )
      .limit(1);
    const states = await tx
      .select({ runStatus: agent.runStatus })
      .from(agent)
      .where(and(eq(agent.tenantId, tenantId), inArray(agent.id, ids)));
    const paused = states.length > 0 && states.every((s) => s.runStatus === "paused");
    const latest = decisions[0];
    owners.push({
      id: o.id,
      name: o.name,
      area: o.area,
      processes: ids.length,
      health: waiting ? "needs_you" : paused ? "paused" : "working",
      runs: runIds.length,
      corrected: decisions.filter((d) => d.action === "retry_with" || d.action === "retry").length,
      last: latest
        ? ownerDid(input.locale, o.name, oversightLine(input.locale, { action: latest.action }))
        : null,
    });
  }
  const used = new Set(rows.map((r) => r.area));
  const ideas = OWNER_AREAS.filter((a) => a !== "general" && !used.has(a)).map((a) => ({
    area: a,
    ...AREA_IDEAS[a],
  }));
  return { owners, ideas };
}
