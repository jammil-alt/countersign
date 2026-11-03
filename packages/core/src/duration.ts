import { z } from "zod";

// DECISION: durations use Cloudflare Workflows' own string form ("30 seconds", "5 days"), so the
// executor can pass them to step.sleep / waitForEvent unchanged. Units up to weeks.
const DURATION_RE = /^(\d+)\s*(second|minute|hour|day|week)s?$/;
const UNIT_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

export const Duration = z
  .string()
  .regex(DURATION_RE, 'a duration such as "30 minutes" or "5 days"')
  .meta({ description: 'A duration such as "30 minutes" or "5 days"' });
export type Duration = z.infer<typeof Duration>;

export function parseDuration(value: string): number {
  const m = DURATION_RE.exec(value.trim());
  if (!m) throw new Error(`Invalid duration: ${value}`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

export function isDuration(value: string): boolean {
  return DURATION_RE.test(value.trim());
}
