// A KPI's period in the client's time zone (docs/plan.md §1.50): the last 7 or 30 days counting
// today, this week (from Monday) or this month (from the 1st), each up to now.

import { addDays, weekStartOf, zonedParts, zonedTimeToUtc } from "../weekly/week";
import type { KpiPeriod } from "./schema";

export interface KpiBounds {
  from: Date;
  to: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");

// DECISION: a period ends now and starts at local midnight: `7d` is today and the 6 days before,
// `30d` today and the 29 before, `week` from this Monday, `month` from the 1st.
export function kpiBounds(period: KpiPeriod, now: Date, timezone: string): KpiBounds {
  const p = zonedParts(now, timezone);
  const today = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const start =
    period === "7d"
      ? addDays(today, -6)
      : period === "30d"
        ? addDays(today, -29)
        : period === "week"
          ? weekStartOf(now, timezone)
          : `${p.year}-${pad(p.month)}-01`;
  return { from: zonedTimeToUtc(start, 0, 0, timezone), to: now };
}
