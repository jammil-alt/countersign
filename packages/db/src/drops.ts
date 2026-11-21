// A database connection that went away under a query: the server ending the session (Neon's
// compute restarting or scaling down, Hyperdrive moving the connection) or the socket closing
// before an answer. Nothing about the query was wrong, and the same work succeeds once the next
// query reconnects (postgres.js reconnects by itself). Callers that retry on their own schedule
// (the cron's per-client pass) report these as warnings, not errors.
//
// Staging and production, 2026-11-13 to 2026-11-21 (Sentry MEZONAS-API-3, -A, -B): "Node shutting
// down." from the server, then "write CONNECTION_CLOSED …hyperdrive.local:5432", each once, each in
// one client's cron pass, caught up by the next minute's tick.

/** postgres.js's codes for a connection that is gone (its `Errors.connection`). */
const CLIENT_DROPS = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
]);

/** SQLSTATEs for a server that is shutting down or not yet taking connections (class 57). */
const SERVER_DROPS = new Set(["57P01", "57P02", "57P03"]);

/** Neon's proxy and compute say this with an internal code, so the words are checked too. */
const SHUTTING_DOWN = /\bshutting down\b/i;

/** Whether an error (or one it was caused by) is the database connection going away. */
export function isDatabaseDrop(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 5; depth += 1) {
    if (typeof e !== "object") return false;
    const { code, message, name, cause } = e as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    if (typeof code === "string" && (CLIENT_DROPS.has(code) || SERVER_DROPS.has(code))) {
      return true;
    }
    if (name === "PostgresError" && typeof message === "string" && SHUTTING_DOWN.test(message)) {
      return true;
    }
    e = cause;
  }
  return false;
}
