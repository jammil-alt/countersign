// Removes an operator from DIRECT_DATABASE_URL (`pnpm --filter @countersign/db run
// db:remove-operator <email> [by]`): every operator membership, so they lose the back office and
// the Ops MCP connector at once; one audit row. Refuses the last operator. Used by the "Remove
// operator" workflow.
import { closeDb, createDb } from "../src/client";
import { removeOperator } from "../src/operators";

const url = process.env.DIRECT_DATABASE_URL;
const [email, by] = process.argv.slice(2);
if (!url || !email) {
  console.error("usage: DIRECT_DATABASE_URL=… db:remove-operator <email> [by]");
  process.exit(1);
}

const db = createDb(url, { max: 1 });
try {
  const r = await removeOperator(db, { email, by: by || null });
  console.error(`db:remove-operator: removed from ${r.clients} client(s)`);
} catch (error) {
  console.error("db:remove-operator failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
