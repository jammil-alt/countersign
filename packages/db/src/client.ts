// The database client and the client (tenant) every transaction acts for (CLAUDE.md invariant 1).
//
// Row-level security (migration 0002) shows a transaction the rows of the clients it names, read
// from transaction-local settings:
//   app.tenant_ids  `{uuid,…}`: the clients this transaction may see and write;
//   app.operator    `on` in back-office sessions: templates and shared skills (tenant_id null);
//   app.user_id     sign-in only: that user's own memberships.
// Each helper opens a transaction and sets them first with set_config(…, true), so they end at
// COMMIT and a pooled (Hyperdrive) connection hands nothing to the next request. There is no API for
// a session-level SET: it would leak exactly that way. Without them every tenant table reads as
// empty and refuses writes, so forgetting the scope fails closed.

import { isUuid } from "@countersign/core";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema> & { $client: postgres.Sql };
/** A transaction opened by one of the helpers below: the only handle that reads tenant data. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class ScopeError extends Error {
  override name = "ScopeError";
}

export interface CreateDbOptions {
  /** Pool size. A Worker request needs few: Hyperdrive does the pooling. */
  max?: number;
}

/**
 * A client over postgres-js. In the Worker the connection string is Hyperdrive's (as cs_worker);
 * scripts and tests pass their own. Close it with `closeDb(db)` (in a Worker, in `ctx.waitUntil`).
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    // Hyperdrive and Neon's pooler do not support the type-fetching round trip on connect.
    fetch_types: false,
    onnotice: () => {},
    // Long-lived holders (Workflows, cron) should not keep idle connections forever.
    idle_timeout: 10,
    max_lifetime: 5 * 60,
  });
  return drizzle({ client, schema }) as Db;
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}

function checkIds(ids: readonly string[]): string {
  for (const id of ids) if (!isUuid(id)) throw new ScopeError(`not a client id: ${id}`);
  return `{${[...new Set(ids)].join(",")}}`;
}

interface Scope {
  tenantIds: readonly string[];
  operator: boolean;
  userId?: string;
}

async function inScope<T>(db: Db, scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ids = checkIds(scope.tenantIds);
  if (scope.userId !== undefined && !isUuid(scope.userId)) {
    throw new ScopeError(`not a user id: ${scope.userId}`);
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.tenant_ids', ${ids}, true),
      set_config('app.operator', ${scope.operator ? "on" : "off"}, true),
      set_config('app.user_id', ${scope.userId ?? ""}, true)`);
    return fn(tx);
  });
}

/** One client: every run and every portal request. */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inScope(db, { tenantIds: [tenantId], operator: false }, fn);
}

/**
 * Several clients without the operator's templates: e.g. a job that sweeps a known set of clients.
 * Back-office requests use `withOperator`.
 */
export function withTenants<T>(
  db: Db,
  tenantIds: readonly string[],
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return inScope(db, { tenantIds, operator: false }, fn);
}

/**
 * A back-office session: the clients this operator serves (from `membership`, narrowed by
 * `?client=`), plus templates and shared skills (rows with tenant_id null).
 */
export function withOperator<T>(
  db: Db,
  tenantIds: readonly string[],
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return inScope(db, { tenantIds, operator: true }, fn);
}

/**
 * Inside any transaction (a client's request or run), reads the operator's catalogue (the browser
 * sites, tables only operator sessions may read) as an operator scope with no clients: for `fn`
 * only, `app.tenant_ids` is empty and `app.operator` on, so no client's rows are visible, only the
 * operator's own; both are put back afterwards. `fn` must only read.
 */
// DECISION: a portal request holds the database's one pooled connection in its transaction, so a
// second transaction (withOperator) would wait on itself; the scope switches inside it instead.
// Runs, which hold no transaction across a tool call, use withOperator(db, [], …) directly.
export async function readOperatorCatalogue<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const rows = await tx.execute<{ ids: string | null; op: string | null }>(sql`select
    current_setting('app.tenant_ids', true) as ids, current_setting('app.operator', true) as op`);
  const before = [...rows][0];
  await tx.execute(sql`select set_config('app.tenant_ids', '{}', true),
    set_config('app.operator', 'on', true)`);
  try {
    return await fn(tx);
  } finally {
    await tx
      .execute(sql`select set_config('app.tenant_ids', ${before?.ids ?? ""}, true),
        set_config('app.operator', ${before?.op ?? "off"}, true)`)
      .catch(() => undefined);
  }
}

/**
 * Sign-in: no client yet, only this user's own memberships are visible (policy `own_memberships`).
 * For packages/auth, to learn which clients a session may name.
 */
export function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inScope(db, { tenantIds: [], operator: false, userId }, fn);
}
