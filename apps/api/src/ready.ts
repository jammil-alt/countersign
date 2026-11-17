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
import { reportHandled } from "./observability/report";

// DECISION: 3 s. Hyperdrive's warm connection answers `select 1` in milliseconds; a check that
// waits longer is reported unavailable rather than holding the smoke test (or a load balancer).
export const READY_TIMEOUT_MS = 3_000;

const COMMIT = /^[0-9a-f]{7,40}$/;

/** The deployed commit when deploy.yml set one that looks like a commit id; otherwise null. */
export function deployedSha(value: string | undefined): string | null {
  const sha = value?.trim().toLowerCase() ?? "";
  return COMMIT.test(sha) ? sha : null;
}

/** True when `select 1` answers within `timeoutMs`; false on any error or on the timeout. */
export async function databaseAnswers(
  db: Pick<Db, "execute">,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([db.execute(sql`select 1`).then(() => true as const), timeout]);
  } catch (error) {
    // The cause goes to error tracking only, never into the answer.
    reportHandled("readiness: the database check failed", error, { kind: "ready" });
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
      reportHandled("readiness: no database client", error, { kind: "ready" });
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
