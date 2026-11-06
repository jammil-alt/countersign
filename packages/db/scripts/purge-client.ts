// Purges a retired client (docs/plan.md §1.35): `DIRECT_DATABASE_URL=… pnpm --filter
// @countersign/db run db:purge-client -- <client id>`, as cs_owner. Refuses before the client has
// been retired for 30 days, and before the Worker's hourly sweep has deleted its files. It can't be
// undone (Neon's point-in-time history keeps the rows until its window passes).
import { isUuid } from "@countersign/core";
import { closeDb, createDb } from "../src/client";
import { PurgeRefused, purgeClient } from "../src/purge";

const url = process.env.DIRECT_DATABASE_URL;
const tenantId = process.argv.slice(2).find((a) => a !== "--");
if (!url || !tenantId || !isUuid(tenantId)) {
  console.error("usage: DIRECT_DATABASE_URL=<cs_owner url> db:purge-client -- <client id>");
  process.exit(1);
}

const db = createDb(url, { max: 1 });
try {
  const report = await purgeClient(db, tenantId);
  for (const d of report.deleted) if (d.rows > 0) console.error(`  ${d.table}: ${d.rows}`);
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
