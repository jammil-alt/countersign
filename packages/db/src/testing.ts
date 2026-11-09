// Throwaway databases for tests (CLAUDE.md "Testing"): one per test file, migrated, with Neon's
// roles, dropped at the end. Node only; not exported from the Worker-safe index.
//
// Roles are made the way scripts/setup-postgres.sh makes them (neon_superuser as an empty
// stand-in, cs_owner with CREATEROLE and BYPASSRLS, cs_runtime by the first migration, cs_worker by
// scripts/provision-worker-role.mjs), so what the tests prove holds on Neon too. Migrations run as
// cs_owner. Tests act as cs_worker with `SET LOCAL ROLE cs_worker` from the admin connection
// (`asWorker`), so no password of a developer's local cs_worker is ever changed.
//
// Without a reachable server the helpers return null and the tests skip, unless
// COUNTERSIGN_REQUIRE_DB=1 (CI), where they fail.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { closeDb, createDb, type Db, type Tx } from "./client";

const DEFAULT_ADMIN_URL = "postgresql://postgres:postgres@localhost:5432/postgres";
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url).href);
const PROVISION = fileURLToPath(
  new URL("../scripts/provision-worker-role.mjs", import.meta.url).href,
);

export const adminUrl = (): string => process.env.TEST_ADMIN_DATABASE_URL || DEFAULT_ADMIN_URL;
const required = () => process.env.COUNTERSIGN_REQUIRE_DB === "1";

let reachable: Promise<boolean> | undefined;

/** Whether the test server answers. Throws instead of answering false when COUNTERSIGN_REQUIRE_DB=1. */
export function databaseAvailable(): Promise<boolean> {
  reachable ??= (async () => {
    const probe = postgres(adminUrl(), { max: 1, connect_timeout: 3, onnotice: () => {} });
    try {
      await probe`select 1`;
      return true;
    } catch (error) {
      if (required()) {
        throw new Error(`COUNTERSIGN_REQUIRE_DB=1 but ${redact(adminUrl())} is unreachable`, {
          cause: error,
        });
      }
      return false;
    } finally {
      await probe.end({ timeout: 1 });
    }
  })();
  return reachable;
}

function redact(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = "***";
  return u.toString();
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Runs DDL that may race with another test file doing the same; cluster-wide roles are shared. */
async function ensureRole(admin: postgres.Sql, name: string, options: string): Promise<void> {
  await admin.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}') THEN
        CREATE ROLE ${name} ${options};
      END IF;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN NULL;
    END
    $$`);
}

/** The roles Neon has, as scripts/setup-postgres.sh creates them on a plain Postgres. */
async function ensureNeonRoles(admin: postgres.Sql): Promise<void> {
  await ensureRole(admin, "neon_superuser", "NOLOGIN");
  await ensureRole(admin, "cs_owner", "NOLOGIN CREATEROLE BYPASSRLS");
}

/** cs_worker through the real provisioning script, only when it does not exist yet. */
async function ensureWorker(admin: postgres.Sql, dbUrl: string): Promise<void> {
  const [row] = await admin<{ member: boolean }[]>`
    select pg_has_role('cs_worker', 'cs_runtime', 'MEMBER') as member
    from pg_roles where rolname = 'cs_worker'`;
  if (row) {
    if (!row.member) await admin.unsafe("GRANT cs_runtime TO cs_worker");
    return;
  }
  // As cs_owner, as on Neon and in CI: on Postgres 16 a CREATEROLE role may later alter (re-key)
  // only the roles it created, so a cs_worker made by the superuser would lock setup-postgres.sh out.
  const asOwner = new URL(dbUrl);
  asOwner.searchParams.set("options", "-c role=cs_owner");
  const run = () =>
    promisify(execFile)(process.execPath, [PROVISION], {
      env: {
        ...process.env,
        OWNER_URL: asOwner.toString(),
        WORKER_PASSWORD: randomBytes(24).toString("hex"),
      },
    });
  try {
    await run();
  } catch {
    // Another test file created it at the same moment; the second attempt re-keys it, which no
    // test depends on (they switch to it with SET ROLE).
    await run();
  }
}

export interface MigrateOptions {
  /**
   * Stop after this journal tag (e.g. `0018_extraction_cost`), to put data in a database as an
   * earlier Worker saw it and then apply the rest (a backfill's test).
   */
  upTo?: string;
}

/** Applies every migration (or those up to `upTo`) as cs_owner, the role that migrates on Neon. */
export async function migrateAsOwner(url: string, options: MigrateOptions = {}): Promise<void> {
  const client = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { options: "-c role=cs_owner" },
  });
  const folder = options.upTo ? migrationsUpTo(options.upTo) : MIGRATIONS;
  try {
    await migrate(drizzle({ client }), { migrationsFolder: folder });
  } finally {
    await client.end();
    if (folder !== MIGRATIONS) rmSync(folder, { recursive: true, force: true });
  }
}

/** A temporary copy of the migrations folder whose journal ends at `tag`. */
function migrationsUpTo(tag: string): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((e) => e.tag === tag);
  if (last < 0) throw new Error(`no migration ${tag}`);
  const entries = journal.entries.slice(0, last + 1);
  const dir = mkdtempSync(join(tmpdir(), "cs-migrations-"));
  mkdirSync(join(dir, "meta"));
  for (const e of entries)
    copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

export interface TestDatabase {
  name: string;
  /** Superuser connection string to this database. */
  url: string;
  /** Drizzle client on `url`. Superuser: bypasses RLS until a transaction calls `asWorker`. */
  db: Db;
  /** Drops the database and closes every connection. */
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** Apply the migrations (default true). */
  migrate?: boolean;
}

/**
 * A fresh database with Neon's roles and (by default) every migration applied. Returns null when no
 * server is reachable and COUNTERSIGN_REQUIRE_DB is not 1.
 */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase | null> {
  if (!(await databaseAvailable())) return null;
  const name = `cs_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  const url = withDatabase(adminUrl(), name);
  try {
    await ensureNeonRoles(admin);
    await admin.unsafe(`CREATE DATABASE ${name} OWNER cs_owner`);
    // As scripts/setup-postgres.sh does: the superuser makes the extensions, the owner migrates.
    const inDb = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await inDb.unsafe(
        "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto",
      );
    } finally {
      await inDb.end();
    }
    if (options.migrate !== false) {
      await migrateAsOwner(url);
      await ensureWorker(admin, url);
    }
  } finally {
    await admin.end();
  }

  const db = createDb(url, { max: 3 });
  return {
    name,
    url,
    db,
    async drop() {
      await closeDb(db);
      const a = postgres(adminUrl(), { max: 1, onnotice: () => {} });
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}

/** Within a transaction, act as the Worker's role from here on (RLS and grants apply). */
export async function asWorker(tx: Tx): Promise<void> {
  await tx.execute(sql`set local role cs_worker`);
}
