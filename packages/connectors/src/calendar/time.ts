// Wall times and IANA time zones for the calendar connectors (`gcal`, `outlook_calendar`): a
// calendar tool takes a local time (`2026-11-20T10:00`) and a zone (`America/Chicago`), or a date
// for an all-day event, and shows times the same way. Conversions use the runtime's own time zone
// data (Intl, in Workers and Node), so both providers' answers are read the same way.

/** `YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss`: a local time with no offset. */
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
/** `YYYY-MM-DD`. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(zone, f);
  }
  return f;
}

/** Whether the runtime knows this IANA time zone (`UTC`, `America/Chicago`). */
export function isTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  try {
    formatFor(zone);
    return true;
  } catch {
    return false;
  }
}

function validParts(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Whether `value` is a real date `YYYY-MM-DD`. */
export function isDate(value: string): boolean {
  const m = DATE.exec(value);
  return m !== null && validParts(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Whether `value` is a real local time `YYYY-MM-DDTHH:mm[:ss]`. */
export function isWallTime(value: string): boolean {
  const m = WALL.exec(value);
  if (!m || !validParts(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  return Number(m[4]) <= 23 && Number(m[5]) <= 59 && Number(m[6] ?? "0") <= 59;
}

/** A local time with seconds (`2026-11-20T10:00` → `2026-11-20T10:00:00`). */
export function withSeconds(wall: string): string {
  return wall.length === 16 ? `${wall}:00` : wall;
}

/** The local time read as if it were UTC, in milliseconds. */
function wallAsUtc(wall: string): number {
  const m = WALL.exec(wall);
  if (!m) throw new RangeError(`not a local time: ${wall}`);
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? "0"),
  );
}

/** The local time in `zone` at this instant, `YYYY-MM-DDTHH:mm:ss`. */
export function wallTime(instantMs: number, zone: string): string {
  const parts: Record<string, string> = {};
  for (const p of formatFor(zone).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  const year = (parts.year ?? "").padStart(4, "0");
  return `${year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * The instant a local time in `zone` names. A time that doesn't exist (skipped when the clocks go
 * forward) moves forward by the gap; one that happens twice (when they go back) is the first.
 */
export function zonedToUtc(wall: string, zone: string): number {
  const local = withSeconds(wall);
  const asUtc = wallAsUtc(local);
  const offsetAt = (t: number) => wallAsUtc(wallTime(t, zone)) - t;
  // The zone's offsets a day either side and at the time itself: a change of clocks has one of
  // them on each side.
  const candidates = [...new Set([-86_400_000, 0, 86_400_000].map((d) => offsetAt(asUtc + d)))].map(
    (offset) => asUtc - offset,
  );
  const exact = candidates.filter((t) => wallTime(t, zone) === local);
  return exact.length > 0 ? Math.min(...exact) : Math.max(...candidates);
}

/** Days from one date to another (`2026-11-20` to `2026-11-22` is 2). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** An instant as ISO 8601 in UTC (`2026-11-20T16:00:00.000Z`). */
export function isoUtc(instantMs: number): string {
  return new Date(instantMs).toISOString();
}
