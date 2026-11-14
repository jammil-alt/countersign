// Signing up for texts (docs/plan.md §1.98): the public page's routes, the client's sign-up link
// and invitations from the portal and the back office.

import { routes, textSignupConfirmation } from "@countersign/core";
import { withTenant } from "@countersign/db";
import type { Hono } from "hono";
import { requestOrigin } from "../audit";
import { type AppEnv, ensureClient, HttpError, mount, mountPublic } from "../http";
import {
  declineTextSignup,
  sendTextInvitations,
  submitTextSignup,
  textSignupLink,
  viewTextSignup,
} from "../messaging/signup";
import { mailerFromEnv, texterFromEnv } from "../notify/mailer";
import { originOf } from "../notify/outbox";
import { reportHandled } from "../observability/report";

const tokenOf = (c: { req: { param(name: string): string | undefined } }) =>
  c.req.param("token") ?? "";

export function textSignupRoutes(app: Hono<AppEnv>): void {
  // DECISION: the page's routes are public and write no audit row: the person acting is the
  // contact, not a signed-in user. The evidence (words shown, address, browser) is on the contact's
  // own log, and nothing on the page reads anything but the link's client name and the person.
  mountPublic(app, routes.textSignupView, async ({ c, services }) => {
    const view = await viewTextSignup(services.db, services.env, tokenOf(c));
    if (!view) {
      throw new HttpError(404, "not_found", "This link has expired or doesn't exist.");
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return view;
  });

  mountPublic(app, routes.textSignupSubmit, async ({ c, body, services }) => {
    const done = await submitTextSignup(
      services.db,
      services.env,
      tokenOf(c),
      body,
      requestOrigin(c),
    );
    // The confirmation text, after the consent is committed, from the client's own number.
    const fetch = services.deps.fetch?.(services.env);
    const texter = texterFromEnv(services.env, fetch);
    let confirmation: "sent" | "pending" = "pending";
    try {
      await withTenant(services.db, done.tenantId, async (tx) => {
        if (!(await texter.from(tx, done.tenantId))) return;
        await texter.send(tx, done.tenantId, {
          to: done.phone,
          body: textSignupConfirmation(done.client),
        });
        confirmation = "sent";
      });
    } catch (error) {
      reportHandled("text sign-up confirmation failed", error, { job: "text_signup" });
    }
    return { confirmation };
  });

  mountPublic(app, routes.textSignupDecline, async ({ c, services }) => {
    await declineTextSignup(services.db, services.env, tokenOf(c), requestOrigin(c));
    return { ok: true as const };
  });

  mount(app, routes.portalTextSignupLink, async (ctx) => ({
    url: await textSignupLink(
      ctx.tx,
      ctx.services.env,
      originOf(ctx.services.env),
      ctx.tenantIds[0] as string,
    ),
  }));
  mount(app, routes.portalTextSignupLinkReplace, async (ctx) => ({
    url: await textSignupLink(
      ctx.tx,
      ctx.services.env,
      originOf(ctx.services.env),
      ctx.tenantIds[0] as string,
      { replace: true },
    ),
  }));
  mount(app, routes.opsTextSignupLink, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return {
      url: await textSignupLink(
        ctx.tx,
        ctx.services.env,
        originOf(ctx.services.env),
        ctx.params.id,
      ),
    };
  });

  mount(app, routes.portalTextInvitations, async (ctx) =>
    sendTextInvitations(
      {
        tx: ctx.tx,
        env: ctx.services.env,
        origin: originOf(ctx.services.env),
        tenantId: ctx.tenantIds[0] as string,
        actorId: ctx.session.user.id,
        via: "portal",
        mailer: mailerFromEnv(ctx.services.env, ctx.services.deps.fetch?.(ctx.services.env)),
      },
      ctx.body.contactIds,
    ),
  );
  mount(app, routes.opsTextInvitations, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return sendTextInvitations(
      {
        tx: ctx.tx,
        env: ctx.services.env,
        origin: originOf(ctx.services.env),
        tenantId: ctx.params.id,
        actorId: ctx.session.user.id,
        via: "ops",
        mailer: mailerFromEnv(ctx.services.env, ctx.services.deps.fetch?.(ctx.services.env)),
      },
      ctx.body.contactIds,
    );
  });
}
