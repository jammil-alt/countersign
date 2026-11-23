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

/**
 * S2.6 (overnight fixes, 2026-11-23): the time now in a zone, for an agent to read ("Sunday 22
 * November 2026, 22:00 in America/Chicago (GMT-06:00)"), so it says times in the client's zone and
 * not in UTC. An unknown zone reads as UTC.
 */
export function clockLine(now: Date, timeZone: string | null | undefined): string {
  const zone = timeZone && isTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU builds write UTC's offset as a bare "GMT".
  const name = part("timeZoneName");
  const offset = name && name !== "GMT" ? name : "GMT+00:00";
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} in ${zone} (${offset})`;
}
