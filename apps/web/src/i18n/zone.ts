// Times where the client is (S5, overnight fixes 2026-11-23): a period's ends and a schedule's next
// run read in the client's time zone, with the zone named beside them, so a reader in another zone
// never sees a day that is not the client's ("31 Oct" for a period that starts on 1 Nov).
import { createFormatters, dateLocaleFor, validZone } from "./format";

/**
 * The zone's short name in the reader's language: "Chicago Time", "hora de Chicago", "UTC".
 * Undefined or unknown: the viewer's own zone's name.
 */
export function zoneName(timeZone: string | undefined, intl = "en-US", now = new Date()): string {
  const zone = validZone(timeZone);
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  const part = new Intl.DateTimeFormat(dateLocaleFor(intl), {
    timeZoneName: "shortGeneric",
    ...(zone ? { timeZone: zone } : {}),
  })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  return part ?? zone ?? "";
}

/** The viewer's own zone (the browser's), as Intl reports it. */
export function viewerZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

/** Whether an instant is midnight on the wall clock in a zone (the start of a whole day there). */
function wallClock(d: Date, zone: string | undefined): { midnight: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
    ...(zone ? { timeZone: zone } : {}),
  }).formatToParts(d);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { midnight: n("hour") === 0 && n("minute") === 0 && n("second") === 0 };
}

/**
 * A run filter's end (`since`, inclusive; `until`, exclusive) as people read it, in the client's
 * zone: a period of whole days shows its days ("1 Nov 2026" to "30 Nov 2026", the last day it
 * holds, not the midnight after it); an end mid-day keeps its time ("23 Nov, 14:00").
 */
// DECISION (S5.4): a period's chips read in the client's zone, the zone its report counted the
// days in; `until` at midnight reads as the day before, since that midnight is not in the period.
export function periodEnd(
  key: "since" | "until",
  iso: string,
  intl = "en-US",
  timeZone?: string,
  now = new Date(),
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const zone = validZone(timeZone);
  const fmt = createFormatters(intl, zone);
  if (!wallClock(d, zone).midnight) return fmt.dateTime(iso, now);
  const day = key === "until" ? new Date(d.getTime() - 1) : d;
  return fmt.date(day.toISOString());
}
