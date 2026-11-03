// Applies packages/db/migrations to DIRECT_DATABASE_URL, as cs_owner (`pnpm --filter
// @countersign/db run db:migrate`). Called by scripts/setup-postgres.sh, checks.yml and deploy.yml.
// Plain JavaScript on purpose: CI and deploys run it with nothing but Node and the installed deps.
//
// The runtime never migrates: the Worker's role (cs_worker) owns nothing and could not.

import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error("db:migrate: DIRECT_DATABASE_URL is required (the cs_owner connection string)");
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
// One connection, so the advisory lock and the migration share a session.
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  // Two deploys racing would both read the journal as pending; the second waits, then finds nothing.
  await sql`select pg_advisory_lock(hashtext('countersign:migrate'))`;
  await migrate(drizzle({ client: sql }), { migrationsFolder });
  const [row] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
  console.error(`db:migrate: ${row?.n ?? 0} migrations applied in total`);
} catch (error) {
  console.error("db:migrate failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
