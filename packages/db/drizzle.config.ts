// drizzle-kit config: generates SQL migrations from the schema into ./migrations
// (`drizzle-kit generate`, and `drizzle-kit generate --custom --name=<name>` for hand-written SQL).
// Applying them is scripts/migrate.mjs (`db:migrate`), as cs_owner over DIRECT_DATABASE_URL.
// Generating needs no database.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // Platform tables. Pack schemas join this list when packs gain tables (docs/plan.md §1.2 "Packs"),
  // so every table lives in one migration sequence.
  schema: ["./src/schema.ts"],
  out: "./migrations",
  dbCredentials: { url: process.env.DIRECT_DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
