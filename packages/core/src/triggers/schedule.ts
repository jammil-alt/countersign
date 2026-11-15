// A schedule trigger in words (feedback, 2026-11-10: "human readable date and time, and add the
// time zone"): "Weekdays at 7:00 AM, Central Time". Common crons read as words; anything else
// stays its cron, which the builder's field explains. Shared by the back office and the API.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "7:00 AM", "6:30 PM", "12:00 PM". */
function clock(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Mondays", "Mondays and Thursdays", "Mondays, Wednesdays and Fridays". */
function dayList(days: number[]): string {
  const names = days.map((d) => `${DAYS[d]}s`);
  return names.length === 1
    ? (names[0] as string)
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The days of a cron's day-of-week field, or null when it is not a plain list or range. */
function daysOf(dow: string): number[] | null {
  const out = new Set<number>();
  for (const part of dow.split(",")) {
    const range = /^([0-7])(?:-([0-7]))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (to < from) return null;
    for (let d = from; d <= to; d++) out.add(d % 7);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A cron schedule in words where it is a common one: "Weekdays at 7:00 AM", "Every day at
 * 6:30 PM", "Mondays and Thursdays at 9:00 AM", "Weekends at 10:00 AM"; anything else as its cron.
 */
export function cronText(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || mon !== "*") return cron;
  const h = Number(hour);
  const m = Number(min);
  if (h > 23 || m > 59) return cron;
  const at = clock(h, m);
  if (dow === "*") return `Every day at ${at}`;
  const days = daysOf(dow);
  if (!days || days.length === 0) return cron;
  if (days.length === 7) return `Every day at ${at}`;
  if (days.join() === "1,2,3,4,5") return `Weekdays at ${at}`;
  if (days.join() === "0,6") return `Weekends at ${at}`;
  return `${dayList(days)} at ${at}`;
}

/**
 * An IANA zone in words: "Central Time" for America/Chicago, "Coordinated Universal Time" for
 * UTC; the zone's id where the runtime has no name for it.
 */
export function zoneText(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longGeneric" })
      .formatToParts(new Date(0))
      .find((p) => p.type === "timeZoneName")?.value;
    return name && !/^GMT[+-]/.test(name) ? name : tz;
  } catch {
    return tz;
  }
}

/**
 * A schedule in words with its zone: "Weekdays at 7:00 AM, Central Time", or "…, in the
 * client's time zone" when the trigger names none (it runs in the client's zone).
 */
export function scheduleText(on: { cron: string; tz?: string | null | undefined }): string {
  return `${cronText(on.cron)}, ${on.tz ? zoneText(on.tz) : "in the client's time zone"}`;
}
