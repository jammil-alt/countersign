// A client's time zone: an IANA name the runtime knows ("America/Chicago"), checked at the API's
// boundary (CLAUDE.md invariant 5) and offered as a list on the screens that set it.
import { z } from "zod";

/** Whether `tz` is an IANA time zone the runtime knows. */
export function isTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A time zone in a request body: an IANA name, such as America/Chicago. */
export const IanaTimeZone = z.string().trim().min(1).max(100).refine(isTimeZone, {
  message: "not a time zone we know: use an IANA name, e.g. America/Chicago",
});

/**
 * The IANA time zones to choose from, A to Z, with UTC first; `keep` (a value already stored) is
 * added when the runtime's list leaves it out, so a select never drops what is saved.
 */
export function timeZoneChoices(keep?: string | null): string[] {
  let zones: string[] = [];
  try {
    zones =
      (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ??
      [];
  } catch {
    zones = [];
  }
  const all = new Set(["UTC", ...zones]);
  if (keep) all.add(keep);
  return ["UTC", ...[...all].filter((z) => z !== "UTC").sort()];
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUSE_DATES = new Map<string, Intl.DateTimeFormat>();

/**
 * "23 Nov 2026": the house date (CLAUDE.md, "UI and copy"; the app's `fmt.date`) for words built
 * on the server. A calendar day ("2026-11-23") is that day; an instant is its day in `timeZone`
 * (UTC unless given). Not a date: the text as given.
 */
// DECISION (S5.1): one date format everywhere: words built on the server use this, the screens the
// shared formatter (apps/web/src/i18n/format.ts), both day, short month, year, written en-GB.
export function houseDate(iso: string, timeZone = "UTC"): string {
  const calendar = CALENDAR_DAY.test(iso);
  const d = new Date(calendar ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const zone = calendar || !isTimeZone(timeZone) ? "UTC" : timeZone;
  let f = HOUSE_DATES.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: zone,
    });
    HOUSE_DATES.set(zone, f);
  }
  return f.format(d);
}
