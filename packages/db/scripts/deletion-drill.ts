// The deletion drill (docs/plan.md §1.218, src/deletion-drill.ts): a throwaway Sandbox client is
// filled, retired and purged, and the drill checks nothing of it is left. Its result goes to the
// audit log, where the SOC 2 readiness view (/ops/security/soc2) reads it. On staging or locally,
// as cs_owner, after the seed (it needs the platform templates); never on production:
// `DIRECT_DATABASE_URL=… pnpm --filter @countersign/db run db:deletion-drill`.
import { closeDb, createDb } from "../src/client";
import { runDeletionDrill } from "../src/deletion-drill";

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error("usage: DIRECT_DATABASE_URL=<cs_owner url> db:deletion-drill");
  process.exit(1);
}

const db = createDb(url, { max: 1 });
try {
  const report = await runDeletionDrill(db);
  if (report.ok) {
    console.error(
      `db:deletion-drill: passed. ${report.rows} rows in ${report.tables} tables and ` +
        `${report.usersDeleted} people purged; nothing left.`,
    );
  } else {
    console.error("db:deletion-drill: failed.");
    for (const f of report.failed) console.error(`  ${f}`);
    if (report.tenantId) console.error(`  The drill client was ${report.tenantId}.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
