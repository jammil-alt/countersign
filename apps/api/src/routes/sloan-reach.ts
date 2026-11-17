// Where a client's people email and text Sloan (docs/plan.md §1.124): `GET /api/sloan/reach` for
// the client's people, and the client's own under `/api/ops/clients/:id` for its operators.

import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { sloanReach } from "../account/reach";
import { type AppEnv, ensureClient, mount } from "../http";

export function sloanReachRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalSloanReach, async (ctx) =>
    sloanReach(ctx.tx, ctx.tenantIds[0] as string, ctx.services.env.EMAIL_FORWARDING_DOMAIN),
  );
  mount(app, routes.opsSloanReach, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return sloanReach(ctx.tx, ctx.params.id, ctx.services.env.EMAIL_FORWARDING_DOMAIN);
  });
}
