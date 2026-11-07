// Sloan, the account agent (ARCHITECTURE §9.8, §14; docs/plan.md §1.47): the operator installs a
// seeded platform template version (the supervisor's v2 where the seed never runs); the client
// admin signs or declines a change Sloan drafted, which the portal's own code then applies.

import { routes } from "@countersign/core";
import type { EventRow } from "@countersign/senses";
import type { Hono } from "hono";
import { resolveAccountChange } from "../account/changes";
import { installPlatformTemplate } from "../account/templates";
import { type AppEnv, mount } from "../http";
import { dispatchEvents } from "../runs/dispatch";

export function accountRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsInstallPlatformTemplate, async ({ tx, params, body, session, services }) =>
    installPlatformTemplate(tx, {
      slug: params.slug,
      version: body.version,
      actorId: session.user.id,
      platform: services.platform,
    }),
  );

  mount(app, routes.portalResolveAccountChange, async (ctx) => {
    const collect: EventRow[] = [];
    const out = await resolveAccountChange(ctx, {
      // The session's one client, never one from the request.
      tenantId: ctx.tenantIds[0] as string,
      itemId: ctx.params.id,
      decision: ctx.body.decision,
      note: ctx.body.note,
      collect,
    });
    if (collect.length > 0) {
      const { db, instances } = ctx.services;
      ctx.defer(() => dispatchEvents({ db, instances }, collect));
    }
    return out;
  });
}
