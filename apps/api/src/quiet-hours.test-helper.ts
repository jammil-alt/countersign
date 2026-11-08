// Quiet hours for tests, set around the current time so no test depends on the time of day.
// Test clients use the default timezone, UTC. A fixed window such as 00:00–23:59 ("always quiet")
// misses the last minute of the day, and 03:00–03:01 ("never quiet") is quiet at 03:00; start and
// end may not be equal (core's QuietHours), so a window has to be placed relative to now.

const HOUR_MS = 60 * 60 * 1000;
const hhmm = (at: Date): string => at.toISOString().slice(11, 16);

/** Quiet now: six hours either side of `now` (UTC), wrapping midnight when it must. */
export function quietNow(now: Date = new Date()): { start: string; end: string } {
  return {
    start: hhmm(new Date(now.getTime() - 6 * HOUR_MS)),
    end: hhmm(new Date(now.getTime() + 6 * HOUR_MS)),
  };
}

/** Not quiet now: one minute, twelve hours from `now` (UTC). */
export function quietNever(now: Date = new Date()): { start: string; end: string } {
  const at = new Date(now.getTime() + 12 * HOUR_MS);
  return { start: hhmm(at), end: hhmm(new Date(at.getTime() + 60_000)) };
}
