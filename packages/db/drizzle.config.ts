// drizzle-kit config: generates SQL migrations from the schema into ./migrations
// (`drizzle-kit generate`, and `drizzle-kit generate --custom --name=<name>` for hand-written SQL).
// Applying them is scripts/migrate.mjs (`db:migrate`), as cs_owner over DIRECT_DATABASE_URL.
// Generating needs no database.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // Platform tables, then each pack's (docs/plan.md §1.2 "Packs", §1.63), so every table lives in one
  // migration sequence. A path, not an import: the platform never imports a pack.
  schema: [
    "./src/schema.ts",
    "../../packs/materials/src/schema.ts",
    "../../packs/marketing/src/schema.ts",
  ],
  out: "./migrations",
  dbCredentials: { url: process.env.DIRECT_DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
