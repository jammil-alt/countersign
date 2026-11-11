// R4 business hours (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Business hours"): where the
// client's hours and each person's live, how they are read, and the executor's `hoursFor` port.
//
// - The client's week and its US-holiday switch: `tenant.settings.businessHours`.
// - The client's zone: `tenant.timezone`, the one schedules and quiet hours already use.
// - The client's closed dates: `tenant.settings.holidays`, the days off schedules that skip
//   holidays already read (core's `clientHolidays`).
// - A person's own hours and away dates: `membership.hours` (a client user, or an operator such as
//   the lead, in this client) and `contact.hours` (a directory contact), both core's
//   `processes.PersonHours`; null is the client's hours, never away.
//
// The clock itself (when a deadline in business time is due, who is working) is core's
// `processes.dueAt` / `dueAtForMany` / `isWorking`: this file only reads what they run on.

import { clientHolidays, isUuid, processes } from "@countersign/core";
import { contact, type Db, membership, type Tx, tenant, withTenant } from "@countersign/db";
import { leadUserId } from "@countersign/threads";
import { and, eq, sql } from "drizzle-orm";
import { validTimezone } from "../routes/onboarding";

/** `tenant.settings` key of the client's week and US-holiday switch. */
export const BUSINESS_HOURS_SETTING = "businessHours";
/** `tenant.settings` key of the client's own closed dates (shared with schedules). */
export const HOLIDAYS_SETTING = "holidays";

/** What `tenant.settings.businessHours` holds: the week and the US-holiday switch. */
const StoredWeek = processes.BusinessHours.pick({ week: true, usHolidays: true });

/** The client's hours in force, and whether they are still the default week. */
export function clientBusinessHours(t: { timezone: string; settings: unknown }): {
  hours: processes.BusinessHours;
  isDefault: boolean;
} {
  // DECISION: a zone the clock can't read (never written by our routes) runs as UTC rather than
  // failing every deadline of the client.
  const tz = validTimezone(t.timezone) ? t.timezone : "UTC";
  const base = processes.defaultBusinessHours(tz);
  const closed = clientHolidays(t.settings);
  const raw = (t.settings as Record<string, unknown> | null)?.[BUSINESS_HOURS_SETTING];
  const stored = raw === undefined ? null : StoredWeek.safeParse(raw);
  // DECISION: a stored week that no longer parses is read as the default, never as "always
  // closed": a deadline still comes due.
  if (stored?.success) {
    return {
      hours: { ...base, week: stored.data.week, usHolidays: stored.data.usHolidays, closed },
      isDefault: false,
    };
  }
  return { hours: { ...base, closed }, isDefault: true };
}

/**
 * Writes the client's week, US-holiday switch and closed dates in place, so concurrent changes to
 * other settings keys are kept.
 */
export async function setClientBusinessHours(
  tx: Tx,
  tenantId: string,
  value: { week: processes.BusinessHours["week"]; usHolidays: boolean; closed: string[] },
): Promise<void> {
  const week = { week: value.week, usHolidays: value.usHolidays };
  const closed = [...new Set(value.closed)].sort();
  await tx
    .update(tenant)
    .set({
      settings: sql`coalesce(${tenant.settings}, '{}'::jsonb) || jsonb_build_object(
        ${BUSINESS_HOURS_SETTING}::text, ${JSON.stringify(week)}::jsonb,
        ${HOLIDAYS_SETTING}::text, ${JSON.stringify(closed)}::jsonb)`,
    })
    .where(eq(tenant.id, tenantId));
}

/** A stored person's hours, or null when none (or no longer valid: the client's hours then). */
export function personHoursOf(raw: unknown): processes.PersonHours | null {
  if (raw === null || raw === undefined) return null;
  const parsed = processes.PersonHours.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A person's hours as they will be stored: sorted, de-duplicated away ranges. */
export function normalizePersonHours(
  value: processes.PersonHours | null,
): processes.PersonHours | null {
  if (!value) return null;
  const seen = new Set<string>();
  const away = [...value.away]
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .filter((r) => {
      const key = `${r.from}:${r.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return value.hours ? { hours: value.hours, away } : { away };
}

/** The longest a person may be away in one stretch, in days (touching ranges count as one). */
export const MAX_AWAY_DAYS = 366;
const DAY_MS = 86_400_000;

/** Days since the epoch of an ISO date, or null when it isn't a real date. */
function dayOf(date: string): number | null {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date ? null : ms / DAY_MS;
}

/**
 * Why a week can't be anyone's hours, or null: a week with no open stretch would never let a
 * deadline in business time come due (the clock gives up after five years and fails the run).
 */
// DECISION: refused where it is written (422), as the review asked, rather than in core's schema:
// stored weeks keep parsing as they did, and a week that no longer would still reads as the default.
export function weekProblem(week: processes.BusinessHours["week"]): string | null {
  return Object.values(week).some((stretches) => (stretches?.length ?? 0) > 0)
    ? null
    : "the week has no open hours: give at least one day its hours";
}

/**
 * What a hours body may not say, in plain words, or null: a week with no open hours, a zone the
 * clock can't read, a date that isn't one, an away range that ends before it starts, or away for
 * more than MAX_AWAY_DAYS in a row (ranges that overlap or touch count as one).
 */
// DECISION: away is capped per stretch, not per range, so ranges laid end to end can't add up to
// years away (which would fail every deadline asked of the person, as an all-closed week would).
export function personHoursProblem(value: processes.PersonHours | null): string | null {
  if (!value) return null;
  if (value.hours && !validTimezone(value.hours.tz)) return `unknown time zone ${value.hours.tz}`;
  if (value.hours) {
    const week = weekProblem(value.hours.week);
    if (week) return week;
  }
  const ranges: { from: number; to: number; text: string }[] = [];
  for (const r of value.away) {
    const from = dayOf(r.from);
    const to = dayOf(r.to);
    if (from === null || to === null) return `away from ${r.from} to ${r.to}: not a date`;
    if (to < from) return `away from ${r.from} to ${r.to}: the end is before the start`;
    ranges.push({ from, to, text: r.from });
  }
  ranges.sort((a, b) => a.from - b.from);
  // One stretch at a time: ranges that overlap or touch the one before join it.
  let from = Number.NEGATIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  let text = "";
  for (const r of ranges) {
    if (r.from > to + 1) {
      from = r.from;
      text = r.text;
    }
    to = Math.max(to, r.to);
    if (to - from + 1 > MAX_AWAY_DAYS) {
      return `away for more than ${MAX_AWAY_DAYS} days in a row from ${text}`;
    }
  }
  return null;
}

// ── The executor's port ─────────────────────────────────────────────────────────────────────────

export interface HoursForInput {
  tenantId: string;
  /** A role (`lead`, `operator`, `client_admin`, `client_user`), a user id or a contact id. */
  who: string;
}

/**
 * What a deadline's clock runs on (packages/workflows' `hoursFor` port): the client's hours, plus
 * the person's own when `who` is one person with hours of their own, or each person's schedule
 * when `who` is a role (the clock then runs while any one of them is working).
 */
export interface HoursForResult {
  client: processes.BusinessHours;
  person?: processes.PersonHours;
  people?: processes.Schedule[];
}

const MEMBER_ROLES = ["operator", "client_admin", "client_user"] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];
const isMemberRole = (who: string): who is MemberRole =>
  (MEMBER_ROLES as readonly string[]).includes(who);

/** `hoursFor` inside a transaction already scoped to the client. */
// DECISION: someone `who` doesn't name (an unknown id or role) runs on the client's hours, as
// someone without hours of their own does; a role with nobody in it, likewise.
export async function hoursIn(tx: Tx, tenantId: string, who: string): Promise<HoursForResult> {
  const [t] = await tx
    .select({ timezone: tenant.timezone, settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const client = clientBusinessHours(t ?? { timezone: "UTC", settings: {} }).hours;
  if (!t) return { client };

  const one = (hours: processes.PersonHours | null): HoursForResult =>
    hours ? { client, person: hours } : { client };

  const memberHours = async (userId: string) => {
    const [m] = await tx
      .select({ hours: membership.hours })
      .from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, userId)));
    return m ? personHoursOf(m.hours) : undefined;
  };

  if (who === "lead") {
    const lead = leadUserId(t.settings);
    return one(lead ? ((await memberHours(lead)) ?? null) : null);
  }
  if (isMemberRole(who)) {
    const rows = await tx
      .select({ hours: membership.hours })
      .from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.role, who)));
    if (rows.length === 0) return { client };
    return {
      client,
      people: rows.map((r) => processes.scheduleFor(client, personHoursOf(r.hours) ?? undefined)),
    };
  }
  if (!isUuid(who)) return { client };
  const member = await memberHours(who);
  if (member !== undefined) return one(member);
  const [c] = await tx
    .select({ hours: contact.hours })
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(contact.id, who)));
  return one(c ? personHoursOf(c.hours) : null);
}

/** The `hoursFor` port over a database: one client's transaction per call. */
export function hoursFor(db: Db): (input: HoursForInput) => Promise<HoursForResult> {
  return ({ tenantId, who }) => withTenant(db, tenantId, (tx) => hoursIn(tx, tenantId, who));
}
