// Seeds DIRECT_DATABASE_URL (`pnpm --filter @countersign/db run db:seed`): the operator, the
// Sandbox and Demo clients, and the platform templates. Safe to run again: it changes nothing twice.
// SEED_E2E=1 also seeds the end-to-end Desk item (src/seed.ts `seedDemoDesk`): local runs and CI's
// sweep only, never staging.
// SEED_DEMO=1 also seeds the demo client, Harbor Millwork (src/seed-demo.ts): weeks of sample runs,
// changes, documents and usage, for looking at the portal and the back office.
// DECISION: the demo seed is for local runs, and for a staging demo only when the owner chooses to
// run it there; never on by default, never on production.
import { closeDb, createDb } from "../src/client";
import { seed } from "../src/seed";
import { seedDemo } from "../src/seed-demo";

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error("db:seed: DIRECT_DATABASE_URL is required (the cs_owner connection string)");
  process.exit(1);
}

const e2e = process.env.SEED_E2E === "1";
const demo = process.env.SEED_DEMO === "1";
const db = createDb(url, { max: 1 });
try {
  const result = await seed(db, { e2e });
  console.error(
    `db:seed: clients ${Object.values(result.tenants).length}, ` +
      `templates ${Object.keys(result.templates).sort().join(", ")}` +
      (result.demoDesk ? ", the e2e Desk item" : ""),
  );
  if (demo) {
    const d = await seedDemo(db, { operatorId: result.users.operator });
    const c = d.counts;
    console.error(
      `db:seed: demo client Harbor Millwork: ${c.runs} runs, ${c.stepRuns} steps, ` +
        `${c.externalActions} changes, ${c.inboxItems} inbox items, ${c.documents} documents, ` +
        `${c.transactions} transactions, ${c.contacts} contacts, ${c.usageDays} days of usage`,
    );
  }
} catch (error) {
  console.error("db:seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
