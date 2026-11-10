// Sign-in, sign-out and the session (packages/auth): WorkOS in deployed environments, the dev
// adapter locally (plan §1.1 "Auth provider").

import { getSession, toSessionResponse } from "@countersign/auth";
import { isOperatorRole, routes } from "@countersign/core";
import { appUser, userMemberships } from "@countersign/db";
import { asc } from "drizzle-orm";
import type { Hono } from "hono";
import { auditAlone } from "../audit";
import { authDirectory } from "../auth";
import {
  type AppContext,
  type AppEnv,
  errorResponse,
  mountPublic,
  notFound,
  requestedClient,
} from "../http";
import { sessionLanguage } from "./language";
// v0.12 W1-C
import { sessionLead } from "./threads";

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
      const language = await sessionLanguage(
        services.db,
        result.session,
        c.req.header("accept-language"),
      );
      // v0.12 W1-C: the active client's lead, by name.
      const lead = await sessionLead(services.db, result.session.activeTenantId);
      return c.json(
        routes.session.response.parse({ ...toSessionResponse(result.session), language, lead }),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  // Which sign-in the sign-in page shows: WorkOS on deployed environments, the dev adapter locally.
  mountPublic(app, routes.authProvider, ({ services }) => {
    const choice = services.auth();
    if (!choice.ok) return { provider: "unavailable" as const, message: choice.refusal.message };
    return { provider: choice.workos ? ("workos" as const) : ("dev" as const), message: null };
  });

  // WorkOS: start sign-in. With the dev adapter, sign in with POST /api/auth/dev/sign-in.
  // Both WorkOS routes are full-page navigations, so a failure goes back to the sign-in page with
  // a short code it turns into words, never a JSON body in the browser.
  // DECISION: only a code travels in the URL (never message text), so the page can't be made to
  // show words of someone else's choosing.
  app.get("/api/auth/sign-in", async (c) => {
    const choice = c.get("req").services().auth();
    if (!choice.ok) return c.redirect(signInFailure(choice.refusal.code), 302);
    if (!choice.workos) {
      return c.json(
        { error: { code: "dev_sign_in", message: "use POST /api/auth/dev/sign-in locally" } },
        404,
      );
    }
    const r = await choice.workos.signIn(
      // `retry=1`: the callback sent the browser back here once after a failure (below).
      { returnTo: c.req.query("return_to") ?? null, restart: c.req.query("retry") === "1" },
      new Date(),
    );
    if (!r.ok) return c.redirect(signInFailure(r.code), 302);
    sendCookies(c, r.setCookies);
    return c.redirect(r.redirectTo, 302);
  });

  app.get("/api/auth/callback", async (c) => {
    const choice = c.get("req").services().auth();
    if (!choice.ok || !choice.workos) return c.json({ error: { code: "not_found" } }, 404);
    const now = new Date();
    const r = await choice.workos.callback(c.req.raw, now);
    sendCookies(c, r.setCookies);
    const db = c.get("req").services().db;
    if (!r.ok) {
      const failure = r.failure;
      // DECISION (plan §1.35, "Sign-in callback"): a refused callback of someone already signed
      // in (a used callback URL after Back or a reload, a second tab's sign-in) goes to the app,
      // and any other state or code failure starts sign-in again once (`retry=1`, marked in the
      // new state so the next callback won't). This only recognises a session the request
      // already carries; a refused callback never creates one.
      const who = failure ? await choice.workos.identify(c.req.raw, now).catch(() => null) : null;
      if (who) sendCookies(c, who.setCookies);
      const signedIn = who?.ok ? who.userId : null;
      let next: "app" | "restart" | "error_page" | null = null;
      if (failure) next = signedIn ? "app" : failure.restart ? "restart" : "error_page";
      await auditAlone(db, c, {
        tenantId: null,
        actorKind: signedIn ? "user" : "anonymous",
        actorUserId: signedIn,
        actorEmail: signedIn ? ((await authDirectory(db).user(signedIn))?.email ?? null) : null,
        action: "session.sign_in",
        outcome: "refused",
        httpStatus: r.status,
        target: { reason: failure?.reason ?? r.reason ?? r.code, ...(next ? { next } : {}) },
      });
      if (next === "app") return c.redirect(failure?.returnTo ?? "/", 302);
      if (next === "restart") {
        const query = new URLSearchParams({ return_to: failure?.returnTo ?? "/", retry: "1" });
        return c.redirect(`/api/auth/sign-in?${query}`, 302);
      }
      return c.redirect(signInFailure(r.reason ?? r.code), 302);
    }
    if (r.signedIn) {
      const user = await authDirectory(db).user(r.signedIn.userId);
      await auditAlone(db, c, {
        tenantId: null,
        actorKind: "user",
        actorUserId: r.signedIn.userId,
        actorEmail: user?.email ?? null,
        action: "session.sign_in",
        outcome: "ok",
        httpStatus: 302,
        target: {
          ...(r.signedIn.method ? { method: r.signedIn.method } : {}),
          // §1.83: where the sign-in starts with the second step.
          second_factor: r.signedIn.remembered ? "remembered" : r.signedIn.secondFactor,
        },
      });
    }
    return c.redirect(r.redirectTo, 302);
  });

  mountPublic(app, routes.signOut, async ({ c, services }) => {
    const choice = services.auth();
    // Who is signing out, if anyone: read before the cookie is cleared.
    if (choice.ok) {
      const who = await getSession(c.req.raw, {
        adapter: choice.adapter,
        directory: authDirectory(services.db),
      }).catch(() => null);
      if (who?.ok) {
        await auditAlone(services.db, c, {
          tenantId: null,
          actorKind: "user",
          actorUserId: who.session.user.id,
          actorEmail: who.session.user.email,
          action: "session.sign_out",
          outcome: "ok",
          httpStatus: 200,
        });
      }
    }
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
    await auditAlone(services.db, c, {
      tenantId: null,
      actorKind: "user",
      actorUserId: user.id,
      actorEmail: user.email,
      action: "session.sign_in",
      outcome: "ok",
      httpStatus: 200,
      target: { method: "dev" },
    });
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

/** The sign-in page, told why sign-in did not complete. */
function signInFailure(code: string): string {
  return `/sign-in?error=${encodeURIComponent(code)}`;
}
