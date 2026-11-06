// Seeds DIRECT_DATABASE_URL (`pnpm --filter @countersign/db run db:seed`): the operator, the
// Sandbox and Demo clients, and the platform templates. Safe to run again: it changes nothing twice.
// SEED_E2E=1 also seeds the end-to-end Desk item (src/seed.ts `seedDemoDesk`): local runs and CI's
// sweep only, never staging.
import { closeDb, createDb } from "../src/client";
import { seed } from "../src/seed";

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error("db:seed: DIRECT_DATABASE_URL is required (the cs_owner connection string)");
  process.exit(1);
}

const e2e = process.env.SEED_E2E === "1";
const db = createDb(url, { max: 1 });
try {
  const result = await seed(db, { e2e });
  console.error(
    `db:seed: clients ${Object.values(result.tenants).length}, ` +
      `templates ${Object.keys(result.templates).sort().join(", ")}` +
      (result.demoDesk ? ", the e2e Desk item" : ""),
  );
} catch (error) {
  console.error("db:seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
