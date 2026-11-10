// R4 business hours (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Business hours"): the client's
// week, zone and closed dates (the client admin sets them, every client person reads them), each
// person's own hours and away dates (a person sets their own, the client admin anyone's on the
// client's People list), and the operator's read of both. Every request goes through mount(), which
// writes its audit row; bodies are core's schemas (processes.BusinessHours, processes.PersonHours).
// What is stored where, and the executor's `hoursFor`, is ../hours/hours.ts.

import {
  type ClientBusinessHours,
  type PeopleHours,
  type PersonHoursView,
  type processes,
  routes,
} from "@countersign/core";
import { appUser, contact, membership, type Tx, tenant } from "@countersign/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import {
  clientBusinessHours,
  normalizePersonHours,
  personHoursOf,
  personHoursProblem,
  setClientBusinessHours,
} from "../hours/hours";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";

const CLIENT_ROLES = ["client_admin", "client_user"] as const;
/** The most contacts the People hours list carries (as the agent People list does). */
const MAX_CONTACTS = 2000;

async function businessOf(tx: Tx, tenantId: string): Promise<ClientBusinessHours> {
  const [t] = await tx
    .select({ timezone: tenant.timezone, settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  return clientBusinessHours(t);
}

const nameOf = (u: { name: string | null; email: string }) => u.name?.trim() || u.email;

/** One client member (a client user, never an operator) with their hours. */
async function memberView(tx: Tx, tenantId: string, userId: string): Promise<PersonHoursView> {
  const [m] = await tx
    .select({ hours: membership.hours, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        eq(membership.userId, userId),
        inArray(membership.role, [...CLIENT_ROLES]),
      ),
    );
  if (!m) throw notFound("person");
  return { kind: "user", id: userId, name: nameOf(m), hours: personHoursOf(m.hours) };
}

async function contactView(tx: Tx, tenantId: string, id: string): Promise<PersonHoursView> {
  const [c] = await tx
    .select({ id: contact.id, name: contact.name, hours: contact.hours })
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(contact.id, id)));
  if (!c) throw notFound("contact");
  return { kind: "contact", id: c.id, name: c.name, hours: personHoursOf(c.hours) };
}

/** The client's People list (its client users, then its contacts by name), with hours. */
async function peopleHours(tx: Tx, tenantId: string): Promise<PeopleHours> {
  const members = await tx
    .select({
      userId: membership.userId,
      hours: membership.hours,
      name: appUser.name,
      email: appUser.email,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, tenantId), inArray(membership.role, [...CLIENT_ROLES])))
    .orderBy(asc(appUser.email));
  const contacts = await tx
    .select({ id: contact.id, name: contact.name, hours: contact.hours })
    .from(contact)
    .where(eq(contact.tenantId, tenantId))
    .orderBy(asc(contact.name), asc(contact.id))
    .limit(MAX_CONTACTS);
  return {
    business: await businessOf(tx, tenantId),
    people: [
      ...members.map((m) => ({
        kind: "user" as const,
        id: m.userId,
        name: nameOf(m),
        hours: personHoursOf(m.hours),
      })),
      ...contacts.map((c) => ({
        kind: "contact" as const,
        id: c.id,
        name: c.name,
        hours: personHoursOf(c.hours),
      })),
    ],
  };
}

/** Checks a person's hours and returns them as stored (null clears). */
function personBody(hours: processes.PersonHours | null): processes.PersonHours | null {
  const problem = personHoursProblem(hours);
  if (problem) throw new HttpError(422, "invalid_hours", problem);
  return normalizePersonHours(hours);
}

async function setMemberHours(
  tx: Tx,
  tenantId: string,
  userId: string,
  hours: processes.PersonHours | null,
): Promise<PersonHoursView> {
  await memberView(tx, tenantId, userId);
  await tx
    .update(membership)
    .set({ hours: personBody(hours) })
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, userId)));
  return memberView(tx, tenantId, userId);
}

export function hoursRoutes(app: Hono<AppEnv>): void {
  // ── The client's business hours ──
  mount(app, routes.portalBusinessHours, async ({ tx, tenantIds }) =>
    businessOf(tx, tenantIds[0] as string),
  );

  mount(app, routes.portalSetBusinessHours, async ({ tx, tenantIds, body }) => {
    const tenantId = tenantIds[0] as string;
    await setClientBusinessHours(tx, tenantId, {
      week: body.week,
      usHolidays: body.usHolidays,
      closed: body.closed,
    });
    return businessOf(tx, tenantId);
  });

  // ── A person's own hours ──
  mount(app, routes.portalMyHours, async ({ tx, tenantIds, session }) => ({
    person: await memberView(tx, tenantIds[0] as string, session.user.id),
  }));

  mount(app, routes.portalSetMyHours, async ({ tx, tenantIds, session, body }) => ({
    person: await setMemberHours(tx, tenantIds[0] as string, session.user.id, body.hours),
  }));

  // ── The client admin: everyone on the People list ──
  mount(app, routes.portalPeopleHours, async ({ tx, tenantIds }) =>
    peopleHours(tx, tenantIds[0] as string),
  );

  mount(app, routes.portalSetUserHours, async ({ tx, tenantIds, params, body }) => ({
    person: await setMemberHours(tx, tenantIds[0] as string, params.id, body.hours),
  }));

  mount(app, routes.portalSetContactHours, async ({ tx, tenantIds, params, body }) => {
    const tenantId = tenantIds[0] as string;
    await contactView(tx, tenantId, params.id);
    await tx
      .update(contact)
      .set({ hours: personBody(body.hours) })
      .where(and(eq(contact.tenantId, tenantId), eq(contact.id, params.id)));
    return { person: await contactView(tx, tenantId, params.id) };
  });

  // ── The back office reads them ──
  mount(app, routes.opsClientHours, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return peopleHours(ctx.tx, ctx.params.id);
  });
}
