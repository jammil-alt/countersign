// Readiness (`GET /api/ready`, docs/operations.md "After a deploy"): unlike `/api/health`, it
// reaches the database the way every request does (the request's client: Hyperdrive, as
// cs_worker), so a wrong password, a broken Hyperdrive config or an unreachable database shows
// after a deploy instead of on the first person's request. It reads no client data, needs no
// session, and says nothing beyond "ok" or "unavailable" and the deployed commit.

import { routes } from "@countersign/core";
import type { Db } from "@countersign/db";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "./http";
import { reportHandled, reportProblem } from "./observability/report";

// DECISION: 3 s. Hyperdrive's warm connection answers in milliseconds; a check that waits longer
// is reported unavailable rather than holding the smoke test (or a load balancer).
export const READY_TIMEOUT_MS = 3_000;
// DECISION: the route needs no session, so anyone can call it as often as they like: during an
// outage it reports to error tracking at most once a minute per isolate, not once per call.
export const READY_REPORT_EVERY_MS = 60_000;

const COMMIT = /^[0-9a-f]{7,40}$/;

/** The deployed commit when deploy.yml set one that looks like a commit id; otherwise null. */
export function deployedSha(value: string | undefined): string | null {
  const sha = value?.trim().toLowerCase() ?? "";
  return COMMIT.test(sha) ? sha : null;
}

let lastReportAt = Number.NEGATIVE_INFINITY;

/** Whether a failed check may be reported now (once per `READY_REPORT_EVERY_MS`); notes it. */
export function mayReport(now: number = Date.now()): boolean {
  if (now - lastReportAt < READY_REPORT_EVERY_MS) return false;
  lastReportAt = now;
  return true;
}

/** Tests: forget the last report. */
export function resetReadyReports(): void {
  lastReportAt = Number.NEGATIVE_INFINITY;
}

type ReadyDb = Pick<Db, "execute"> & {
  $client?: { end(options?: { timeout?: number }): Promise<unknown> };
};

/**
 * True when the database answers within `timeoutMs`; false on any error or on the timeout. On a
 * timeout the client is ended at once (`timeout: 0`), so the hung query holds nothing open.
 */
export async function databaseAnswers(db: ReadyDb, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    // DECISION: `select now()`, not `select 1`: Hyperdrive caches read queries outside a
    // transaction unless they call a stable or volatile function, and `now()` is one, so the
    // answer always comes from the database itself, whatever the Hyperdrive config's caching.
    const answer = await Promise.race([db.execute(sql`select now()`).then(() => "ok"), timeout]);
    if (answer === "ok") return true;
    // The request's client is closed after the response too; ending it twice is the same end.
    void db.$client?.end({ timeout: 0 }).catch(() => {});
    if (mayReport()) reportProblem("readiness: the database check timed out", { kind: "ready" });
    return false;
  } catch (error) {
    // The cause goes to error tracking only, never into the answer.
    if (mayReport()) {
      reportHandled("readiness: the database check failed", error, { kind: "ready" });
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Mounted after `requestState`, so it uses the request's own database client. */
export function readyRoutes(app: Hono<AppEnv>): void {
  app.get(routes.ready.path, async (c) => {
    let db: Db | undefined;
    try {
      db = c.get("req").services().db;
    } catch (error) {
      // No HYPERDRIVE binding, or the client could not be built.
      if (mayReport()) reportHandled("readiness: no database client", error, { kind: "ready" });
    }
    const ok = db ? await databaseAnswers(db, READY_TIMEOUT_MS) : false;
    const body = routes.ready.response.parse({
      ok,
      db: ok ? "ok" : "unavailable",
      sha: deployedSha(c.env?.DEPLOYED_SHA),
    });
    return c.json(body, ok ? 200 : 503);
  });
}
