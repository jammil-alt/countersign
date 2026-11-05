// An error a route or job catches and turns into an answer (a 502, a "did not start", a hand-over to
// a person) is still one we need to see: logged, and sent to Sentry like an unhandled one (scrubbed
// the same way, observability/sentry.ts; a no-op where Sentry is off). Before this, these only
// reached the Worker's console, so the first QuickBooks sign-in failure on staging (2026-11-05) had
// to be found by reading code.

import { captureException } from "@sentry/cloudflare";

export function reportHandled(
  what: string,
  error: unknown,
  tags: Record<string, string> = {},
): void {
  console.error(what, error);
  captureException(error, { tags: { handled: "yes", ...tags }, extra: { what } });
}
