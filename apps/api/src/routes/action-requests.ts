// Request an action (docs/step-model-plan.md §10c): the back office's, from a connector's page or an
// agent's, and the client's, from their account. See ../dev-queue/ask.ts.

import { actionRequestRoutes } from "@countersign/core";
import type { Hono } from "hono";
import { requestAction } from "../dev-queue/ask";
import type { DqCtx } from "../dev-queue/service";
import { type AppEnv, mountLong } from "../http";

export function actionRequestApiRoutes(app: Hono<AppEnv>): void {
  mountLong(app, actionRequestRoutes.opsRequestAction, async (ctx) => {
    const dq: DqCtx = {
      services: ctx.services,
      inTx: ctx.inTx,
      userId: ctx.session.user.id,
      actor: "operator",
      now: () => new Date(),
    };
    return requestAction(
      ctx.services,
      { userId: ctx.session.user.id, from: "operator", clientId: ctx.body.clientId },
      ctx.body,
      dq,
    );
  });

  // A client says what they need in their own words; they are told we have it, and nothing more.
  mountLong(app, actionRequestRoutes.portalRequestAction, async (ctx) => {
    await requestAction(
      ctx.services,
      { userId: ctx.session.user.id, from: "client", clientId: ctx.tenantIds[0] },
      { what: ctx.body.what },
    );
    return { received: true as const };
  });
}
