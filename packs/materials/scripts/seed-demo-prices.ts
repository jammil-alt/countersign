// `pnpm seed:demo-prices`: six months of demo prices for the seeded demo client (docs/plan.md M8),
// over DIRECT_DATABASE_URL, after `db:seed`. Safe to run again: it adds nothing twice. Demo data
// only: never point it at a real client's database.
import { uuidv5 } from "@countersign/core";
import { closeDb, createDb, tenant } from "@countersign/db";
import { SEED_NAMESPACE } from "@countersign/db/seed";
import { eq } from "drizzle-orm";
import { seedDemoPrices } from "../src/demo";

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error(
    "seed:demo-prices: DIRECT_DATABASE_URL is required (the cs_owner connection string)",
  );
  process.exit(1);
}

const db = createDb(url, { max: 1 });
try {
  const tenantId = await uuidv5("tenant:demo", SEED_NAMESPACE);
  const [demo] = await db.select({ id: tenant.id }).from(tenant).where(eq(tenant.id, tenantId));
  if (!demo) throw new Error("the demo client isn't there: run db:seed first");
  const r = await seedDemoPrices(db, tenantId);
  console.error(
    `seed:demo-prices: ${r.vendors} vendors, ${r.items} items, ${r.observations} prices, ${r.alerts} alerts`,
  );
} catch (error) {
  console.error("seed:demo-prices failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
