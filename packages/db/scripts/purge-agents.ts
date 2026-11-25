// The one-off agent purge (docs/step-model-plan.md §12, R0). Every agent, version, run, build,
// skill and automation goes, the platform's own included; the client's records stay with their
// links to them cleared. Run by hand as cs_owner, once per environment, when the new step model
// ships; then `db:seed` brings the platform's agents back in the new model.
//
//   DIRECT_DATABASE_URL=<cs_owner url> pnpm --filter @countersign/db run db:purge-agents -- <database name> --dry-run
//   DIRECT_DATABASE_URL=<cs_owner url> pnpm --filter @countersign/db run db:purge-agents -- <database name>
//
// The database's name is typed again so a command meant for staging can't run on production. A dry
// run does everything, prints it, and rolls it back. It can't be undone (Neon's point-in-time
// history keeps the rows until its window passes).
import { closeDb, createDb } from "../src/client";
import { PurgeRefused } from "../src/purge";
import { purgeAgents } from "../src/purge-agents";

const url = process.env.DIRECT_DATABASE_URL;
const args = process.argv.slice(2).filter((a) => a !== "--");
const dryRun = args.includes("--dry-run");
const [confirmDatabase] = args.filter((a) => a !== "--dry-run");
if (!url || !confirmDatabase?.trim()) {
  console.error(
    "usage: DIRECT_DATABASE_URL=<cs_owner url> db:purge-agents -- <database name> [--dry-run]",
  );
  process.exit(1);
}

const db = createDb(url, { max: 1 });
try {
  const report = await purgeAgents(db, { confirmDatabase, dryRun });
  for (const d of report.deleted) if (d.rows > 0) console.error(`  ${d.table}: ${d.rows}`);
  for (const c of report.cleared) {
    if (c.rows > 0) console.error(`  ${c.table}.${c.column} cleared: ${c.rows}`);
  }
  const total = report.deleted.reduce((n, d) => n + d.rows, 0);
  console.error(
    report.dryRun
      ? `db:purge-agents (dry run, nothing changed): ${total} rows would go from ${report.database}`
      : `db:purge-agents: ${total} rows purged from ${report.database}; run db:seed next`,
  );
} catch (error) {
  console.error(
    error instanceof PurgeRefused ? `db:purge-agents refused: ${error.message}` : error,
  );
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
