// The connector self-test (2026-11-28). On staging (and locally), for the Sandbox client only
// (`tenant.settings.sandbox`), each connected QuickBooks, Resend and Twilio connection gets its
// fixed list of checks (./checks.ts) with its own stored credentials, as an agent's call would:
// nothing new is stored as a secret, and nothing is written to a client's tool or sent.
//
// Each run stores one `connection_change` row per connection (kind `selftest`, its checks with
// pass, fail or skip, time taken and the provider's scrubbed error). The platform health pass reads
// the newest of them (observability/health.ts, kind `selftest_failed`): a failed check is in the
// MCP server's `ops_health`, and in Sentry within the hour as an `ops_health` issue.

import { toConnectionRef } from "@countersign/agents";
import {
  type ConnectionRef,
  type CredentialsAccessor,
  credentialKeysFromEnv,
  type FetchLike,
  globalFetch,
  noopLogger,
} from "@countersign/connectors";
import {
  SELFTEST_CHANGE,
  SelftestChange,
  type SelftestConnectionResult,
  type SelftestRun,
} from "@countersign/core";
import {
  activeClient,
  connection,
  connectionChange,
  type Db,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import { type AppDeps, HttpError } from "../http";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { dbSyncedRecords } from "../qbo/receivables";
import { credentialsFor } from "../runs/execute";
import { CheckList, SELFTEST_CONNECTORS } from "./checks";

/** The environments the self-test may run in. Production never: its clients are real. */
// DECISION: by `ENVIRONMENT` (wrangler.jsonc), "staging" and "development" only; an unset one is
// refused too, so a Worker deployed without it can't reach a real client's tools this way.
export const SELFTEST_ENVIRONMENTS: readonly string[] = ["staging", "development"];

/** The cron's daily run, UTC. */
// DECISION: 12:05 UTC, so its rows land in the hour the 13:12 health pass reports, the one that
// also reports what is stuck: a failed check reaches Sentry in that day's morning (US) pass.
export const SELFTEST_AT = { hour: 12, minute: 5 } as const;

export interface SelftestDeps {
  db: Db;
  platform: Platform;
  environment: string | undefined;
  /** One connection's credentials, each read and write in its own transaction (refreshes stick). */
  credentials: (conn: ConnectionRef) => CredentialsAccessor;
  fetch: FetchLike;
  /** `QBO_ENV`: the QuickBooks API the connector calls. Only the sandbox company is checked. */
  qboEnv?: string | undefined;
  resendApiKey?: string | undefined;
  resendFallbackDomainId?: string | undefined;
  now?: () => Date;
}

/**
 * The deployment's self-test deps (the route's and the cron's), or null where connections'
 * credentials can't be read (no ENCRYPTION_KEY).
 */
export function selftestDepsFrom(
  env: Bindings,
  services: { db: Db; platform: Platform; deps: Pick<AppDeps, "fetch"> },
): SelftestDeps | null {
  if (!env.ENCRYPTION_KEY) return null;
  return {
    db: services.db,
    platform: services.platform,
    environment: env.ENVIRONMENT,
    credentials: credentialsFor(services.db, credentialKeysFromEnv(env)),
    fetch: services.deps.fetch?.(env) ?? globalFetch(),
    qboEnv: env.QBO_ENV,
    resendApiKey: env.RESEND_API_KEY,
    resendFallbackDomainId: env.RESEND_FALLBACK_DOMAIN_ID,
  };
}

/** Why the self-test may not run here, or null when it may. */
export function selftestRefusal(environment: string | undefined): string | null {
  return environment && SELFTEST_ENVIRONMENTS.includes(environment)
    ? null
    : `the self-test runs on staging and locally only, not in ${environment ?? "an unnamed environment"}`;
}

async function sandboxTenant(db: Db, tenantId: string): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const [t] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(and(eq(tenant.id, tenantId), isNull(tenant.retiredAt)));
    return (t?.settings as { sandbox?: unknown } | undefined)?.sandbox === true;
  });
}

/** 403 outside staging and development, and for any client that is not the Sandbox. */
export async function refuseUnlessSandbox(
  db: Db,
  environment: string | undefined,
  tenantId: string,
): Promise<void> {
  const refused = selftestRefusal(environment);
  if (refused) throw new HttpError(403, "selftest_off", refused);
  if (!(await sandboxTenant(db, tenantId))) {
    throw new HttpError(403, "not_sandbox", "the self-test runs on the Sandbox client only");
  }
}

/**
 * Runs every check on the Sandbox client's connected connections and stores the results. Refuses
 * (403) outside staging and development, and for any client that is not the Sandbox.
 */
export async function runSelftest(
  deps: SelftestDeps,
  tenantId: string,
  by: { kind: "cron" } | { kind: "operator"; userId: string },
): Promise<SelftestRun> {
  await refuseUnlessSandbox(deps.db, deps.environment, tenantId);
  const now = deps.now?.() ?? new Date();
  const rows = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.tenantId, tenantId),
          inArray(connection.connector, Object.keys(SELFTEST_CONNECTORS)),
          eq(connection.status, "connected"),
        ),
      )
      .orderBy(connection.connector, connection.createdAt),
  );
  const results: SelftestConnectionResult[] = [];
  for (const row of rows) {
    const checks = SELFTEST_CONNECTORS[row.connector];
    const connector = deps.platform.connectors.get(row.connector);
    if (!checks || !connector) continue;
    const list = new CheckList();
    if (row.connector === "qbo" && deps.qboEnv === "production") {
      // Belt and braces: this deployment's QuickBooks is the production API, not the sandbox's.
      list.results.push({
        id: "qbo",
        what: "QuickBooks' sandbox company only",
        status: "skip",
        ms: 0,
        error: "this deployment calls QuickBooks' production API",
      });
    } else {
      // DECISION: the connection as an agent's call sees it, without the operator's per-action
      // switches (a check of a call turned off for agents still shows whether it works); the
      // client's matrix still applies, and a call it has off is skipped, not failed.
      const ref = toConnectionRef(row);
      await checks(list, {
        connector,
        ctx: {
          tenantId,
          connection: ref,
          credentials: deps.credentials(ref),
          logger: noopLogger,
          now: () => now,
          services: { records: dbSyncedRecords(deps.db, ref) },
        },
        fetch: deps.fetch,
        resendApiKey: deps.resendApiKey,
        resendFallbackDomainId: deps.resendFallbackDomainId,
        now,
      });
    }
    const count = (s: string) => list.results.filter((c) => c.status === s).length;
    results.push({
      connectionId: row.id,
      connector: row.connector,
      passed: count("pass"),
      failed: count("fail"),
      skipped: count("skip"),
      checks: list.results,
    });
  }
  await withTenant(deps.db, tenantId, async (tx) => {
    for (const r of results) {
      const change: SelftestChange = {
        kind: SELFTEST_CHANGE,
        at: now.toISOString(),
        environment: deps.environment ?? "",
        by: by.kind,
        connector: r.connector,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
        checks: r.checks,
      };
      await tx.insert(connectionChange).values({
        tenantId,
        connectionId: r.connectionId,
        actorId: by.kind === "operator" ? by.userId : null,
        change,
        createdAt: now,
      });
    }
  });
  return summarize(
    tenantId,
    results.map((r) => ({ ...r, at: now.toISOString() })),
    deps.environment ?? null,
  );
}

function summarize(
  tenantId: string,
  connections: SelftestRun["connections"],
  environment: string | null,
): SelftestRun {
  const sum = (k: "passed" | "failed" | "skipped") => connections.reduce((n, c) => n + c[k], 0);
  const at = connections.map((c) => c.at).sort();
  return {
    tenantId,
    at: at.at(-1) ?? null,
    environment,
    passed: sum("passed"),
    failed: sum("failed"),
    skipped: sum("skipped"),
    connections,
  };
}

/** The newest self-test of each of the client's connections. */
export async function lastSelftest(db: Db, tenantId: string): Promise<SelftestRun> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .selectDistinctOn([connectionChange.connectionId], {
        connectionId: connectionChange.connectionId,
        change: connectionChange.change,
        createdAt: connectionChange.createdAt,
      })
      .from(connectionChange)
      .where(
        and(
          eq(connectionChange.tenantId, tenantId),
          sql`${connectionChange.change}->>'kind' = ${SELFTEST_CHANGE}`,
        ),
      )
      .orderBy(connectionChange.connectionId, desc(connectionChange.createdAt)),
  );
  let environment: string | null = null;
  const connections: SelftestRun["connections"] = [];
  for (const r of rows) {
    const c = SelftestChange.safeParse(r.change);
    if (!c.success) continue;
    environment = c.data.environment || environment;
    connections.push({
      connectionId: r.connectionId,
      connector: c.data.connector,
      passed: c.data.passed,
      failed: c.data.failed,
      skipped: c.data.skipped,
      checks: c.data.checks,
      at: r.createdAt.toISOString(),
    });
  }
  connections.sort((a, b) => a.connector.localeCompare(b.connector));
  return summarize(tenantId, connections, environment);
}

/**
 * The cron's call: once a day at SELFTEST_AT, each Sandbox client's self-test, on staging and
 * locally only. Returns how many clients it ran for.
 */
export async function selftestTick(deps: SelftestDeps, at: Date): Promise<number> {
  if (selftestRefusal(deps.environment)) return 0;
  if (at.getUTCHours() !== SELFTEST_AT.hour || at.getUTCMinutes() !== SELFTEST_AT.minute) return 0;
  const clients = await deps.db
    .select({ id: tenant.id })
    .from(tenant)
    // §1.243: a locked Sandbox client is skipped, as every sweep skips a locked client.
    .where(and(activeClient(), sql`(${tenant.settings}->>'sandbox')::boolean`));
  let ran = 0;
  for (const c of clients) {
    try {
      await runSelftest({ ...deps, now: () => at }, c.id, { kind: "cron" });
      ran += 1;
    } catch (error) {
      reportHandled(`self-test for client ${c.id} failed`, error, {
        job: "selftest",
        client: c.id,
      });
    }
  }
  return ran;
}
