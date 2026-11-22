// R6: the portal's saved views (docs/reporting-plan.md §3 R6, docs/plan.md §1.236). A client
// person's named filters for the runs list, and the views a client admin shares with the team.
// Rows are the client's (`portal_view`, forced RLS on the session's one client); RLS can't hold a
// view to its person, so these routes pick the person's own rows, or the shared ones, by `user_id`
// and `shared`, and filter by `tenant_id` too (invariant 1).

import {
  PORTAL_VIEWS_MAX,
  type PortalView,
  portalViewRoutes,
  type RunFilter,
} from "@countersign/core";
import { appUser, portalView, type Tx } from "@countersign/db";
import { and, count, eq, or } from "drizzle-orm";
import type { Hono } from "hono";
import { ensureSeesAgent } from "../assigned";
import { type AppEnv, HttpError, mount, notFound } from "../http";

type Row = typeof portalView.$inferSelect;

function viewOut(v: Row, readerId: string, ownerName: string | null): PortalView {
  const mine = v.userId === readerId;
  return {
    id: v.id,
    name: v.name,
    filters: v.filters as PortalView["filters"],
    shared: v.shared,
    mine,
    ownerName: mine ? null : ownerName,
    updatedAt: v.updatedAt.toISOString(),
  };
}

/** §1.122: a limited client user sees a view only when it names no agent off their list. */
function seesView(agents: readonly string[] | null, filters: RunFilter): boolean {
  if (agents === null) return true;
  return (filters.agents ?? []).every((id) => agents.includes(id));
}

async function ownerName(tx: Tx, userId: string): Promise<string | null> {
  const [u] = await tx
    .select({ name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(eq(appUser.id, userId));
  return u ? (u.name ?? u.email) : null;
}

async function nameTaken(tx: Tx, tenantId: string, userId: string, name: string, except?: string) {
  const rows = await tx
    .select({ id: portalView.id })
    .from(portalView)
    .where(
      and(
        eq(portalView.tenantId, tenantId),
        eq(portalView.userId, userId),
        eq(portalView.name, name),
      ),
    );
  return rows.some((r) => r.id !== except);
}

const taken = (name: string) =>
  new HttpError(409, "name_taken", `you already have a view named ${name}`);
const notAdmin = () => new HttpError(403, "not_admin", "only an admin shares a view with the team");

export function portalViewRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, portalViewRoutes.portalViews, async ({ tx, session, tenantIds, agents }) => {
    const tenantId = tenantIds[0] as string;
    const me = session.user.id;
    const rows = await tx
      .select({ view: portalView, name: appUser.name, email: appUser.email })
      .from(portalView)
      .innerJoin(appUser, eq(appUser.id, portalView.userId))
      .where(
        and(
          eq(portalView.tenantId, tenantId),
          or(eq(portalView.userId, me), eq(portalView.shared, true)),
        ),
      )
      .orderBy(portalView.name);
    return {
      views: rows
        // A shared view naming an agent the person can't see isn't theirs to open (§1.122).
        .filter((r) => r.view.userId === me || seesView(agents, r.view.filters as RunFilter))
        .map((r) => viewOut(r.view, me, r.name ?? r.email))
        // Their own first, then the team's.
        .sort((a, b) => Number(b.mine) - Number(a.mine)),
    };
  });

  mount(
    app,
    portalViewRoutes.portalCreateView,
    async ({ tx, body, session, tenantIds, role, agents }) => {
      const tenantId = tenantIds[0] as string;
      const me = session.user.id;
      if (body.shared && role !== "client_admin") throw notAdmin();
      // A limited client user saves only a filter on agents they see.
      for (const id of body.filters.agents ?? []) ensureSeesAgent(agents, id);
      if (await nameTaken(tx, tenantId, me, body.name)) throw taken(body.name);
      const [n] = await tx
        .select({ n: count() })
        .from(portalView)
        .where(and(eq(portalView.tenantId, tenantId), eq(portalView.userId, me)));
      if ((n?.n ?? 0) >= PORTAL_VIEWS_MAX) {
        throw new HttpError(409, "too_many", `you can keep ${PORTAL_VIEWS_MAX} views`);
      }
      const [row] = await tx
        .insert(portalView)
        .values({
          tenantId,
          userId: me,
          name: body.name,
          filters: body.filters,
          shared: body.shared,
        })
        .returning();
      if (!row) throw new Error("portal view insert returned nothing");
      return { view: viewOut(row, me, null) };
    },
  );

  mount(
    app,
    portalViewRoutes.portalUpdateView,
    async ({ tx, body, params, session, tenantIds, role }) => {
      const tenantId = tenantIds[0] as string;
      const me = session.user.id;
      // DECISION: only the view's owner renames it or changes its sharing; an admin shares only
      // their own views (a client user's view becomes the team's only when an admin saves it).
      const [current] = await tx
        .select()
        .from(portalView)
        .where(
          and(
            eq(portalView.id, params.id),
            eq(portalView.tenantId, tenantId),
            eq(portalView.userId, me),
          ),
        );
      if (!current) throw notFound("view");
      if (body.shared !== undefined && body.shared !== current.shared && role !== "client_admin") {
        throw notAdmin();
      }
      if (body.name !== undefined && (await nameTaken(tx, tenantId, me, body.name, current.id))) {
        throw taken(body.name);
      }
      const [row] = await tx
        .update(portalView)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.shared !== undefined ? { shared: body.shared } : {}),
        })
        .where(and(eq(portalView.id, current.id), eq(portalView.tenantId, tenantId)))
        .returning();
      if (!row) throw notFound("view");
      return { view: viewOut(row, me, await ownerName(tx, row.userId)) };
    },
  );

  mount(
    app,
    portalViewRoutes.portalDeleteView,
    async ({ tx, params, session, tenantIds, role }) => {
      const tenantId = tenantIds[0] as string;
      const me = session.user.id;
      // DECISION: a person deletes their own views; an admin also deletes a view the team shares
      // (its owner may have left), never another person's unshared one.
      const whose =
        role === "client_admin"
          ? or(eq(portalView.userId, me), eq(portalView.shared, true))
          : eq(portalView.userId, me);
      const deleted = await tx
        .delete(portalView)
        .where(and(eq(portalView.id, params.id), eq(portalView.tenantId, tenantId), whose))
        .returning({ id: portalView.id });
      if (deleted.length === 0) throw notFound("view");
      return { deleted: true };
    },
  );
}
