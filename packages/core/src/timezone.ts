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
