// Invite and Sign up now (docs/plan.md §1.149; docs/cases-plan.md §4.2, §4.3): the operator's
// confirm, always (cases-plan §6). The previews change nothing; the sends run `runInvite`
// (../onboarding/invite.ts) as slow routes, since they call other routes through `invokeRoute`.
// Sign up now is Invite with a saved start's defaults: the same plan, the same confirmation.
// Neither is a Reggie play nor an MCP tool: only a person's own request sends.

import { inviteRoutes as inviteSpecs, type RouteSpec } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, type HandlerCtx, type LongHandlerCtx, mount, mountLong } from "../http";
import { previewInvite, runInvite, signUpDraft } from "../onboarding/invite";

/** A preview reads in the request's own transaction: its `inTx` is that transaction. */
function readOnly(ctx: HandlerCtx<RouteSpec>): LongHandlerCtx<RouteSpec> {
  return {
    ...ctx,
    inTx: (work) =>
      work({
        role: ctx.role,
        tenantIds: ctx.tenantIds,
        operator: ctx.operator,
        tx: ctx.tx,
        afterCommit: ctx.afterCommit,
        defer: ctx.defer,
      }),
  };
}

const long = (ctx: unknown) => ctx as LongHandlerCtx<RouteSpec>;

export function inviteRoutes(app: Hono<AppEnv>): void {
  mount(app, inviteSpecs.opsInvitePreview, async (ctx) =>
    previewInvite({ app, ctx: readOnly(ctx as HandlerCtx<RouteSpec>), via: "invite" }, ctx.body),
  );
  mountLong(app, inviteSpecs.opsInviteSend, async (ctx) =>
    runInvite(
      {
        app,
        ctx: long(ctx),
        via: "invite",
        ...(ctx.body.startId ? { startId: ctx.body.startId } : {}),
      },
      ctx.body,
    ),
  );
  mount(app, inviteSpecs.opsSignUpPreview, async (ctx) => {
    const run = {
      app,
      ctx: readOnly(ctx as HandlerCtx<RouteSpec>),
      via: "sign_up" as const,
      startId: ctx.body.startId,
    };
    return previewInvite(run, await signUpDraft(run, ctx.body));
  });
  mountLong(app, inviteSpecs.opsSignUp, async (ctx) => {
    const run = { app, ctx: long(ctx), via: "sign_up" as const, startId: ctx.body.startId };
    return runInvite(run, await signUpDraft(run, ctx.body));
  });
}
