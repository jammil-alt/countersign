// Notification routes (ARCHITECTURE §11.3, §14 v0.12; docs/plan.md §1.37): the operator's "Ask the
// client to reconnect" (once a day per connection, logged in connection_change) and each person's
// own channels. What is sent, and when, is the cron's pass (notify/tick.ts).

import {
  type MyNotifications,
  type PersonNotificationSettings,
  reconnectDayPrefix,
  routes,
  USER_NOTIFICATIONS_KEY,
} from "@countersign/core";
import { connection, connectionChange, notification, type Tx, tenant } from "@countersign/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, notFound, type Services } from "../http";
import { enqueue, type NotifyDeps } from "../notify/outbox";
import { clientPeople, memberPerson, type TenantRow, tenantRow } from "../notify/people";
import { reconnectCandidates, reconnectPeople } from "../notify/scan";
import { notifyDepsFromEnv, sendNow } from "../notify/tick";

export function notifyDeps(services: Services): NotifyDeps {
  return notifyDepsFromEnv(services.env, services.deps.fetch?.(services.env));
}

async function clientOf(tx: Tx, tenantId: string): Promise<TenantRow> {
  const t = await tenantRow(tx, tenantId);
  if (!t) throw notFound("client");
  return t;
}

async function myNotifications(
  tx: Tx,
  deps: NotifyDeps,
  t: TenantRow,
  userId: string,
): Promise<MyNotifications> {
  const me = await memberPerson(tx, t, userId);
  if (!me) throw notFound("person");
  const canText = me.phone !== null && (await deps.texter.from(tx, t.id)) !== null;
  return { ...me.prefs, canText, emailsOn: deps.mailer.isConfigured };
}

/**
 * Writes some of one person's notification settings into `tenant.settings.user_notifications`:
 * their other keys (email and texts, or their phones' settings, §1.97) and everyone else's stay.
 */
export async function mergePersonSettings(
  tx: Tx,
  tenantId: string,
  userId: string,
  v: Record<string, unknown>,
) {
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(${tenant.settings}, ${`{${USER_NOTIFICATIONS_KEY}}`}::text[],
        coalesce(${tenant.settings} -> ${USER_NOTIFICATIONS_KEY}, '{}'::jsonb)
          || jsonb_build_object(${userId}::text,
            coalesce(${tenant.settings} -> ${USER_NOTIFICATIONS_KEY} -> ${userId}::text, '{}'::jsonb)
              || ${JSON.stringify(v)}::jsonb))`,
    })
    .where(eq(tenant.id, tenantId));
}

async function setMine(tx: Tx, tenantId: string, userId: string, v: PersonNotificationSettings) {
  await mergePersonSettings(tx, tenantId, userId, v);
}

export function notifyRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.opsRemindConnection, async (ctx) => {
    const { tx, tenantIds, params, session, services } = ctx;
    const [c] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, params.id), inArray(connection.tenantId, [...tenantIds])));
    if (!c) throw notFound("connection");
    // DECISION: a connection that works needs no reconnecting: 409 `connected`.
    if (c.status === "connected") {
      throw new HttpError(409, "connected", "this account works: nothing to reconnect");
    }
    // v0.14 W4-B (docs/plan.md §1.14 "Remind"): without Mezonas' mail (Resend) the reminder does
    // nothing: no rows, no log line, and the day's one reminder is still there to send.
    const deps = notifyDeps(services);
    if (!deps.mailer.isConfigured) {
      throw new HttpError(409, "not_configured", "we can't send email yet: our mail isn't set up");
    }
    const now = new Date();
    const [today] = await tx
      .select({ id: notification.id })
      .from(notification)
      .where(
        and(
          eq(notification.tenantId, c.tenantId),
          eq(notification.kind, "reconnect"),
          like(notification.dedupeKey, `${reconnectDayPrefix(c.id, now)}%`),
        ),
      )
      .limit(1);
    if (today) {
      throw new HttpError(409, "already_sent", "the client was asked today: try again tomorrow");
    }
    const t = await clientOf(tx, c.tenantId);
    const people = await clientPeople(tx, t);
    const rows = await enqueue(
      tx,
      t.id,
      deps.origin,
      reconnectCandidates(await reconnectPeople(tx, t, people, c.connectedBy), c.id, now),
      now,
    );
    await tx.insert(connectionChange).values({
      tenantId: c.tenantId,
      connectionId: c.id,
      actorId: session.user.id,
      change: { kind: "remind", notifications: rows.length },
    });
    if (rows.length > 0) ctx.afterCommit(() => sendNow(services.db, deps, t.id, new Date()));
    return {
      notifications: rows.map((r) => ({ channel: r.channel, status: r.status, reason: r.reason })),
    };
  });

  mount(app, routes.portalMyNotifications, async ({ tx, tenantIds, session, services }) => {
    const t = await clientOf(tx, tenantIds[0] as string);
    return myNotifications(tx, notifyDeps(services), t, session.user.id);
  });

  mount(
    app,
    routes.portalSetMyNotifications,
    async ({ tx, tenantIds, session, services, body }) => {
      const t = await clientOf(tx, tenantIds[0] as string);
      const deps = notifyDeps(services);
      const before = await myNotifications(tx, deps, t, session.user.id);
      if (body.sms && !before.canText) {
        throw new HttpError(
          422,
          "cannot_text",
          "no text can reach you: your directory entry needs a phone with text consent, and your business a number that can text",
        );
      }
      await setMine(tx, t.id, session.user.id, { email: body.email, sms: body.sms });
      return myNotifications(tx, deps, await clientOf(tx, t.id), session.user.id);
    },
  );
}
