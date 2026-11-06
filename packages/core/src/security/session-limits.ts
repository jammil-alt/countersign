// How long a sign-in lasts (docs/plan.md §1.35): shared by packages/auth, which enforces it, and
// apps/web, which signs out by itself and marks the requests a person made.

/** No input for this long and the session ends (HIPAA §164.312(a)(2)(iii), SOC 2 CC6.1). */
export const SESSION_IDLE_SEC = 30 * 60;

/** The longest a sign-in lasts, active or not. */
export const SESSION_MAX_AGE_SEC = 12 * 60 * 60;

/**
 * Sent by the app (value `1`) on a request made while the person was using it: a key press, click
 * or touch in the last minute. Only such requests count as activity, so background polling never
 * keeps an unattended session alive.
 */
export const SESSION_ACTIVITY_HEADER = "x-countersign-activity";

/** Input within this long before a request makes it the person's own. */
export const SESSION_ACTIVITY_WINDOW_SEC = 60;
