// builder-plan.md B1: what a kept try expects. The try's result is the expected answer, less what
// its own run made: the ids of rows it created (an external action, an inbox item, a thread) and
// the times it ran at. Those differ on every run, so a case expecting them could never pass again.

/** A UUID v7 (the database's ids, `uuid_generate_v7()`): its first 48 bits are its time in ms. */
const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A date and time (a date alone is a document's, never the run's). */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Clock slack between the run's start and the rows it made (the same database clock). */
const SLACK_MS = 1000;

function madeSince(value: unknown, since: number): boolean {
  if (typeof value !== "string") return false;
  const v7 = UUID_V7.exec(value);
  if (v7) return Number.parseInt(`${v7[1]}${v7[2]}`, 16) >= since;
  if (DATE_TIME.test(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) && t >= since;
  }
  return false;
}

const DROP = Symbol("drop");

function clean(value: unknown, since: number): unknown {
  if (madeSince(value, since)) return DROP;
  if (Array.isArray(value)) {
    const items = value.map((v) => clean(v, since));
    // An array's places matter when compared: one that holds a run's id is left out whole.
    return items.includes(DROP) ? DROP : items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = clean(v, since);
      if (c !== DROP) out[k] = c;
    }
    return out;
  }
  return value;
}

/**
 * The expected answer kept from a try's result: the result, less every id and date-time the try's
 * run made (a UUID v7 or a date-time at or after `runStartedAt`): an object leaves out that field,
 * an array holding one is left out whole.
 */
// DECISION (builder-plan.md B1): run-made values are told apart by time, not by field name: the
// database's ids are UUID v7s, so an id minted by this run is newer than its start, while a
// Sandbox record's id (a vendor, an item) is older and is kept as part of the answer.
export function keptAnswer(output: unknown, runStartedAt: Date): unknown {
  const since = runStartedAt.getTime() - SLACK_MS;
  const c = clean(output, since);
  return c === DROP ? null : c;
}
