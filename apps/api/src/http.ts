// The request plumbing every route goes through (docs/plan.md §1.2 "Role checks"): one database
// client per request, the session from packages/auth, the route's roles from the contract, the
// client scope (`app.tenant_ids`, `app.operator`) set on the transaction the handler runs in, Zod
// on the way in and on the way out, and work that must wait for the commit.

import { AgentsError } from "@countersign/agents";
import {
  type AuthRefusal,
  getSession,
  requireRole,
  type Session,
  tenantScope,
} from "@countersign/auth";
import { type Role, type RouteSpec, routeFamily } from "@countersign/core";
import {
  closeDb,
  createDb,
  type Db,
  ScopeError,
  type Tx,
  withOperator,
  withTenant,
} from "@countersign/db";
import { captureException } from "@sentry/cloudflare";
import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { type AdapterChoice, authDirectory, chooseAdapter } from "./auth";
import type { Bindings } from "./env";
import { type Platform, platformFor } from "./platform";
import { type RunInstances, workflowInstances } from "./runs/instances";

// ── Dependencies and per-request state ───────────────────────────────────────────────────────────

/** What the app is built from; tests replace any of them. */
export interface AppDeps {
  platform(env: Bindings): Platform;
  /** A database client for one request (or one job), and how to close it. */
  openDb(env: Bindings): { db: Db; close(): Promise<void> };
  instances(env: Bindings): RunInstances;
}

export const defaultDeps: AppDeps = {
  platform: (env) => platformFor(env),
  openDb(env) {
    // Hyperdrive pools the connections; one per request is all a handler needs.
    const db = createDb(env.HYPERDRIVE.connectionString, { max: 1 });
    return { db, close: () => closeDb(db) };
  },
  instances: (env) => workflowInstances(env.RUN_WORKFLOW),
};

export interface Services {
  env: Bindings;
  db: Db;
  platform: Platform;
  instances: RunInstances;
  deps: AppDeps;
  auth(): AdapterChoice;
}

interface RequestState {
  services(): Services;
  /** Work to do after the response: dispatching events, then closing the client. */
  deferred: (() => Promise<unknown>)[];
}

export type AppEnv = { Bindings: Bindings; Variables: { req: RequestState } };
export type AppContext = Context<AppEnv>;

/** Hands work to the runtime after the response; without an execution context, runs it now. */
export function waitUntil(c: Context, promise: Promise<unknown>): void {
  const logged = promise.catch((error: unknown) => console.error("deferred work failed", error));
  try {
    c.executionCtx.waitUntil(logged);
  } catch {
    // No execution context (a plain app.request in tests): the promise runs on its own.
  }
}

/** Mounted on /api/*: opens the database lazily, and closes it after any deferred work. */
export function requestState(deps: AppDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let services: Services | undefined;
    let close: (() => Promise<void>) | undefined;
    const state: RequestState = {
      deferred: [],
      services() {
        if (!services) {
          const env = c.env;
          const opened = deps.openDb(env);
          close = opened.close;
          let auth: AdapterChoice | undefined;
          services = {
            env,
            db: opened.db,
            platform: deps.platform(env),
            instances: deps.instances(env),
            deps,
            auth: () => {
              auth ??= chooseAdapter(env, opened.db);
              return auth;
            },
          };
        }
        return services;
      },
    };
    c.set("req", state);
    try {
      await next();
    } finally {
      if (state.deferred.length > 0 || close) {
        const tasks = state.deferred.splice(0);
        const done = close;
        waitUntil(
          c,
          (async () => {
            for (const task of tasks) {
              await task().catch((error: unknown) => console.error("deferred task failed", error));
            }
            await done?.();
          })(),
        );
      }
    }
  });
}

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);

const AGENTS_STATUS: Record<AgentsError["code"], HttpError["status"]> = {
  not_found: 404,
  invalid_bundle: 422,
  invalid_definition: 422,
  no_op: 409,
  not_a_template: 422,
  not_a_client_agent: 422,
  not_linked: 409,
  no_live_version: 409,
  no_update: 409,
  merge_conflicts: 409,
  activation_refused: 409,
  invalid_state: 409,
  unknown_skill: 422,
  unknown_tool: 422,
  not_assignee: 403,
  test_run: 409,
};

/** Postgres errors that mean the request, not the server, is at fault. */
function pgStatus(error: unknown): HttpError | null {
  const code = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  switch (code ?? cause) {
    case "42501": // insufficient_privilege: row-level security refused the row.
      return new HttpError(403, "forbidden", "that is outside this session's clients");
    case "23505":
      return new HttpError(409, "conflict", "that already exists");
    case "23503":
      return new HttpError(422, "invalid_reference", "that refers to something that is not there");
    default:
      return null;
  }
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof AgentsError) {
    return new HttpError(
      AGENTS_STATUS[error.code] ?? 400,
      error.code,
      error.message,
      error.details,
    );
  }
  if (error instanceof ScopeError) return new HttpError(403, "forbidden", error.message);
  if (error instanceof z.ZodError) {
    return new HttpError(400, "invalid_request", z.prettifyError(error), error.issues);
  }
  return pgStatus(error) ?? new HttpError(500, "internal", "something went wrong");
}

export function errorResponse(c: Context, error: unknown, setCookies: readonly string[] = []) {
  const e = toHttpError(error);
  if (e.status === 500) {
    console.error(error);
    // A no-op where Sentry is off (no SENTRY_DSN, the tests): src/observability/sentry.ts.
    captureException(error, { tags: { route: c.req.routePath, method: c.req.method } });
  }
  for (const cookie of setCookies) c.header("Set-Cookie", cookie, { append: true });
  return c.json(
    { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } },
    e.status,
  );
}

function refusalResponse(c: Context, refusal: AuthRefusal) {
  for (const cookie of refusal.setCookies) c.header("Set-Cookie", cookie, { append: true });
  return c.json({ error: { code: refusal.code, message: refusal.message } }, refusal.status);
}

// ── Mounting contract routes ─────────────────────────────────────────────────────────────────────

/** A route spec's optional schema, parsed (`undefined` when the route declares none). */
type Parsed<T> = [Exclude<T, undefined>] extends [never]
  ? undefined
  : Exclude<T, undefined> extends z.ZodType
    ? z.output<Exclude<T, undefined>>
    : undefined;

export interface PublicCtx<R extends RouteSpec> {
  c: AppContext;
  body: Parsed<R["body"]>;
  query: Parsed<R["query"]>;
  services: Services;
}

export interface HandlerCtx<R extends RouteSpec> extends PublicCtx<R> {
  params: Parsed<R["params"]>;
  /** The transaction the handler runs in, scoped to `tenantIds` (and templates for operators). */
  tx: Tx;
  session: Session;
  role: Role;
  /** The clients this request may touch: one for the portal, those served for the back office. */
  tenantIds: readonly string[];
  operator: boolean;
  /** Runs after the transaction commits, before the response (e.g. resuming a waiting run). */
  afterCommit(task: () => Promise<unknown>): void;
  /** Runs after the response (e.g. dispatching emitted events). */
  defer(task: () => Promise<unknown>): void;
}

type Result<R extends RouteSpec> = z.input<R["response"]>;

async function parseInput<R extends RouteSpec>(c: AppContext, spec: R) {
  const params = spec.params ? spec.params.parse(c.req.param()) : undefined;
  const query = spec.query ? spec.query.parse(c.req.query()) : undefined;
  let body: unknown;
  if (spec.body) {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HttpError(400, "invalid_request", "the body must be JSON");
    }
    body = spec.body.parse(raw);
  }
  return { params, query, body } as {
    params: Parsed<R["params"]>;
    query: Parsed<R["query"]>;
    body: Parsed<R["body"]>;
  };
}

function respond<R extends RouteSpec>(c: AppContext, spec: R, result: unknown) {
  const out = spec.response.safeParse(result);
  if (!out.success) {
    console.error(`response of ${spec.method} ${spec.path} does not match its contract`, out.error);
    return errorResponse(c, new HttpError(500, "internal", "something went wrong"));
  }
  return c.json(out.data as object);
}

/** A route anyone may call (health, sign-in). */
export function mountPublic<R extends RouteSpec>(
  app: Hono<AppEnv>,
  spec: R,
  handler: (ctx: PublicCtx<R>) => Promise<Result<R>> | Result<R>,
): void {
  app.on(spec.method, spec.path, async (c) => {
    try {
      const { query, body } = await parseInput(c, spec);
      const services = c.get("req").services();
      return respond(c, spec, await handler({ c, body, query, services }));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}

/**
 * The client a request asks to act in: `?client=` (the back office's switcher, and the filter of
 * the cross-client lists) or the `x-countersign-client` header.
 */
// DECISION: the active client travels with each request (query or header), never in the cookie,
// as packages/auth decided; a portal user with one client needs neither.
export function requestedClient(c: AppContext): string | null {
  return c.req.query("client") ?? c.req.header("x-countersign-client") ?? null;
}

/**
 * A session route: sign-in, the route's roles, the client scope, then the handler inside
 * withOperator (back office) or withTenant (portal).
 */
export function mount<R extends RouteSpec>(
  app: Hono<AppEnv>,
  spec: R,
  handler: (ctx: HandlerCtx<R>) => Promise<Result<R>>,
): void {
  if (spec.auth !== "session") throw new Error(`${spec.path} is public: use mountPublic`);
  const family = routeFamily(spec);
  app.on(spec.method, spec.path, async (c) => {
    let setCookies: readonly string[] = [];
    try {
      const services = c.get("req").services();
      const choice = services.auth();
      if (!choice.ok) return refusalResponse(c, choice.refusal);
      const result = await getSession(c.req.raw, {
        adapter: choice.adapter,
        directory: authDirectory(services.db),
        tenantId: requestedClient(c),
      });
      if (!result.ok) return refusalResponse(c, result);
      setCookies = result.setCookies;
      const { session } = result;
      const role = requireRole(session, spec.roles);
      if (!role.ok) return refusalResponse(c, { ...role, setCookies });
      const scope = tenantScope(session, family);
      if (!scope.ok) return refusalResponse(c, { ...scope, setCookies });

      const input = await parseInput(c, spec);
      const after: (() => Promise<unknown>)[] = [];
      const ids = scope.tenantIds;
      const operator = scope.operator;
      const portalClient = ids[0];
      if (!operator && (ids.length !== 1 || !portalClient)) {
        throw new HttpError(403, "forbidden", "a portal request acts for exactly one client");
      }
      const output = await (operator
        ? withOperator(services.db, ids, run)
        : withTenant(services.db, portalClient as string, run));
      for (const task of after) {
        await task().catch((error: unknown) => console.error("after-commit task failed", error));
      }
      for (const cookie of setCookies) c.header("Set-Cookie", cookie, { append: true });
      return respond(c, spec, output);

      function run(tx: Tx) {
        return handler({
          c,
          tx,
          session,
          role: role.ok ? role.role : "client_user",
          tenantIds: ids,
          operator,
          ...input,
          services,
          afterCommit: (task) => after.push(task),
          defer: (task) => c.get("req").deferred.push(task),
        });
      }
    } catch (error) {
      return errorResponse(c, error, setCookies);
    }
  });
}

/** Throws 404 unless `tenantId` is one of the request's clients (ids in paths are untrusted). */
export function ensureClient(ctx: { tenantIds: readonly string[] }, tenantId: string): void {
  if (!ctx.tenantIds.includes(tenantId)) throw notFound("client");
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
