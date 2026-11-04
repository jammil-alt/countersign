// Languages (docs/plan.md §1.18): the client's default (`tenant.settings.language`), set by the
// operator or the client admin; each client user's own choice (`tenant.settings.user_languages`),
// which wins; and the language a session reads in.

import type { Session } from "@countersign/auth";
import {
  CLIENT_LANGUAGE_KEY,
  clientLanguage,
  type Locale,
  parseAcceptLanguage,
  resolveLocale,
  routes,
  type SessionLanguage,
  USER_LANGUAGES_KEY,
  userLanguage,
} from "@countersign/core";
import { type Db, type Tx, tenant } from "@countersign/db";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, mount, notFound } from "../http";

async function settingsOf(db: Db | Tx, tenantId: string): Promise<Record<string, unknown> | null> {
  const [t] = await db
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return t ? t.settings : null;
}

/**
 * The language a session reads in: the user's choice, else the client's default, else the
 * browser's (`Accept-Language`), else English.
 */
// DECISION: operator sessions always read in English: the back office stays literal English
// (plan §1.18), and an operator's own choice has nothing to change.
export async function sessionLanguage(
  db: Db,
  session: Pick<Session, "isOperator" | "activeTenantId" | "user">,
  acceptLanguage: string | null | undefined,
): Promise<SessionLanguage> {
  if (session.isOperator || !session.activeTenantId) {
    return { effective: "en", user: null, client: null };
  }
  const settings = await settingsOf(db, session.activeTenantId);
  const user = userLanguage(settings, session.user.id);
  const client = clientLanguage(settings);
  return {
    effective: resolveLocale({ user, client, browser: parseAcceptLanguage(acceptLanguage) }),
    user,
    client,
  };
}

/** The client's default language (what its runs write in), or English when none is set. */
export async function tenantLocale(db: Db | Tx, tenantId: string): Promise<Locale> {
  return clientLanguage(await settingsOf(db, tenantId)) ?? "en";
}

/** Sets one key of `tenant.settings` in place, so concurrent changes to other keys aren't lost. */
async function setClientLanguage(tx: Tx, tenantId: string, language: Locale): Promise<Locale> {
  const [row] = await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(${tenant.settings}, ${`{${CLIENT_LANGUAGE_KEY}}`}::text[], to_jsonb(${language}::text))`,
    })
    .where(eq(tenant.id, tenantId))
    .returning({ settings: tenant.settings });
  const saved = clientLanguage(row?.settings);
  if (!saved) throw notFound("client");
  return saved;
}

export function languageRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.portalSetMyLanguage, async ({ tx, tenantIds, session, body }) => {
    const tenantId = tenantIds[0] as string;
    const map = `{${USER_LANGUAGES_KEY}}`;
    const path = `{${USER_LANGUAGES_KEY},${session.user.id}}`;
    const [row] = await tx
      .update(tenant)
      .set({
        settings:
          body.language === null
            ? sql`${tenant.settings} #- ${path}::text[]`
            : sql`jsonb_set(
                jsonb_set(${tenant.settings}, ${map}::text[],
                  coalesce(${tenant.settings} -> ${USER_LANGUAGES_KEY}, '{}'::jsonb)),
                ${path}::text[], to_jsonb(${body.language}::text))`,
      })
      .where(eq(tenant.id, tenantId))
      .returning({ settings: tenant.settings });
    if (!row) throw notFound("client");
    return {
      user: userLanguage(row.settings, session.user.id),
      client: clientLanguage(row.settings),
    };
  });

  mount(app, routes.portalSetClientLanguage, async ({ tx, tenantIds, body }) => ({
    client: await setClientLanguage(tx, tenantIds[0] as string, body.language),
  }));

  mount(app, routes.opsSetClientLanguage, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { client: await setClientLanguage(ctx.tx, ctx.params.id, ctx.body.language) };
  });
}
