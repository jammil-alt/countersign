// The client's agents' manuals behind `manual.read` (ManualsPort): one client-scoped transaction
// (invariant 1: RLS on the client, and the query filters by it too) that finds the agent by id,
// slug or name and makes the view by code from the version that runs.

import { manualView } from "@countersign/core";
import { agent, agentVersion, type Db, withTenant } from "@countersign/db";
import { and, eq, or, sql } from "drizzle-orm";
import type { ManualsPort } from "../tools/manual";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function dbManualsPort(db: Db): ManualsPort {
  return {
    read(tenantId, name) {
      return withTenant(db, tenantId, async (tx) => {
        const wanted = name.trim();
        const lower = wanted.toLowerCase();
        const [a] = await tx
          .select()
          .from(agent)
          .where(
            and(
              eq(agent.tenantId, tenantId),
              eq(agent.kind, "client"),
              eq(agent.testCopy, false),
              or(
                ...(UUID.test(wanted) ? [eq(agent.id, wanted)] : []),
                eq(agent.slug, wanted),
                sql`lower(${agent.name}) = ${lower}`,
                sql`lower(${agent.serviceName}) = ${lower}`,
              ),
            ),
          )
          .orderBy(agent.createdAt)
          .limit(1);
        if (!a) return null;
        // DECISION: the version that runs; before it has one, the version being set up, as the
        // portal's Manual tab reads it.
        const [v] = a.liveVersionId
          ? await tx
              .select()
              .from(agentVersion)
              .where(and(eq(agentVersion.id, a.liveVersionId), eq(agentVersion.tenantId, tenantId)))
          : await tx
              .select()
              .from(agentVersion)
              .where(and(eq(agentVersion.agentId, a.id), eq(agentVersion.tenantId, tenantId)))
              .orderBy(sql`${agentVersion.version} desc`)
              .limit(1);
        if (!v) return null;
        const { learned: _learned, ...manual } = manualView({
          agent: { id: a.id, name: a.serviceName ?? a.name },
          bundle: v.bundle,
          learned: [],
          audience: "client",
          fallbackWhat: a.serviceDescription,
        });
        return { manual, agentVersionId: v.id };
      });
    },
  };
}
