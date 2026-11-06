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
  type WorkOSClient,
} from "@countersign/auth";
import {
  createStripeClient,
  type FetchLike,
  globalFetch,
  type ObjectStore,
  R2ObjectStore,
  type StripeClient,
} from "@countersign/connectors";
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
import type { LlmTransport } from "@countersign/llm";
import { captureException } from "@sentry/cloudflare";
import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { type AuditEntry, auditAction, auditAlone, auditInTx, auditTarget } from "./audit";
import { type AdapterChoice, authDirectory, chooseAdapter } from "./auth";
import type { Bindings } from "./env";
import type { ExportJobs } from "./exports/instances";
import type { McpDeps } from "./mcp/routes";
import { type Platform, platformFor } from "./platform";
import type { QboSyncInstances } from "./qbo/instances";
import { workerTransport } from "./runs/execute";
import { type RunInstances, workflowInstances } from "./runs/instances";

// ── Dependencies and per-request state ───────────────────────────────────────────────────────────

/** What the app is built from; tests replace any of them. */
export interface AppDeps {
  platform(env: Bindings): Platform;
  /** A database client for one request (or one job), and how to close it. */
  openDb(env: Bindings): { db: Db; close(): Promise<void> };
  instances(env: Bindings): RunInstances;
  /** The Builder's model transport; default the Worker's live one (tests pass a FakeModel). */
  llm?(env: Bindings): LlmTransport;
  /** Object storage for originals: the R2 binding; memory in tests. */
  objects(env: Bindings): ObjectStore;
  /**
   * The model transport that reads uploaded and forwarded documents in the background; null when
   * no model key is configured (documents then wait for an agent's `docs.extract`).
   */
  extractionTransport(env: Bindings): LlmTransport | null;
  /** The WorkOS API client for the WorkOS sign-in; default over `fetch` (tests pass a fake). */
  workos?(env: Bindings): WorkOSClient;
  /** Outbound HTTP for provisioning calls (Twilio numbers); tests pass a fake. */
  fetch?(env: Bindings): FetchLike;
  /** Mezonas' Stripe (billing); null when STRIPE_SECRET_KEY is not set. Tests pass a fake. */
  stripe?(env: Bindings): StripeClient | null;
  /** QuickBooks syncs (QboSyncWorkflow); default the QBO_SYNC binding. Tests pass memory. */
  qboSync?(env: Bindings): QboSyncInstances | null;
  /** Client data exports (ExportWorkflow); default the EXPORT_WORKFLOW binding. Tests pass memory. */
  exports?(env: Bindings): ExportJobs | null;
  /** The MCP server's authorization server, audit, rate limit and clock; tests pass fakes. */
  mcp?: McpDeps;
}

/** The Stripe client for billing, or null where billing is off (no key). */
export function stripeFor(deps: AppDeps, env: Bindings): StripeClient | null {
  if (deps.stripe) return deps.stripe(env);
  const key = env.STRIPE_SECRET_KEY?.trim();
  return key ? createStripeClient({ secretKey: key, fetch: globalFetch() }) : null;
}

export const defaultDeps: AppDeps = {
  platform: (env) => platformFor(env),
  openDb(env) {
    // Hyperdrive pools the connections; one per request is all a handler needs.
    const db = createDb(env.HYPERDRIVE.connectionString, { max: 1 });
    return { db, close: () => closeDb(db) };
  },
  instances: (env) => workflowInstances(env.RUN_WORKFLOW),
  objects: (env) => new R2ObjectStore(env.ARTIFACTS),
  extractionTransport: (env) => (env.ANTHROPIC_API_KEY?.trim() ? workerTransport(env) : null),
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
              auth ??= chooseAdapter(env, opened.db, deps.workos?.(env));
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
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
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
  invalid_grant: 422,
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

/** What a request may touch once its session, roles and client scope have been checked. */
export interface Scope {
  readonly role: Role;
  /** The clients this request may touch: one for the portal, those served for the back office. */
  readonly tenantIds: readonly string[];
  readonly operator: boolean;
}

/**
 * The route's roles and the client scope for a session (invariant 1): the back office gets the
 * clients the operator serves, the portal exactly one client. Shared by `mount` and the MCP server.
 */
export function scopeOf(
  session: Session,
  roles: readonly Role[],
  family: "ops" | "portal",
): ({ readonly ok: true } & Scope) | AuthRefusal {
  const role = requireRole(session, roles);
  if (!role.ok) return role;
  const scope = tenantScope(session, family);
  if (!scope.ok) return scope;
  return { ok: true, role: role.role, tenantIds: scope.tenantIds, operator: scope.operator };
}

/** The scoped part of a handler's context, inside its transaction. */
export type Scoped = Scope & Pick<HandlerCtx<RouteSpec>, "tx" | "afterCommit" | "defer">;

/**
 * Runs `work` in one transaction scoped to `scope` (withOperator for the back office, withTenant
 * for the portal: exactly one client), then the after-commit tasks.
 */
export async function inScope<T>(
  c: AppContext,
  scope: Scope,
  work: (scoped: Scoped) => Promise<T>,
): Promise<T> {
  const ids = scope.tenantIds;
  const portalClient = ids[0];
  if (!scope.operator && (ids.length !== 1 || !portalClient)) {
    throw new HttpError(403, "forbidden", "a portal request acts for exactly one client");
  }
  const services = c.get("req").services();
  const after: (() => Promise<unknown>)[] = [];
  const run = (tx: Tx) =>
    work({
      role: scope.role,
      tenantIds: ids,
      operator: scope.operator,
      tx,
      afterCommit: (task) => after.push(task),
      defer: (task) => c.get("req").deferred.push(task),
    });
  const output = await (scope.operator
    ? withOperator(services.db, ids, run)
    : withTenant(services.db, portalClient as string, run));
  for (const task of after) {
    await task().catch((error: unknown) => console.error("after-commit task failed", error));
  }
  return output;
}

// biome-ignore lint/suspicious/noExplicitAny: one registry holds the handlers of every route spec.
type AnyHandler = (ctx: HandlerCtx<any>) => Promise<unknown>;
/** Each app's mounted handlers by route spec, so the MCP server runs the same code as /api. */
const mounted = new WeakMap<object, Map<RouteSpec, AnyHandler>>();

/**
 * A session route: sign-in, the route's roles, the client scope, then the handler inside
 * withOperator (back office) or withTenant (portal).
 */
export function mount<R extends RouteSpec>(
  app: Hono<AppEnv>,
  spec: R,
  handler: (ctx: HandlerCtx<R>) => Promise<Result<R>>,
): void {
  mountWith(app, spec, handler, respond);
}

/** What a file route's handler hands back: the bytes, their type and the name to save them as. */
export interface FileResult {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * A session route that answers with a file (an export's CSV or ZIP) instead of JSON: the same
 * sign-in, roles, client scope, transaction and audit row as `mount`. The route's response schema
 * checks what the handler hands back (core's `ExportFile`).
 */
export function mountFile<R extends RouteSpec>(
  app: Hono<AppEnv>,
  spec: R,
  handler: (ctx: HandlerCtx<R>) => Promise<Result<R> & FileResult>,
): void {
  mountWith(app, spec, handler, sendFile);
}

function sendFile<R extends RouteSpec>(c: AppContext, spec: R, result: unknown) {
  const out = spec.response.safeParse(result);
  if (!out.success) {
    console.error(`response of ${spec.method} ${spec.path} does not match its contract`, out.error);
    return errorResponse(c, new HttpError(500, "internal", "something went wrong"));
  }
  const file = out.data as FileResult;
  // c.body keeps the headers already set on the context (the session's cookies).
  return c.body(file.bytes as Uint8Array<ArrayBuffer>, 200, {
    "content-type": file.contentType,
    "content-disposition": contentDisposition(file.filename, "attachment"),
    "cache-control": "private, max-age=0, no-store",
  });
}

/**
 * `inline` or `attachment` with the file's name: a plain ASCII fallback for old clients plus the
 * exact name as RFC 5987 UTF-8, so a non-Latin-1 name (e.g. a Chinese invoice) is a valid header,
 * not a 500.
 */
export function contentDisposition(
  name: string,
  kind: "inline" | "attachment" = "inline",
): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document";
  const utf8 = encodeURIComponent(name.replace(/[\r\n]/g, "")).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function mountWith<R extends RouteSpec>(
  app: Hono<AppEnv>,
  spec: R,
  handler: (ctx: HandlerCtx<R>) => Promise<unknown>,
  send: (c: AppContext, spec: R, result: unknown) => Response | Promise<Response>,
): void {
  if (spec.auth !== "session") throw new Error(`${spec.path} is public: use mountPublic`);
  const family = routeFamily(spec);
  let handlers = mounted.get(app);
  if (!handlers) {
    handlers = new Map();
    mounted.set(app, handlers);
  }
  handlers.set(spec, handler as AnyHandler);
  app.on(spec.method, spec.path, async (c) => {
    let setCookies: readonly string[] = [];
    // The audit row (docs/plan.md §1.35): who, once known, and the client acted in.
    let actor: AuditActor = { actorKind: "anonymous" };
    let auditTenant: string | null = null;
    const entry = (outcome: AuditEntry["outcome"], httpStatus: number): AuditEntry => ({
      ...actor,
      tenantId: auditTenant,
      action: auditAction(c),
      outcome,
      httpStatus,
      target: auditTarget(c, requestedClient(c)),
    });
    const refused = async (refusal: AuthRefusal) => {
      // No credentials at all is a signed-out browser asking, not an access attempt worth a row.
      if (refusal.code !== "unauthenticated") {
        await auditAlone(c.get("req").services().db, c, entry("refused", refusal.status));
      }
      return refusalResponse(c, refusal);
    };
    try {
      const services = c.get("req").services();
      const choice = services.auth();
      if (!choice.ok) return refused(choice.refusal);
      const result = await getSession(c.req.raw, {
        adapter: choice.adapter,
        directory: authDirectory(services.db),
        tenantId: requestedClient(c),
      });
      if (!result.ok) return refused(result);
      setCookies = result.setCookies;
      const { session } = result;
      actor = auditActor(session);
      const scope = scopeOf(session, spec.roles, family);
      if (!scope.ok) return refused({ ...scope, setCookies });
      auditTenant = auditClient(scope, requestedClient(c), routeParams(c));

      const input = await parseInput(c, spec);
      const output = await inScope(c, scope, async (scoped) => {
        const out = await handler({ c, session, ...scoped, ...input, services });
        // In the request's own transaction: it commits with what the request wrote.
        await auditInTx(scoped.tx, c, entry("ok", 200));
        return out;
      });
      for (const cookie of setCookies) c.header("Set-Cookie", cookie, { append: true });
      return send(c, spec, output);
    } catch (error) {
      const status = toHttpError(error).status;
      await auditAlone(
        c.get("req").services().db,
        c,
        entry(status >= 500 ? "error" : "refused", status),
      );
      return errorResponse(c, error, setCookies);
    }
  });
}

type AuditActor = Pick<AuditEntry, "actorKind" | "actorUserId" | "actorEmail" | "actorRole">;

/** Who a session is, for an audit row. */
export function auditActor(session: Session): AuditActor {
  return {
    actorKind: "user",
    actorUserId: session.user.id,
    actorEmail: session.user.email,
    actorRole: session.activeRole ?? (session.isOperator ? "operator" : null),
  };
}

function routeParams(c: AppContext): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.param() as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The client a request acted in, for its audit row: the portal's one client; for the back office,
 * the client it named (`?client=`, or a path id that is one of its clients), or null for a list
 * across clients.
 */
export function auditClient(
  scope: Pick<Scope, "tenantIds" | "operator">,
  requested: string | null,
  params: Record<string, string>,
): string | null {
  const ids = scope.tenantIds;
  if (!scope.operator) return ids[0] ?? null;
  if (requested && ids.includes(requested)) return requested;
  for (const v of Object.values(params)) if (ids.includes(v)) return v;
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

/** Raw inputs for `invokeRoute`, as a request carries them (query values are strings). */
export interface RouteInput {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

/**
 * Calls a mounted route's handler for `session` without HTTP: the same roles, client scope, input
 * schemas, transaction and response contract as the route itself. The MCP server reads through
 * this, so its tools show what the back office shows, scoped as the back office is.
 */
export async function invokeRoute<R extends RouteSpec>(
  app: Hono<AppEnv>,
  c: AppContext,
  session: Session,
  spec: R,
  raw: RouteInput = {},
): Promise<z.output<R["response"]>> {
  const handler = mounted.get(app)?.get(spec);
  if (!handler) throw new Error(`${spec.method} ${spec.path} is not mounted`);
  const scope = scopeOf(session, spec.roles, routeFamily(spec));
  if (!scope.ok) throw new HttpError(scope.status, scope.code, scope.message);
  const input = {
    params: spec.params ? spec.params.parse(raw.params ?? {}) : undefined,
    query: spec.query ? spec.query.parse(raw.query ?? {}) : undefined,
    body: spec.body ? spec.body.parse(raw.body) : undefined,
  };
  const services = c.get("req").services();
  // Audited like the route itself, marked as through the MCP server (docs/plan.md §1.35).
  const entry = (outcome: AuditEntry["outcome"], httpStatus: number): AuditEntry => ({
    ...auditActor(session),
    tenantId: auditClient(scope, raw.query?.client ?? null, raw.params ?? {}),
    action: `mcp ${spec.method} ${spec.path}`,
    outcome,
    httpStatus,
    target: {
      ...Object.fromEntries(
        Object.entries(raw.params ?? {}).map(([k, v]) => [k, String(v).slice(0, 200)]),
      ),
      ...(raw.query?.client ? { client: raw.query.client.slice(0, 200) } : {}),
    },
  });
  try {
    const output = await inScope(c, scope, async (scoped) => {
      const out = await handler({ c, session, ...scoped, ...input, services });
      await auditInTx(scoped.tx, c, entry("ok", 200));
      return out;
    });
    return spec.response.parse(output) as z.output<R["response"]>;
  } catch (error) {
    const status = toHttpError(error).status;
    await auditAlone(services.db, c, entry(status >= 500 ? "error" : "refused", status));
    throw error;
  }
}

/** Throws 404 unless `tenantId` is one of the request's clients (ids in paths are untrusted). */
export function ensureClient(ctx: { tenantIds: readonly string[] }, tenantId: string): void {
  if (!ctx.tenantIds.includes(tenantId)) throw notFound("client");
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
