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
  narrowToTenant,
  readOperatorCatalogue,
  type Schema,
  ScopeError,
  type SessionDecision,
  type SessionScope,
  type Tx,
  withOperator,
  withSession,
  withTenant,
  withTenants,
  withUser,
} from "./client";
export * from "./directory";
export * from "./ledger";
export {
  accountIn,
  membershipsOfUser,
  type UserMembership,
  userMemberships,
  userWithMemberships,
} from "./queries";
export * from "./schema";
// R9: seeded version files that name an earlier version (the seed and the install route).
export { isSeedVersionPatch, type SeedVersionPatch, seedVersionBundle } from "./seed-files";
