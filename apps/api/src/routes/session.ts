// Sign-in, sign-out and the session (packages/auth): WorkOS in deployed environments, the dev
// adapter locally (plan §1.1 "Auth provider").

import { getSession, toSessionResponse } from "@countersign/auth";
import { isOperatorRole, routes } from "@countersign/core";
import { appUser, userMemberships } from "@countersign/db";
import { asc } from "drizzle-orm";
import type { Hono } from "hono";
import { authDirectory } from "../auth";
import {
  type AppContext,
  type AppEnv,
  errorResponse,
  mountPublic,
  notFound,
  requestedClient,
} from "../http";

function sendCookies(c: AppContext, cookies: readonly string[]) {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
}

export function sessionRoutes(app: Hono<AppEnv>): void {
  // The signed-in user and their clients. Any role; no client scope is needed to answer it, so it
  // runs outside mount() (an operator who has not picked a client must still get an answer).
  app.get(routes.session.path, async (c) => {
    try {
      const services = c.get("req").services();
      const choice = services.auth();
      if (!choice.ok) {
        sendCookies(c, choice.refusal.setCookies);
        const r = choice.refusal;
        return c.json({ error: { code: r.code, message: r.message } }, r.status);
      }
      const result = await getSession(c.req.raw, {
        adapter: choice.adapter,
        directory: authDirectory(services.db),
        tenantId: requestedClient(c),
      });
      if (!result.ok) {
        sendCookies(c, result.setCookies);
        return c.json({ error: { code: result.code, message: result.message } }, result.status);
      }
      sendCookies(c, result.setCookies);
      return c.json(routes.session.response.parse(toSessionResponse(result.session)));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // WorkOS: start sign-in. With the dev adapter, sign in with POST /api/auth/dev/sign-in.
  app.get("/api/auth/sign-in", async (c) => {
    const choice = c.get("req").services().auth();
    if (!choice.ok) {
      return c.json({ error: { code: choice.refusal.code, message: choice.refusal.message } }, 503);
    }
    if (!choice.workos) {
      return c.json(
        { error: { code: "dev_sign_in", message: "use POST /api/auth/dev/sign-in locally" } },
        404,
      );
    }
    const r = await choice.workos.signIn(
      { returnTo: c.req.query("return_to") ?? null },
      new Date(),
    );
    if (!r.ok) return c.json({ error: { code: r.code, message: r.message } }, r.status);
    sendCookies(c, r.setCookies);
    return c.redirect(r.redirectTo, 302);
  });

  app.get("/api/auth/callback", async (c) => {
    const choice = c.get("req").services().auth();
    if (!choice.ok || !choice.workos) return c.json({ error: { code: "not_found" } }, 404);
    const r = await choice.workos.callback(c.req.raw, new Date());
    sendCookies(c, r.setCookies);
    if (!r.ok) return c.json({ error: { code: r.code, message: r.message } }, r.status);
    return c.redirect(r.redirectTo, 302);
  });

  mountPublic(app, routes.signOut, async ({ c, services }) => {
    const choice = services.auth();
    if (choice.ok && choice.workos) {
      const r = await choice.workos.signOut(c.req.raw);
      sendCookies(c, r.setCookies);
      return { ok: true as const, redirectTo: r.redirectTo };
    }
    if (choice.ok && choice.dev) sendCookies(c, [choice.dev.signOut()]);
    return { ok: true as const, redirectTo: null };
  });

  mountPublic(app, routes.devSignIn, async ({ c, body, services }) => {
    const choice = services.auth();
    if (!choice.ok || !choice.dev) throw notFound("the dev sign-in");
    const user = await authDirectory(services.db).userByEmail(body.email);
    if (!user) throw notFound(`seeded user ${body.email}`);
    sendCookies(c, [choice.dev.signIn(body.email)]);
    return { ok: true as const };
  });

  // The sign-in screen's list of seeded users. Only the dev adapter answers (never production, never
  // with WorkOS), so it lists nothing a deployed environment holds.
  mountPublic(app, routes.devUsers, async ({ services }) => {
    const choice = services.auth();
    if (!choice.ok || !choice.dev) throw notFound("the dev user list");
    const users = await services.db
      .select({ id: appUser.id, email: appUser.email, name: appUser.name })
      .from(appUser)
      .orderBy(asc(appUser.email));
    return {
      users: await Promise.all(
        users.map(async (u) => {
          const memberships = await userMemberships(services.db, u.id);
          return {
            email: u.email,
            name: u.name,
            operator: memberships.some((m) => isOperatorRole(m.role)),
            tenants: memberships.map((m) => ({ id: m.tenantId, name: m.tenantName, role: m.role })),
          };
        }),
      ),
    };
  });
}
