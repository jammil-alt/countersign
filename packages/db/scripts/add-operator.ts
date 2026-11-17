// Invites an operator into DIRECT_DATABASE_URL (`pnpm --filter @countersign/db run db:add-operator
// <email> [name]`): an app_user row the first WorkOS sign-in with that verified email claims, and an
// operator membership in every client (an environment with none gets its first, Mezonas). Safe to
// run again. Used by the "Add operator" workflow.
import { closeDb, createDb } from "../src/client";
import { addOperator } from "../src/operators";

const url = process.env.DIRECT_DATABASE_URL;
const [email, ...nameParts] = process.argv.slice(2);
if (!url || !email) {
  console.error("usage: DIRECT_DATABASE_URL=… db:add-operator <email> [name]");
  process.exit(1);
}

// Who ran it, for the `operator.add` audit row: BY when set, else the GitHub Actions run (its
// actor and run id, which Actions always sets), else nobody named.
const by =
  process.env.BY ||
  (process.env.GITHUB_ACTOR
    ? `${process.env.GITHUB_ACTOR}, run ${process.env.GITHUB_RUN_ID ?? "?"}`
    : null);

const db = createDb(url, { max: 1 });
try {
  const r = await addOperator(db, { email, name: nameParts.join(" ") || null, by });
  console.error(
    `db:add-operator: ${r.created ? "invited" : "already present"}; operator of ${r.clients} client(s)` +
      (r.createdClient ? `; created the first client, ${r.createdClient}` : ""),
  );
} catch (error) {
  console.error("db:add-operator failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
