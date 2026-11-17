// Set-up (docs/cases-plan.md S2; docs/plan.md §1.123.2): a won-over lead becomes a client with a
// build per agent sold, and an agreed expansion opens its builds at the client. Creating a client
// is always the operator's: the route itself is the approval. Each step runs as the operator
// through `invokeRoute` (its roles, scope, checks and audit row, marked as the deal's), the client
// through `opsCreateClient`, the exact path Reggie's `client_create` takes, then `opsStartBuild`
// per agent. Slow routes (mountLong): no transaction is held across the routes they call.

import { type DealKind, routes } from "@countersign/core";
import { build, deal, withOperator } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AppContext,
  type AppEnv,
  HttpError,
  invokeRoute,
  type LongHandlerCtx,
  mountLong,
} from "../http";
import { addActivity, readDeal } from "./deals";

type Session = Parameters<typeof invokeRoute>[2];

interface AgentToBuild {
  name: string;
  templateId: string | null;
  promisedOn?: string | undefined;
}

/** The new deal's stages from which the account may be set up. */
const SETUP_FROM = ["proposal", "setup"] as const;

/**
 * The session the builds are opened with once the client exists: the operator now serves it (its
 * membership was written by the create), so the scope adds it; the id is the one the create
 * returned, never taken from the request.
 */
function servingToo(session: Session, clientId: string): Session {
  return {
    ...session,
    servedTenantIds: [...new Set([...session.servedTenantIds, clientId])],
    activeTenantId: null,
  };
}

/**
 * Opens a build per agent at the client, as the operator, and records on each where it came from,
 * its template and its promised date.
 */
// DECISION: until `StartBuild` takes `path`, `templateId`, `origin` and `promisedOn` (stream A1,
// §1.123.1), set-up writes them on the rows it just made, in the operator's scope. The template
// fork itself is A1's (`path: template` forks through `opsFork` there).
async function openBuilds(
  app: Hono<AppEnv>,
  c: AppContext,
  session: Session,
  db: Parameters<typeof withOperator>[0],
  dealId: string,
  clientId: string,
  agents: readonly AgentToBuild[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const a of agents) {
    const out = await invokeRoute(
      app,
      c,
      session,
      routes.opsStartBuild,
      { body: { kind: "agent", title: a.name, clientId } },
      "deal",
    );
    ids.push(out.build.id);
  }
  await withOperator(db, session.servedTenantIds, async (tx) => {
    for (const [i, a] of agents.entries()) {
      const id = ids[i] as string;
      await tx
        .update(build)
        .set({
          path: a.templateId ? "template" : "new",
          templateId: a.templateId,
          originKind: "deal",
          originId: dealId,
          promisedOn: a.promisedOn ?? null,
        })
        .where(and(eq(build.id, id), eq(build.clientId, clientId)));
    }
  });
  return ids;
}

function setupDone(n: number): string {
  return n === 1 ? "opened 1 build" : `opened ${n} builds`;
}

export function dealSetupRoutes(app: Hono<AppEnv>): void {
  mountLong(app, routes.opsDealSetup, async (ctx) => {
    const row = await ctx.inTx((s) => readDeal(s.tx, s.tenantIds, ctx.params.id));
    if ((row.kind as DealKind) !== "new") {
      throw new HttpError(409, "not_new", "an expansion deal's client already exists");
    }
    if (row.outcome !== "open") throw new HttpError(409, "deal_closed", "this deal is closed");
    if (row.clientId) throw new HttpError(409, "already_set_up", "this account is set up");
    if (!(SETUP_FROM as readonly string[]).includes(row.stage)) {
      throw new HttpError(409, "too_early", "set up the account at the proposal or set-up stage");
    }
    const b = ctx.body;
    // "Creating a client is always yours": this route is the operator's own approval.
    const created = await invokeRoute(
      app,
      ctx.c,
      ctx.session,
      routes.opsCreateClient,
      {
        body: {
          name: b.name,
          ...(b.timezone ? { timezone: b.timezone } : {}),
          ...(b.adminEmail
            ? { admin: { email: b.adminEmail, ...(b.adminName ? { name: b.adminName } : {}) } }
            : {}),
        },
      },
      "deal",
    );
    const clientId = created.client.id;
    // The operator's cookie drops the clients it carries, so the next request serves this one.
    ctx.accountChanged();
    const session = servingToo(ctx.session, clientId);
    const db = ctx.services.db;
    // The deal names its client at once, so a failure while opening builds leaves it set up and
    // the rest can be opened from the deal (open-builds).
    await withOperator(db, session.servedTenantIds, async (tx) => {
      await tx
        .update(deal)
        .set({
          clientId,
          stage: "setup",
          stageAt: new Date(),
          ...(row.agentsSold.length === 0
            ? {
                agentsSold: b.agents.map((a) => ({ name: a.name, templateId: a.templateId })),
                agentCount: Math.max(row.agentCount, b.agents.length),
              }
            : {}),
        })
        .where(eq(deal.id, row.id));
    });
    const buildIds = await openBuilds(app, ctx.c, session, db, row.id, clientId, b.agents);
    await withOperator(db, session.servedTenantIds, (tx) =>
      addActivity(tx, row.id, {
        kind: "system",
        actor: "operator",
        userId: ctx.session.user.id,
        body: `Set up the client and ${setupDone(buildIds.length)}.`,
        meta: { clientId, buildIds, admin: created.admin ? "invited" : "none" },
      }),
    );
    return { clientId, buildIds };
  });

  mountLong(
    app,
    routes.opsDealOpenBuilds,
    async (ctx: LongHandlerCtx<typeof routes.opsDealOpenBuilds>) => {
      const row = await ctx.inTx((s) => readDeal(s.tx, s.tenantIds, ctx.params.id));
      if (!row.clientId) throw new HttpError(409, "no_client", "set up the account first");
      // DECISION: an agreed expansion opens its builds; a new account at set-up may too, to open
      // what a set-up that stopped part way did not.
      const ready =
        row.outcome === "open" &&
        ((row.kind === "expansion" && row.stage === "agreed") ||
          (row.kind === "new" && row.stage === "setup"));
      if (!ready) {
        throw new HttpError(409, "not_agreed", "open the builds once the terms are agreed");
      }
      const clientId = row.clientId;
      const buildIds = await openBuilds(
        app,
        ctx.c,
        ctx.session,
        ctx.services.db,
        row.id,
        clientId,
        ctx.body.agents,
      );
      await ctx.inTx((s) =>
        addActivity(s.tx, row.id, {
          kind: "system",
          actor: "operator",
          userId: ctx.session.user.id,
          body: `Opened ${buildIds.length === 1 ? "1 build" : `${buildIds.length} builds`} at the client.`,
          meta: { buildIds },
        }),
      );
      return { buildIds };
    },
  );
}
