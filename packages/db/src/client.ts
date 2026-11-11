// The database client and the client (tenant) every transaction acts for (CLAUDE.md invariant 1).
//
// Row-level security (migration 0002) shows a transaction the rows of the clients it names, read
// from transaction-local settings:
//   app.tenant_ids  `{uuid,…}`: the clients this transaction may see and write;
//   app.operator    `on` in back-office sessions: templates and shared skills (tenant_id null);
//   app.user_id     sign-in only: that user's own memberships.
// A session request reads its user and memberships and then runs its handler in one transaction
// (`withSession`): `app.user_id` first, then the clients in place of it before the handler starts.
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
  return drizzle({ client: withUnknownParams(client), schema }) as Db;
}

/** Postgres' `unknown` type: the server decides a parameter's type from the query, as for none. */
const UNKNOWN_OID = 705;

/** A value whose text form postgres-js writes the same whatever type the server reads it as. */
function plainText(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Uint8Array) return false;
  if (Array.isArray(value)) {
    return value.every((v) => v === null || typeof v === "string" || typeof v === "number");
  }
  return typeof value !== "function";
}

/**
 * The client drizzle uses, with every parameter sent as `unknown` instead of untyped.
 *
 * postgres-js describes a query whose parameters have no type before it runs it, on each
 * connection, and waits for the answer: a second round trip for nearly every query, since a Worker
 * opens a new connection per request. A parameter typed `unknown` is read by the server exactly as
 * one with no type (it takes its type from where it is used), but postgres-js sends the query in
 * one go, and queries issued together go together.
 */
// DECISION: twice fewer round trips per query (docs/plan.md §1.83). Only values whose text is the
// same for any type are retyped (strings, numbers, booleans, dates, plain objects as JSON, arrays of
// strings and numbers); bytes and anything else keep today's describe-first path.
function withUnknownParams(
  client: postgres.Sql,
  asUnknown: (v: unknown) => unknown = (v) => client.typed(v as never, UNKNOWN_OID),
): postgres.Sql {
  const typed = (params: unknown) =>
    Array.isArray(params) ? params.map((v) => (plainText(v) ? asUnknown(v) : v)) : params;
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "unsafe") {
        return (query: string, params?: unknown, opts?: unknown) =>
          (target.unsafe as (...a: unknown[]) => unknown)(query, typed(params), opts);
      }
      if (prop === "begin" || prop === "savepoint") {
        return (...args: unknown[]) => {
          const fn = args.pop() as (tx: postgres.Sql) => unknown;
          const method = Reflect.get(target, prop) as (...a: unknown[]) => unknown;
          return method.call(target, ...args, (tx: postgres.Sql) =>
            fn(withUnknownParams(tx, asUnknown)),
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
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
    // The scope is sent first, then `fn` starts at once: its first queries travel with the scope
    // instead of a round trip later.
    // DECISION: one round trip less per transaction (docs/plan.md §1.82). The transaction holds one
    // connection, and postgres-js runs a connection's statements in the order they were issued;
    // `.then` here issues the scope before `fn` can issue anything, so every statement of `fn`
    // still runs scoped. If the scope fails, the transaction is aborted and `fn`'s statements fail
    // with it: closed, as before.
    const scoped = tx
      .execute(sql`select
        set_config('app.tenant_ids', ${ids}, true),
        set_config('app.operator', ${scope.operator ? "on" : "off"}, true),
        set_config('app.user_id', ${scope.userId ?? ""}, true)`)
      .then(() => undefined);
    // An async wrapper, so a `fn` that throws before its first await rejects instead.
    const [, out] = await Promise.all([scoped, (async () => fn(tx))()]);
    return out;
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
 * Inside a back-office transaction (withOperator, over the clients served), runs `fn` with
 * withTenant's scope: this one client, operator off, so RLS shows `fn` only that client's rows and
 * no templates. The client must already be in the transaction's scope (ScopeError otherwise): this
 * only narrows. The scope is put back afterwards.
 */
// DECISION: a back-office request holds the database's one pooled connection in its transaction,
// as a portal request does (readOperatorCatalogue), so a route that must see exactly one client
// narrows the scope inside it instead of opening withTenant beside it.
export async function narrowToTenant<T>(
  tx: Tx,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const one = checkIds([tenantId]);
  const rows = await tx.execute<{ ids: string | null; op: string | null }>(sql`select
    current_setting('app.tenant_ids', true) as ids, current_setting('app.operator', true) as op`);
  const before = [...rows][0];
  const current = (before?.ids ?? "").replace(/^\{|\}$/g, "").split(",");
  if (!current.includes(tenantId)) {
    throw new ScopeError(`client ${tenantId} is outside this transaction's clients`);
  }
  await tx.execute(sql`select set_config('app.tenant_ids', ${one}, true),
    set_config('app.operator', 'off', true)`);
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

/** The clients a session request may touch, once its user and memberships have been read. */
export interface SessionScope {
  readonly tenantIds: readonly string[];
  /** `app.operator`: the back office (templates and shared skills too). */
  readonly operator: boolean;
}

/** What `withSession`'s sign-in half decides: a scope (and what it learnt), or a refusal. */
export type SessionDecision<D, R> =
  | { readonly ok: true; readonly scope: SessionScope; readonly value: D }
  | { readonly ok: false; readonly refusal: R };

/**
 * One session request in one transaction (docs/plan.md §1.90). First as `withUser`: only
 * `app.user_id` is set, so `decide` sees this user's own memberships and no client's rows, and
 * works out the scope. Then, in the same transaction and before `fn` issues anything,
 * `app.tenant_ids` and `app.operator` are set to that scope and `app.user_id` is cleared: `fn`
 * runs exactly as it would inside `withOperator` or `withTenants`, never with the user's id set.
 *
 * A refusal from `decide` ends the transaction (it wrote nothing) and comes back as
 * `{ ok: false }`; `fn` never runs. A throw anywhere rolls the whole transaction back. A scope
 * without `operator` must name exactly one client (ScopeError otherwise), as `withTenant` does.
 */
// DECISION: one transaction instead of `withUser` then `withOperator`/`withTenant` (two `begin`s
// and two `commit`s per request). The scope switch is issued before `fn` can issue a statement,
// as `inScope` issues the scope: postgres-js runs a connection's statements in order, so every
// statement of `fn` runs with the clients set and the user cleared; a failed switch aborts the
// transaction and `fn`'s statements fail with it.
export async function withSession<D, R, T>(
  db: Db,
  userId: string,
  decide: (tx: Tx) => Promise<SessionDecision<D, R>>,
  fn: (tx: Tx, value: D) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: R }> {
  if (!isUuid(userId)) throw new ScopeError(`not a user id: ${userId}`);
  return db.transaction(async (tx) => {
    const signIn = tx
      .execute(sql`select
        set_config('app.tenant_ids', '{}', true),
        set_config('app.operator', 'off', true),
        set_config('app.user_id', ${userId}, true)`)
      .then(() => undefined);
    const [, decided] = await Promise.all([signIn, (async () => decide(tx))()]);
    if (!decided.ok) return { ok: false as const, refusal: decided.refusal };
    // A session that is not the back office acts for exactly one client (invariant 1), whatever
    // the caller checked before.
    if (!decided.scope.operator && new Set(decided.scope.tenantIds).size !== 1) {
      throw new ScopeError("a client session acts for exactly one client");
    }
    const ids = checkIds(decided.scope.tenantIds);
    const scoped = tx
      .execute(sql`select
        set_config('app.tenant_ids', ${ids}, true),
        set_config('app.operator', ${decided.scope.operator ? "on" : "off"}, true),
        set_config('app.user_id', '', true)`)
      .then(() => undefined);
    const [, out] = await Promise.all([scoped, (async () => fn(tx, decided.value))()]);
    return { ok: true as const, value: out };
  });
}
