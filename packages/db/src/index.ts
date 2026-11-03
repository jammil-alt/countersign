// @countersign/db: Drizzle schema, migrations, seed, tenant-scoped transactions.
// Allowed workspace dependencies: core. See docs/plan.md §2.
//
// This entry point is Worker-safe (postgres-js + Drizzle only). Node-only parts are imported by path
// from scripts and tests: ./seed (reads the seed files) and ./testing (throwaway databases).

export {
  type CreateDbOptions,
  closeDb,
  createDb,
  type Db,
  type Schema,
  ScopeError,
  type Tx,
  withOperator,
  withTenant,
  withTenants,
  withUser,
} from "./client";
export { type UserMembership, userMemberships } from "./queries";
export * from "./schema";
