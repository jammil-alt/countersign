// KPIs and the client view, and what happens when credits run out (ARCHITECTURE §9.9, §11.5;
// docs/plan.md §1.50, W2-G). The portal's service view gets KPI labels and values over the
// service's live runs, never the definition (invariant 11); the back office reads the definition
// and a client agent's values. The client admin chooses what happens when credits run out.

import { getAgent } from "@countersign/agents";
import { kpiBounds, routes } from "@countersign/core";
import { agent } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { creditsOutView, setCreditsOut } from "../billing/credits-out";
import { type AppEnv, mount, notFound } from "../http";
import { computeKpis } from "../kpi/compute";
import { liveClientView, readerLocale, serviceView } from "../kpi/view";
import { tenantRow } from "../notify/people";

export function clientViewRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalServiceView, async ({ tx, tenantIds, params, session }) => {
    const tenantId = tenantIds[0] as string;
    const [a] = await tx
      .select()
      .from(agent)
      .where(and(eq(agent.id, params.id), eq(agent.tenantId, tenantId), eq(agent.kind, "client")));
    if (!a || a.testCopy) throw notFound("service");
    const t = await tenantRow(tx, tenantId);
    if (!t) throw notFound("client");
    return serviceView(tx, a, {
      name: a.serviceName ?? a.name,
      locale: readerLocale(t, session.user.id),
      timezone: t.timezone,
      now: new Date(),
    });
  });

  mount(app, routes.opsAgentClientView, async ({ tx, tenantIds, params }) => {
    const row = await getAgent(tx, params.id);
    if (row.tenantId !== null && !tenantIds.includes(row.tenantId)) throw notFound("agent");
    const live = await liveClientView(tx, row);
    const view = live?.view ?? null;
    let values = null;
    if (row.kind === "client" && row.tenantId !== null && view) {
      const t = await tenantRow(tx, row.tenantId);
      if (!t) throw notFound("client");
      const now = new Date();
      // DECISION: the back office reads the values in English, as operators read it.
      values = await computeKpis(tx, { tenantId: row.tenantId, agentId: row.id }, view.kpis, {
        locale: "en",
        boundsOf: (k) => kpiBounds(k.period, now, t.timezone),
      });
    }
    return {
      agent: { id: row.id, kind: row.kind, tenantId: row.tenantId },
      versionId: live?.versionId ?? null,
      clientView: view,
      values,
    };
  });

  mount(app, routes.portalCreditsOut, async ({ tx, tenantIds }) =>
    creditsOutView(tx, tenantIds[0] as string),
  );

  mount(app, routes.portalSetCreditsOut, async ({ tx, tenantIds, body, session }) =>
    setCreditsOut(tx, {
      tenantId: tenantIds[0] as string,
      choice: body.onCreditsOut,
      by: session.user.id,
    }),
  );
}
