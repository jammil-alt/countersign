// The Desk's routes (ARCHITECTURE §11.1, §14; docs/plan.md §1.39): snooze, undo, edit before
// signing, sign part of a batch, the team and the undo window. Portal routes run inside
// withTenant(the session's one client) and only reach items the portal's inbox filter shows the
// person; the back office's undo and setting act in a client the operator serves.

import type { Approver } from "@countersign/agents";
import {
  clientLanguage,
  parseAcceptLanguage,
  type Role,
  resolveLocale,
  routes,
  undoSecondsOf,
  userLanguage,
} from "@countersign/core";
import { inboxItem, type Tx, tenant } from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import {
  deskState,
  editItem,
  resolveBatch,
  setUndoSeconds,
  snoozeItem,
  teamOf,
  undoItem,
} from "../desk/desk";
import {
  type AppEnv,
  ensureClient,
  mount,
  mountLong,
  notFound,
  type Services,
  txOnly,
} from "../http";
import { type ResolveOutcome, sendResolution } from "../inbox";
import { dispatchEvents } from "../runs/dispatch";
import { forClient, runDepsFromEnv, runtimeFor } from "../runs/execute";
// P-7: message translation
import { translateForContact, translationDepsFor } from "../translate/service";
import { operatorApprovers } from "./ops-clients";
import { portalInboxFilter } from "./portal";

type Scoped = {
  tx: Tx;
  role: Role;
  tenantIds: readonly string[];
  session: { user: { id: string } };
};

const by = (ctx: Scoped): Approver => ({
  userId: ctx.session.user.id,
  role: ctx.role as Approver["role"],
});

/** The ids among `ids` the portal's inbox filter shows this person. */
async function visibleIds(ctx: Scoped, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await ctx.tx
    .select({ id: inboxItem.id })
    .from(inboxItem)
    .where(
      and(
        inArray(inboxItem.id, ids),
        eq(inboxItem.tenantId, ctx.tenantIds[0] as string),
        portalInboxFilter(ctx.role, ctx.session.user.id),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

async function visibleItem(ctx: Scoped, id: string): Promise<void> {
  if (!(await visibleIds(ctx, [id])).has(id)) throw notFound("inbox item");
}

/**
 * After commit: each resolution that is not held in its undo window goes to its run, with a
 * conversation's own event beside it (wave 2c: a v4 conversation step wakes at once).
 */
function sendResumes(
  ctx: {
    afterCommit(task: () => Promise<unknown>): void;
    defer(task: () => Promise<unknown>): void;
  },
  services: Services,
  outcomes: ResolveOutcome[],
  collect: EventRow[],
) {
  for (const outcome of outcomes) {
    if (!outcome.resume && !outcome.conversation) continue;
    ctx.afterCommit(() => sendResolution(services.instances, outcome));
  }
  if (collect.length > 0) {
    ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
  }
}

export function deskRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalSnoozeInbox, async (ctx) => {
    await visibleItem(ctx, ctx.params.id);
    const row = await snoozeItem(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      itemId: ctx.params.id,
      by: by(ctx),
      until: new Date(ctx.body.until),
      now: new Date(),
    });
    return { item: deskState(row) };
  });

  mount(app, routes.portalUndoInbox, async (ctx) => {
    await visibleItem(ctx, ctx.params.id);
    const row = await undoItem(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      itemId: ctx.params.id,
      by: by(ctx),
    });
    return { item: deskState(row) };
  });

  // The runtime's check and a translation open their own transactions: none is held across them
  // (`mountLong`; a Worker's database has one pooled connection).
  mountLong(app, routes.portalEditInbox, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const inTx = txOnly(ctx.inTx);
    await inTx((tx) => visibleItem({ ...ctx, tx }, ctx.params.id));
    const { services } = ctx;
    const runtime = runtimeFor(
      forClient(
        runDepsFromEnv(services.env, {
          db: services.db,
          platform: services.platform,
          instances: services.instances,
        }),
        tenantId,
      ),
    );
    // P-7: a person's words translated for the message's contact (docs/plan.md §1.69).
    const tdeps = translationDepsFor(services);
    const { row, edited, at, translation } = await editItem(inTx, runtime, services.platform, {
      tenantId,
      itemId: ctx.params.id,
      by: { userId: ctx.session.user.id, role: ctx.role as Approver["role"] },
      edited: ctx.body.input as Parameters<typeof editItem>[3]["edited"],
      translate: (text, reachOutId, userId) =>
        translateForContact(inTx, tdeps, { tenantId, reachOutId, text, by: userId }),
    });
    return {
      item: deskState(row),
      edited: { input: edited, at: at.toISOString() },
      ...(translation ? { translation } : {}),
    };
  });

  mount(app, routes.portalBatchResolve, async (ctx) => {
    const collect: EventRow[] = [];
    const outcomes = await resolveBatch(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      by: by(ctx),
      body: ctx.body,
      visible: (ids) => visibleIds(ctx, ids),
      registry: ctx.services.platform.events,
      collect,
    });
    sendResumes(ctx, ctx.services, outcomes, collect);
    return { items: outcomes.map((o) => deskState(o.item)) };
  });

  mount(app, routes.portalTeam, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const [t] = await ctx.tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    const settings = t?.settings ?? {};
    const locale = resolveLocale({
      user: userLanguage(settings, ctx.session.user.id),
      client: clientLanguage(settings),
      browser: parseAcceptLanguage(ctx.c.req.header("accept-language")),
    });
    return {
      members: await teamOf(ctx.tx, { tenantId, locale, platform: ctx.services.platform }),
      settings: { undoSeconds: undoSecondsOf(settings) },
    };
  });

  mount(app, routes.portalDeskSettings, async (ctx) => {
    const undoSeconds = await setUndoSeconds(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      seconds: ctx.body.undoSeconds,
      actorId: ctx.session.user.id,
      side: "client",
    });
    return { settings: { undoSeconds } };
  });

  mount(app, routes.opsUndoInbox, async (ctx) => {
    const [item] = await ctx.tx
      .select({ tenantId: inboxItem.tenantId })
      .from(inboxItem)
      .where(and(eq(inboxItem.id, ctx.params.id), inArray(inboxItem.tenantId, [...ctx.tenantIds])));
    if (!item) throw notFound("inbox item");
    const who = (await operatorApprovers(ctx.tx, ctx.session.user.id, [item.tenantId]))(
      item.tenantId,
    );
    const row = await undoItem(ctx.tx, { tenantId: item.tenantId, itemId: ctx.params.id, by: who });
    return { item: deskState(row) };
  });

  mount(app, routes.opsDeskSettings, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const undoSeconds = await setUndoSeconds(ctx.tx, {
      tenantId: ctx.params.id,
      seconds: ctx.body.undoSeconds,
      actorId: ctx.session.user.id,
      side: "operator",
    });
    return { settings: { undoSeconds } };
  });
}
