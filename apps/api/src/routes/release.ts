// Human release routes (docs/plan.md §1.26 "Human release", phase 4). The client admin turns a
// vault item's release on or off, picks the person, the channel and the window, lists live
// releases and revokes them; the operator may only turn it on (403 to turn it off or change it).
// The person a code went to enters it, or asks for a new one, from their inbox item. No response
// carries a code or its hash.

import { routes } from "@countersign/core";
import { connection } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  enterReleaseCode,
  liveReleases,
  releaseDepsFromEnv,
  releasePeople,
  releaseRequestView,
  releaseView,
  resendReleaseCode,
  revokeRelease,
  setReleaseSetting,
  wakeRelease,
} from "../access/release";
import { type AppEnv, ensureClient, mount, notFound, type Services } from "../http";
import { vaultItem } from "./access";

function deps(services: Services) {
  return releaseDepsFromEnv(services.env, {
    db: services.db,
    platform: services.platform,
    instances: services.instances,
    ...(services.deps.fetch ? { fetch: services.deps.fetch(services.env) } : {}),
  });
}

async function connectionOf(tx: Parameters<typeof releaseView>[0], tenantId: string, id: string) {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, id), eq(connection.tenantId, tenantId)));
  if (!row) throw notFound("connection");
  return row;
}

export function releaseRoutes(app: Hono<AppEnv>): void {
  mount(
    app,
    routes.portalSetRelease,
    async ({ tx, tenantIds, params, body, session, services }) => {
      const tenantId = tenantIds[0] as string;
      const row = await connectionOf(tx, tenantId, params.connectionId);
      await setReleaseSetting(tx, {
        tenantId,
        row,
        body,
        by: "client",
        actorId: session.user.id,
        now: new Date(),
      });
      return { item: await vaultItem(tx, tenantId, services.platform, row.id) };
    },
  );

  mount(app, routes.portalReleases, async ({ tx, tenantIds }) => ({
    releases: await liveReleases(tx, tenantIds[0] as string, { names: "service", now: new Date() }),
  }));

  mount(app, routes.portalRevokeRelease, async ({ tx, tenantIds, params, session, services }) => {
    const tenantId = tenantIds[0] as string;
    const row = await revokeRelease(tx, {
      tenantId,
      releaseId: params.id,
      actorId: session.user.id,
    });
    return { item: await vaultItem(tx, tenantId, services.platform, row.connectionId) };
  });

  mount(app, routes.portalReleaseRequest, async ({ tx, tenantIds, params, session }) => ({
    request: await releaseRequestView(tx, tenantIds[0] as string, params.id, session.user.id),
  }));

  mount(app, routes.portalEnterReleaseCode, async (ctx) => {
    const { tx, tenantIds, params, body, session, services } = ctx;
    const out = await enterReleaseCode(tx, deps(services), {
      tenantId: tenantIds[0] as string,
      inboxItemId: params.id,
      personId: session.user.id,
      code: body.code,
      via: "portal",
      now: new Date(),
    });
    if (out.wake) ctx.afterCommit(() => wakeRelease(services.instances, out.wake));
    return { request: out.view, result: out.result };
  });

  mount(
    app,
    routes.portalResendReleaseCode,
    async ({ tx, tenantIds, params, session, services }) => ({
      request: await resendReleaseCode(tx, deps(services), {
        tenantId: tenantIds[0] as string,
        inboxItemId: params.id,
        personId: session.user.id,
        now: new Date(),
      }),
    }),
  );

  mount(app, routes.opsRelease, async (ctx) => {
    const { tx, params } = ctx;
    ensureClient(ctx, params.clientId);
    const row = await connectionOf(tx, params.clientId, params.connectionId);
    return {
      release: await releaseView(tx, params.clientId, row, { names: "agent", now: new Date() }),
      people: await releasePeople(tx, params.clientId),
    };
  });

  mount(app, routes.opsSetRelease, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.clientId);
    const row = await connectionOf(tx, params.clientId, params.connectionId);
    await setReleaseSetting(tx, {
      tenantId: params.clientId,
      row,
      body,
      by: "operator",
      actorId: session.user.id,
      now: new Date(),
    });
    const after = await connectionOf(tx, params.clientId, params.connectionId);
    return {
      release: await releaseView(tx, params.clientId, after, { names: "agent", now: new Date() }),
    };
  });
}
