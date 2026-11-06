// The cron handler (wrangler.jsonc `triggers.crons`), apart from ./index so it can be tested
// without the Workflow classes.

import { captureException, withMonitor } from "@sentry/cloudflare";
import { runCron } from "./app";
import type { Bindings } from "./env";

/** Sentry's cron monitor for the every-minute tick (wrangler.jsonc `triggers.crons`). */
export const CRON_MONITOR = "mezonas-cron";
// DECISION: created by the first check-in (upsert); an issue after 3 missed or failed ticks in a
// row and resolved by the next good one, so one slow minute is not news. 10 minutes is the most a
// tick may run before it counts as failed.
export const CRON_MONITOR_CONFIG = {
  schedule: { type: "crontab", value: "* * * * *" },
  checkinMargin: 2,
  maxRuntime: 10,
  failureIssueThreshold: 3,
  recoveryThreshold: 1,
} as const;

export function scheduled(
  controller: ScheduledController,
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
): void {
  // A failed tick is reported (a no-op where Sentry is off), then fails the invocation as before.
  // Each tick checks in with Sentry's cron monitor, so a cron that stops running, runs long or
  // keeps failing raises an issue of its own; a failed pass inside the tick is reported by the
  // pass (observability/report.ts) and does not fail the check-in.
  ctx.waitUntil(
    withMonitor(
      CRON_MONITOR,
      () => runCron(env, new Date(controller.scheduledTime)),
      CRON_MONITOR_CONFIG,
    ).catch((error: unknown) => {
      captureException(error, { tags: { kind: "cron" } });
      throw error;
    }),
  );
}
