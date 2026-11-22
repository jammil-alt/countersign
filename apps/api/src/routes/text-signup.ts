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
import { meter } from "../metering";
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
    // DECISION: the answer is the same on every path (a sign-up, a skipped one, a confirmation
    // that then fails to send): `sent` when the client's number can text, else `pending`. The
    // confirmation goes after the response, as the Twilio webhook's replies do, so the answer
    // takes as long whether or not a text follows.
    const fetch = services.deps.fetch?.(services.env);
    const texter = texterFromEnv(services.env, fetch);
    let confirmation: "sent" | "pending" = "pending";
    try {
      const from = await withTenant(services.db, done.tenantId, (tx) =>
        texter.from(tx, done.tenantId),
      );
      if (from) confirmation = "sent";
    } catch (error) {
      reportHandled("text sign-up number lookup failed", error, { job: "text_signup" });
    }
    if (confirmation === "sent" && done.send) {
      // From the client's own number, after the consent is committed.
      c.get("req").deferred.push(async () => {
        try {
          await withTenant(services.db, done.tenantId, async (tx) => {
            const sid = await texter.send(tx, done.tenantId, {
              to: done.phone,
              body: textSignupConfirmation(done.client),
            });
            // §1.210: the sign-up's confirmation text is the client's own usage.
            await meter(tx, {
              tenantId: done.tenantId,
              measure: "messages",
              source: "invitation",
              key: `twilio:${sid}`,
            });
          });
        } catch (error) {
          reportHandled("text sign-up confirmation failed", error, { job: "text_signup" });
        }
      });
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
