// Throwaway databases for tests (CLAUDE.md "Testing"): one per test file, migrated, with Neon's
// roles, dropped at the end. Node only; not exported from the Worker-safe index.
//
// Migrated databases are copies of a template (`CREATE DATABASE … TEMPLATE`): every migration is
// applied once, into `cs_template_<hash>`, and each test file gets its own copy of that. The hash
// covers the migrations and this setup, so a changed migration builds a new template; nothing a
// test does reaches the template (it takes no connections). Databases made with `migrate: false`
// are built from nothing, as before.
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
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { closeDb, createDb, type Db, type Tx } from "./client";

const DEFAULT_ADMIN_URL = "postgresql://postgres:postgres@localhost:5432/postgres";
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const PROVISION = fileURLToPath(new URL("../scripts/provision-worker-role.mjs", import.meta.url));

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

/**
 * Bumped when the template's set-up changes in a way the hashed files don't show (extensions, roles,
 * the order of steps), so an old template is not reused. The hash does not cover the versions of
 * the extensions on the server (pgvector, pg_trgm, pgcrypto) or of drizzle-orm's migrator: a
 * local server or drizzle upgrade keeps the old template until this is bumped or the template is
 * dropped by hand (`DROP DATABASE` after `ALTER DATABASE … IS_TEMPLATE false`). CI always builds
 * a fresh one.
 */
const TEMPLATE_SETUP = 1;

/** A template not built for this long is another checkout's old one, and is dropped. */
const TEMPLATE_KEEP_DAYS = 7;

/** What the template is built from: every migration file, the role script and the set-up version. */
function templateHash(): string {
  const hash = createHash("sha256").update(`setup ${TEMPLATE_SETUP}\n`);
  const files = [
    join(MIGRATIONS, "meta", "_journal.json"),
    ...readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(MIGRATIONS, f)),
    PROVISION,
  ];
  for (const file of files) hash.update(`${basename(file)}\n`).update(readFileSync(file));
  return hash.digest("hex").slice(0, 16);
}

const TEMPLATE_PREFIX = "cs_template_";

/**
 * A database name as a quoted SQL identifier, for the DDL below (CREATE, ALTER, DROP and COMMENT ON
 * DATABASE take no bind parameters). Only the names this file makes are accepted, so nothing else
 * can reach that SQL: `cs_test_<random hex>` and `cs_template_<hash>`, with lowercase letters,
 * digits and underscores.
 */
function dbIdent(name: string): string {
  if (!/^cs_(test|template)_[a-z0-9_]{1,40}$/.test(name)) {
    throw new Error(`not a test database name: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/** An SQL string literal, quotes doubled. */
function sqlLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** An empty database with the extensions, made the way scripts/setup-postgres.sh makes it. */
async function createBareDatabase(admin: postgres.Sql, name: string, url: string): Promise<void> {
  await admin.unsafe(`CREATE DATABASE ${dbIdent(name)} OWNER cs_owner`);
  // As scripts/setup-postgres.sh does: the superuser makes the extensions, the owner migrates.
  const inDb = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await inDb.unsafe(
      "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto",
    );
  } finally {
    await inDb.end();
  }
}

let template: Promise<string> | undefined;

/**
 * The migrated template's name, building it first if no test process has yet. Test files run in
 * separate processes (and packages in separate vitest runs), so the build is serialized by an
 * advisory lock on the server, not in memory. A template is only renamed to its final name once
 * it is complete, so a run killed halfway leaves nothing that a later run would trust.
 */
function migratedTemplate(admin: postgres.Sql): Promise<string> {
  template ??= (async () => {
    const name = `${TEMPLATE_PREFIX}${templateHash()}`;
    const exists = async (on: postgres.Sql | postgres.TransactionSql) =>
      (await on`select 1 from pg_database where datname = ${name}`).length > 0;
    if (await exists(admin)) return name;
    await admin.begin(async (tx) => {
      // DECISION: a transaction-scoped advisory lock (docs/audit-plan.md 9.5). CREATE DATABASE
      // can't run inside a transaction, so the build runs on its own connection while this one
      // holds the lock; the lock goes with the transaction, even if the build throws.
      await tx`select pg_advisory_xact_lock(hashtext('countersign:test-template'))`;
      if (await exists(tx)) return;
      const lockedOut = postgres(adminUrl(), { max: 1, onnotice: () => {} });
      try {
        await buildTemplate(lockedOut, name);
      } finally {
        await lockedOut.end();
      }
    });
    return name;
  })();
  // A failed build is not cached: the next file tries again and reports its own error.
  template.catch(() => {
    template = undefined;
  });
  return template;
}

async function buildTemplate(admin: postgres.Sql, name: string): Promise<void> {
  const building = `${name}_building`;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbIdent(building)} WITH (FORCE)`);
  const url = withDatabase(adminUrl(), building);
  await createBareDatabase(admin, building, url);
  await migrateAsOwner(url);
  await ensureWorker(admin, url);
  // Complete: take connections away so nothing changes it after this, then give it its name. The
  // comment records when it was built, for the clean-up below.
  await admin.unsafe(
    `ALTER DATABASE ${dbIdent(building)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`,
  );
  await admin.unsafe(`ALTER DATABASE ${dbIdent(building)} RENAME TO ${dbIdent(name)}`);
  await admin.unsafe(
    `COMMENT ON DATABASE ${dbIdent(name)} IS ${sqlLiteral(`built ${new Date().toISOString()}`)}`,
  );
  await dropOldTemplates(admin, name);
}

/**
 * Drops the templates of other migrations built more than TEMPLATE_KEEP_DAYS ago. Several local
 * checkouts can share one server, each with its own template, so a newer one is kept: dropping it
 * would only make that checkout build it again. A template dropped under a running test process
 * is rebuilt by `createTestDatabase`; one being copied right now makes the drop wait.
 */
async function dropOldTemplates(admin: postgres.Sql, current: string): Promise<void> {
  const rows = await admin<{ datname: string; note: string | null }[]>`
    select datname, shobj_description(oid, 'pg_database') as note from pg_database
    where datistemplate and starts_with(datname, ${TEMPLATE_PREFIX}) and datname <> ${current}
      and right(datname, 9) <> '_building'`;
  const cutoff = Date.now() - TEMPLATE_KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const { datname, note } of rows) {
    const built = Date.parse(note?.match(/^built (\S+)$/)?.[1] ?? "");
    if (built > cutoff) continue;
    try {
      await admin.unsafe(`ALTER DATABASE ${dbIdent(datname)} WITH IS_TEMPLATE false`);
      await admin.unsafe(`DROP DATABASE ${dbIdent(datname)}`);
    } catch {
      // Gone already, or locked by another run; the next build tries again.
    }
  }
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
    if (options.migrate === false) {
      await createBareDatabase(admin, name, url);
    } else {
      try {
        await admin.unsafe(
          `CREATE DATABASE ${dbIdent(name)} TEMPLATE ${dbIdent(await migratedTemplate(admin))} OWNER cs_owner`,
        );
      } catch (error) {
        // Another checkout's clean-up dropped the template this process had found: build it again.
        if ((error as { code?: string }).code !== "3D000") throw error;
        template = undefined;
        await admin.unsafe(
          `CREATE DATABASE ${dbIdent(name)} TEMPLATE ${dbIdent(await migratedTemplate(admin))} OWNER cs_owner`,
        );
      }
      // The role is cluster-wide: a template from an earlier run still needs today's cs_worker.
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
        await a.unsafe(`DROP DATABASE IF EXISTS ${dbIdent(name)} WITH (FORCE)`);
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
