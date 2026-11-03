// Creates (or re-keys) cs_worker, the login role the Worker, its Workflows and its cron connect as.
// Pattern from Plenary Labs. Used by scripts/setup-postgres.sh (local, CI) and, with the same SQL,
// by .github/workflows/bootstrap.yml on each Neon branch.
//
//   OWNER_URL=postgres://cs_owner:…@host/countersign WORKER_PASSWORD=… node provision-worker-role.mjs
//
// Secrets come through the environment, never the command line. Prints the cs_worker connection URL
// on stdout for the caller to capture, and nothing else there.
//
// Made with SQL, never the Neon API: Neon-managed roles join neon_superuser and would skip row-level
// security (docs/plan.md §1.2). cs_worker is a member of cs_runtime only and holds nothing itself.

import postgres from "postgres";

const { OWNER_URL, WORKER_PASSWORD } = process.env;
if (!OWNER_URL || !WORKER_PASSWORD || WORKER_PASSWORD.length < 8) {
  console.error("provision-worker-role: OWNER_URL and WORKER_PASSWORD (8+ chars) are required");
  process.exit(1);
}

const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
try {
  await sql.begin(async (tx) => {
    // CREATE/ALTER ROLE take no bind parameters, so Postgres quotes the password itself (%L).
    const [create] =
      await tx`select format('CREATE ROLE cs_worker WITH LOGIN PASSWORD %L', ${WORKER_PASSWORD}::text) as stmt`;
    const [alter] =
      await tx`select format('ALTER ROLE cs_worker WITH LOGIN PASSWORD %L', ${WORKER_PASSWORD}::text) as stmt`;
    await tx.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cs_runtime') THEN
          CREATE ROLE cs_runtime NOLOGIN;
        END IF;
      END
      $$`);
    const [exists] = await tx`select 1 as one from pg_roles where rolname = 'cs_worker'`;
    // Postgres defaults: NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT. Neon's owner role
    // may not set these explicitly; the checks below and packages/db's tests verify them instead.
    await tx.unsafe(exists ? alter.stmt : create.stmt);
    await tx.unsafe("GRANT cs_runtime TO cs_worker");

    // Refuse to hand out a login that could see past row-level security. (Postgres 16 keeps one
    // membership row per grantor, hence distinct.)
    const [worker] = await tx`
      select r.rolsuper, r.rolbypassrls,
        coalesce(array_agg(distinct g.rolname) filter (where g.rolname is not null), '{}') as member_of
      from pg_roles r
      left join pg_auth_members m on m.member = r.oid
      left join pg_roles g on g.oid = m.roleid
      where r.rolname = 'cs_worker'
      group by r.rolsuper, r.rolbypassrls`;
    const memberOf = worker.member_of;
    if (
      worker.rolsuper ||
      worker.rolbypassrls ||
      memberOf.length !== 1 ||
      memberOf[0] !== "cs_runtime"
    ) {
      throw new Error(
        `cs_worker must be a plain member of cs_runtime only (superuser=${worker.rolsuper}, ` +
          `bypassrls=${worker.rolbypassrls}, member of ${memberOf.join(", ") || "nothing"})`,
      );
    }
  });
} catch (error) {
  console.error("provision-worker-role failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}

if (!process.exitCode) {
  const url = new URL(OWNER_URL);
  url.username = "cs_worker";
  url.password = WORKER_PASSWORD;
  process.stdout.write(url.toString());
}
