// Purges a retired client (docs/plan.md §1.35). Run from Actions → Purge client
// (.github/workflows/purge-client.yml), which waits for the production environment's approval and
// gets cs_owner's connection inside the job. By hand only as break-glass (docs/operations.md,
// "Break-glass database access"): `DIRECT_DATABASE_URL=… pnpm --filter @countersign/db run
// db:purge-client -- <client id> "<client name>"`, as cs_owner. Refuses when the name typed isn't
// the client's, before the client has been retired for 30 days, and before the Worker's hourly
// sweep has deleted its files. It can't be undone (Neon's point-in-time history keeps the rows
// until its window passes).
import { isUuid } from "@countersign/core";
import { closeDb, createDb } from "../src/client";
import { PurgeRefused, purgeClient } from "../src/purge";

const url = process.env.DIRECT_DATABASE_URL;
const [tenantId, confirmName] = process.argv.slice(2).filter((a) => a !== "--");
if (!url || !tenantId || !isUuid(tenantId) || !confirmName?.trim()) {
  console.error(
    'usage: DIRECT_DATABASE_URL=<cs_owner url> db:purge-client -- <client id> "<client name>"',
  );
  process.exit(1);
}

const db = createDb(url, { max: 1 });
try {
  const report = await purgeClient(db, tenantId, { confirmName });
  for (const d of report.deleted) if (d.rows > 0) console.error(`  ${d.table}: ${d.rows}`);
  for (const c of report.cleared) {
    if (c.rows > 0) console.error(`  ${c.table}.${c.column} cleared: ${c.rows}`);
  }
  console.error(
    `db:purge-client: ${report.name} (${report.tenantId}) purged; ${report.usersDeleted} users removed`,
  );
} catch (error) {
  console.error(
    error instanceof PurgeRefused ? `db:purge-client refused: ${error.message}` : error,
  );
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
