// Removes an operator from DIRECT_DATABASE_URL (`pnpm --filter @countersign/db run
// db:remove-operator <email> [by]`): every operator membership, so the back office refuses them
// within 5 minutes (an open session carries memberships for up to 5 minutes) and the Ops MCP
// connector at once; their open items by name go to any operator, and a client they led has no
// lead. One audit row. Refuses the last operator.
import { closeDb, createDb } from "../src/client";
import { removeOperator } from "../src/operators";

const url = process.env.DIRECT_DATABASE_URL;
const [email, ...byParts] = process.argv.slice(2).filter((a) => a !== "--");
if (!url || !email) {
  console.error("usage: DIRECT_DATABASE_URL=… db:remove-operator <email> [by]");
  process.exit(1);
}

const db = createDb(url, { max: 1 });
try {
  const r = await removeOperator(db, { email, by: byParts.join(" ") || null });
  console.error(
    `db:remove-operator: removed from ${r.clients} client(s); ${r.reassigned} open item(s) to the operators; lead of ${r.leads} client(s) cleared`,
  );
} catch (error) {
  console.error("db:remove-operator failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
