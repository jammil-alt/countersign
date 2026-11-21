// A wait as a person picks it (owner, 2026-11-21: "the reminders should be a time picker not an
// open field… 15, 30, 60 min, 2, 4, 6, 12 hours, 1, 2, 7 days and custom… the custom should have
// weeks, days, hours, minutes"; docs/plan.md §1.177). The format keeps one number and one unit
// ("90 minutes", "2 days"), so several units are written in the smallest one used. Reminders are
// times after the asking (up to five); "5 times every 30 minutes" is those five times.

/** The times the picker offers before Custom, as the format stores them. */
export const DURATION_PRESETS = [
  "15 minutes",
  "30 minutes",
  "1 hour",
  "2 hours",
  "4 hours",
  "6 hours",
  "12 hours",
  "1 day",
  "2 days",
  "7 days",
] as const;

export const DURATION_UNITS = ["week", "day", "hour", "minute"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];
export type DurationParts = Record<DurationUnit, number>;

const RE = /^(\d+)\s*(second|minute|hour|day|week)s?$/;
/** How many of the next smaller unit one of each is. */
const DOWN: Record<Exclude<DurationUnit, "minute">, number> = { week: 7, day: 24, hour: 60 };
const MINUTES: Record<DurationUnit, number> = { week: 10_080, day: 1_440, hour: 60, minute: 1 };

function read(value: string): { n: number; unit: DurationUnit | "second" } | null {
  const m = RE.exec(value.trim());
  return m ? { n: Number(m[1]), unit: m[2] as DurationUnit | "second" } : null;
}

/** "1 hour", "30 minutes". */
export function durationOf(n: number, unit: DurationUnit): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** One spelling for a time, so "60 minutes" and "1 hour " pick the same preset. */
function same(a: string, b: string): boolean {
  const x = read(a);
  const y = read(b);
  return !!x && !!y && x.n === y.n && x.unit === y.unit;
}

/** The preset a stored time is, or null when it is none of them. */
export function presetOf(
  value: string,
  presets: readonly string[] = DURATION_PRESETS,
): string | null {
  return presets.find((p) => same(p, value)) ?? null;
}

/**
 * A stored time as the Custom fields show it, or null when they can't (seconds, or not a time).
 * `split` spreads it over the larger units ("90 minutes" is 1 hour 30 minutes); without it the
 * number stays in its own unit, as business hours need: there a day is the same time on the next
 * open day, not 24 working hours.
 */
export function partsOf(value: string, split: boolean): DurationParts | null {
  const v = read(value);
  if (!v || v.unit === "second") return null;
  const out: DurationParts = { week: 0, day: 0, hour: 0, minute: 0 };
  if (!split) {
    out[v.unit] = v.n;
    return out;
  }
  let left = v.n * MINUTES[v.unit];
  for (const unit of DURATION_UNITS) {
    out[unit] = Math.floor(left / MINUTES[unit]);
    left -= out[unit] * MINUTES[unit];
  }
  return out;
}

/**
 * The Custom fields as the format stores them: one unit when only one is filled, else everything
 * in the smallest unit filled. Null when nothing is filled.
 */
export function durationOfParts(parts: DurationParts): string | null {
  const used = DURATION_UNITS.filter((u) => parts[u] > 0);
  const smallest = used.at(-1);
  if (!smallest) return null;
  let total = 0;
  for (const unit of DURATION_UNITS) {
    total += parts[unit];
    if (unit === smallest) break;
    total *= DOWN[unit as Exclude<DurationUnit, "minute">];
  }
  return durationOf(total, smallest);
}

/** A time in words over its units: "2 hours 30 minutes"; the text itself when it isn't one. */
export function durationWords(value: string): string {
  const parts = partsOf(value, true);
  if (!parts) return value;
  const said = DURATION_UNITS.filter((u) => parts[u] > 0).map((u) => durationOf(parts[u], u));
  return said.length ? said.join(" ") : value;
}

/** A stored time in minutes of clock time, or null when it isn't one. */
export function minutesOf(value: string): number | null {
  const v = read(value);
  if (!v) return null;
  return v.unit === "second" ? v.n / 60 : v.n * MINUTES[v.unit];
}

/** The most reminders a wait may have (the format's limit). */
export const MAX_REMINDERS = 5;

/** Reminders as a person says them: so many times, one every so long; or times written out. */
export type ReminderPlan =
  | { kind: "none" }
  | { kind: "every"; times: number; every: string }
  | { kind: "set"; at: string[] };

/**
 * Stored reminders as a plan: the same gap from the asking to the first and between each (in the
 * same unit) reads as "N times, every so long"; anything else stays the times written.
 */
export function reminderPlan(remind: readonly string[] | undefined): ReminderPlan {
  if (!remind || remind.length === 0) return { kind: "none" };
  const first = read(remind[0] as string);
  if (first && first.unit !== "second" && first.n > 0) {
    const even = remind.every((r, i) => {
      const v = read(r);
      return !!v && v.unit === first.unit && v.n === first.n * (i + 1);
    });
    if (even) {
      return { kind: "every", times: remind.length, every: durationOf(first.n, first.unit) };
    }
  }
  return { kind: "set", at: [...remind] };
}

/** A plan as the format stores it: each reminder's time after the asking. */
export function remindersOf(plan: ReminderPlan): string[] {
  if (plan.kind === "none") return [];
  if (plan.kind === "set") return plan.at;
  const v = read(plan.every);
  if (!v || v.unit === "second" || v.n === 0) return [];
  const times = Math.min(Math.max(1, plan.times), MAX_REMINDERS);
  const unit = v.unit;
  return Array.from({ length: times }, (_, i) => durationOf(v.n * (i + 1), unit));
}

/** "Reminds them 30 minutes after asking." / "…5 times, every 30 minutes: the last after 2 hours 30 minutes." */
export function reminderWords(plan: ReminderPlan): string {
  if (plan.kind === "none") return "No reminders.";
  if (plan.kind === "set") {
    return plan.at.length === 1
      ? `Reminds them ${durationWords(plan.at[0] as string)} after asking.`
      : `Reminds them ${plan.at.length} times after asking.`;
  }
  if (plan.times === 1) return `Reminds them once, ${durationWords(plan.every)} after asking.`;
  const last = remindersOf(plan).at(-1) ?? plan.every;
  return `Reminds them ${plan.times} times, every ${durationWords(plan.every)}: the last ${durationWords(last)} after asking.`;
}
