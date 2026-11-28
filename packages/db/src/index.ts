// @countersign/db: Drizzle schema, migrations, seed, tenant-scoped transactions.
// Allowed workspace dependencies: core. See docs/plan.md §2.
//
// This entry point is Worker-safe (postgres-js + Drizzle only). Node-only parts are imported by path
// from scripts and tests: ./seed (reads the seed files) and ./testing (throwaway databases).

export {
  admitTenant,
  CLIENT_LOCKED_SQLSTATE,
  ClientLockedError,
  type CreateDbOptions,
  closeDb,
  createDb,
  type Db,
  isClientLocked,
  narrowToTenant,
  readOperatorCatalogue,
  type Schema,
  ScopeError,
  type SessionDecision,
  type SessionScope,
  type Tx,
  withInvestigation,
  withOperator,
  withSession,
  withTenant,
  withTenants,
  withUser,
} from "./client";
export * from "./directory";
// A connection that went away under a query (Neon restarting, Hyperdrive moving it).
export { isDatabaseDrop } from "./drops";
export * from "./ledger";
// §1.243: lockdown of one client or of every client.
export * from "./lockdown";
// §1.215: a client's saved match rules (the matching engine's first tier).
export * from "./match-rules";
export {
  accountIn,
  membershipsOfUser,
  type UserMembership,
  userMemberships,
  userWithMemberships,
} from "./queries";
// Step model §10f: a record type's store over one table.
export * from "./records";
export * from "./schema";
// R9: seeded version files that name an earlier version (the seed and the install route).
export { isSeedVersionPatch, type SeedVersionPatch, seedVersionBundle } from "./seed-files";
// §1.234: the work statement's counters, counted once for every surface.
export * from "./work-counts";
