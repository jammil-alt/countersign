// Who notifications go to, and how they can be reached (ARCHITECTURE §11.3): a client's members by
// their sign-in email; a text only to a person whose directory entry (the client's contact with
// the same email, as release codes find it) has a phone with text consent and no STOP, and only if
// the person turned texts on. Quiet hours are the directory entry's, else the client's messaging
// quiet hours. Language: the person's own, else the client's, else English; the lead (an operator)
// reads the back office in English.

import {
  type ContactConsent,
  clientLanguage,
  consentBlock,
  contactHours,
  type Locale,
  type PersonNotificationSettings,
  personNotifications,
  type QuietHours,
  userLanguage,
} from "@countersign/core";
import { appUser, contact, membership, type Tx, tenant } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import { messagingSettingsOf, reachContactOf } from "../messaging/contacts";

export type TenantRow = typeof tenant.$inferSelect;
type ContactRow = typeof contact.$inferSelect;

export interface NotifyPerson {
  userId: string;
  email: string;
  name: string | null;
  role: "client_admin" | "client_user" | "operator";
  /** False for viewers (membership.can_sign): they get no items-waiting for their role's items. */
  canSign: boolean;
  locale: Locale;
  prefs: PersonNotificationSettings;
  /** Their directory entry, if any. */
  contactId: string | null;
  /** The phone a text can reach, or null. */
  phone: string | null;
  hours: { timezone: string; quietHours: QuietHours };
}

const CLIENT_ROLES = ["client_admin", "client_user"] as const;

function settingsOf(t: Pick<TenantRow, "settings">): Record<string, unknown> {
  return (t.settings ?? {}) as Record<string, unknown>;
}

/** The person's directory entry: the client's contact with the same email. */
async function entriesByEmail(tx: Tx, tenantId: string, emails: string[]) {
  if (emails.length === 0) return new Map<string, ContactRow>();
  const rows = await tx
    .select()
    .from(contact)
    .where(
      and(
        eq(contact.tenantId, tenantId),
        inArray(
          contact.email,
          emails.map((e) => e.toLowerCase()),
        ),
      ),
    );
  return new Map(rows.filter((r) => r.email).map((r) => [r.email as string, r]));
}

function textablePhone(c: ContactRow | undefined): string | null {
  if (!c?.phone) return null;
  const block = consentBlock(
    {
      phone: c.phone,
      whatsapp: c.whatsapp,
      consent: (c.consent ?? {}) as ContactConsent,
      optedOutAt: c.optedOutAt,
    },
    "sms",
  );
  return block ? null : c.phone;
}

function personOf(
  t: TenantRow,
  u: {
    id: string;
    email: string;
    name: string | null;
    role: NotifyPerson["role"];
    canSign: boolean;
  },
  entry: ContactRow | undefined,
): NotifyPerson {
  const settings = settingsOf(t);
  const client = messagingSettingsOf(t);
  const hours = entry ? contactHours(reachContactOf(entry), client) : client;
  return {
    userId: u.id,
    email: u.email.toLowerCase(),
    name: u.name,
    role: u.role,
    canSign: u.canSign,
    // DECISION: the lead is an operator and reads the back office in English (as operators do).
    locale:
      u.role === "operator"
        ? "en"
        : (userLanguage(settings, u.id) ?? clientLanguage(settings) ?? "en"),
    prefs: personNotifications(settings, u.id),
    contactId: entry?.id ?? null,
    phone: textablePhone(entry),
    hours: { timezone: hours.timezone, quietHours: hours.quietHours },
  };
}

/** The client's members (client admins and users), each with how they can be reached. */
export async function clientPeople(tx: Tx, t: TenantRow): Promise<NotifyPerson[]> {
  const users = await tx
    .select({
      id: appUser.id,
      email: appUser.email,
      name: appUser.name,
      role: membership.role,
      canSign: membership.canSign,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, t.id), inArray(membership.role, [...CLIENT_ROLES])))
    .orderBy(appUser.email);
  const entries = await entriesByEmail(
    tx,
    t.id,
    users.map((u) => u.email),
  );
  return users.map((u) =>
    personOf(t, { ...u, role: u.role as NotifyPerson["role"] }, entries.get(u.email.toLowerCase())),
  );
}

/** One member of the client (any role, e.g. the lead), or null when they are not one. */
export async function memberPerson(
  tx: Tx,
  t: TenantRow,
  userId: string,
): Promise<NotifyPerson | null> {
  const [u] = await tx
    .select({
      id: appUser.id,
      email: appUser.email,
      name: appUser.name,
      role: membership.role,
      canSign: membership.canSign,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, t.id), eq(membership.userId, userId)));
  if (!u) return null;
  // The lead gets email only: an operator is no contact of the client.
  const entry =
    u.role === "operator"
      ? undefined
      : (await entriesByEmail(tx, t.id, [u.email])).get(u.email.toLowerCase());
  return personOf(t, { ...u, role: u.role as NotifyPerson["role"] }, entry);
}

/** `tenant.settings.lead.userId` (ARCHITECTURE §11.2, set by W1-C); null when none is set. */
export function leadUserId(t: Pick<TenantRow, "settings">): string | null {
  const lead = settingsOf(t).lead;
  if (!lead || typeof lead !== "object") return null;
  const id = (lead as Record<string, unknown>).userId;
  return typeof id === "string" ? id : null;
}

export async function tenantRow(tx: Tx, tenantId: string): Promise<TenantRow | null> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  return t ?? null;
}

/** A text can reach this person now: they turned texts on and have a textable phone. */
export const wantsText = (p: NotifyPerson) => p.prefs.sms && p.phone !== null;
