// Applies packages/db/migrations to DIRECT_DATABASE_URL, as cs_owner (`pnpm --filter
// @countersign/db run db:migrate`). Called by scripts/setup-postgres.sh, checks.yml and deploy.yml.
// Plain JavaScript on purpose: CI and deploys run it with nothing but Node and the installed deps.
//
// The runtime never migrates: the Worker's role (cs_worker) owns nothing and could not.
//
// Migrations apply while the previous Worker is serving. Drizzle applies every pending migration
// in one transaction, so an ALTER TABLE waiting for a lock that live traffic holds would make every
// later query on that table queue behind it. The session therefore gives up on any one lock after
// LOCK_TIMEOUT, and the whole run is tried again a few times: drizzle rolls its transaction back
// and, on the next try, reads the journal again and applies only what is still pending.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// DECISION: 5 s for any one lock. Long enough for a busy table's in-flight queries to finish,
// short enough that requests queued behind a waiting ALTER are held for seconds, not minutes.
export const LOCK_TIMEOUT = "5s";
// DECISION: 10 minutes for any one statement. The largest backfills (0047's vendor catalog) take
// well under a second on today's data; this only stops a runaway statement holding its locks.
export const STATEMENT_TIMEOUT = "10min";
/** The waits (ms) before each try after the first. */
export const RETRY_DELAYS_MS = [5_000, 15_000];

/** lock_not_available (lock_timeout) and deadlock_detected: another session held what we needed. */
const RETRYABLE = new Set(["55P03", "40P01"]);

/** The Postgres error code of an error or of the error it wraps (drizzle wraps postgres.js'). */
export function sqlState(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  }
  return undefined;
}

/** The innermost message: Postgres' own, without the migration's SQL that drizzle's repeats. */
function reason(error) {
  let e = error;
  while (e?.cause instanceof Error) e = e.cause;
  return e instanceof Error ? e.message : String(error);
}

/** The migrating session's timeouts; set once the advisory lock is held. */
export async function prepareSession(sql) {
  await sql.unsafe(`set lock_timeout = '${LOCK_TIMEOUT}'`);
  await sql.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT}'`);
}

/**
 * Runs `apply`, and again after each delay while it fails with a lock timeout or a deadlock.
 * Anything else, or the last failure, is thrown.
 */
export async function withLockRetry(apply, options = {}) {
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const log = options.log ?? ((line) => console.error(line));
  for (let attempt = 0; ; attempt++) {
    try {
      return await apply();
    } catch (error) {
      const code = sqlState(error);
      if (!RETRYABLE.has(code) || attempt >= delays.length) throw error;
      const wait = delays[attempt];
      log(
        `db:migrate: try ${attempt + 1} rolled back, nothing applied (${code}: ${reason(error)}); ` +
          `trying again in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
}

/**
 * Takes the advisory lock, sets the session's timeouts and applies what is pending; returns the
 * number of migrations applied in total. `apply` and the retry options are for tests.
 */
export async function runMigrations(url, options = {}) {
  const migrationsFolder =
    options.migrationsFolder ?? fileURLToPath(new URL("../migrations", import.meta.url));
  const apply = options.apply ?? ((sql) => migrate(drizzle({ client: sql }), { migrationsFolder }));
  // One connection, so the advisory lock, the settings and the migration share a session.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Two deploys racing would both read the journal as pending; the second waits, then finds
    // nothing. Taken before lock_timeout is set, so the second deploy waits as long as it takes.
    await sql`select pg_advisory_lock(hashtext('countersign:migrate'))`;
    await prepareSession(sql);
    await withLockRetry(() => apply(sql), options);
    const [row] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    return row?.n ?? 0;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) {
    console.error("db:migrate: DIRECT_DATABASE_URL is required (the cs_owner connection string)");
    process.exit(1);
  }
  try {
    const n = await runMigrations(url);
    console.error(`db:migrate: ${n} migrations applied in total`);
  } catch (error) {
    const code = sqlState(error);
    console.error(`db:migrate failed${code ? ` (${code})` : ""}:`, reason(error));
    process.exitCode = 1;
  }
}
