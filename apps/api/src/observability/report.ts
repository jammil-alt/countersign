// An error a route or job catches and turns into an answer (a 502, a "did not start", a hand-over to
// a person) is still one we need to see: logged, and sent to Sentry like an unhandled one (scrubbed
// the same way, observability/sentry.ts; a no-op where Sentry is off). Before this, these only
// reached the Worker's console, so the first QuickBooks sign-in failure on staging (2026-11-05) had
// to be found by reading code.
//
// Tags say where it happened, so the inbox can be filtered: `job` for the cron's passes and other
// background work, `kind` for the Worker's own plumbing (deferred work, response contracts).
// Ids (a client's, a run's) go in tags or the `what`; never a client's text.

import { isClientLocked } from "@countersign/db";
import { captureException, captureMessage } from "@sentry/cloudflare";

export type ReportTags = Record<string, string>;

export function reportHandled(what: string, error: unknown, tags: ReportTags = {}): void {
  // §1.243: work refused because its client is locked is the lockdown doing its job, not a fault.
  if (isClientLocked(error)) {
    console.info(what, "(the client is locked)", tags);
    return;
  }
  console.error(what, error);
  captureException(error, { tags: { handled: "yes", ...tags }, extra: { what } });
}

/**
 * The database connection went away under work that is tried again on its own schedule (the
 * cron's next tick): kept in Sentry as a warning with its stack, so a run of them still shows,
 * but not an error, so one drop pages no one (`isDatabaseDrop`, Sentry MEZONAS-API-3, -A, -B).
 */
export function reportDrop(what: string, error: unknown, tags: ReportTags = {}): void {
  if (isClientLocked(error)) return reportHandled(what, error, tags);
  console.warn(what, error);
  captureException(error, {
    level: "warning",
    tags: { handled: "yes", db: "dropped", ...tags },
    extra: { what },
  });
}

/**
 * Something wrong that is not an exception: a definition that does not parse, a count of items a
 * pass could not handle, a setting that is missing. Grouped by `what`, so keep ids out of it and
 * put them in `tags`.
 */
export function reportProblem(what: string, tags: ReportTags = {}): void {
  console.error(what, tags);
  captureMessage(what, { level: "warning", tags: { handled: "yes", ...tags } });
}
