// The request plumbing every route goes through (docs/plan.md §1.2 "Role checks"): one database
// client per request, the session from packages/auth, the route's roles from the contract, the
// client scope (`app.tenant_ids`, `app.operator`) set on the transaction the handler runs in, Zod
// on the way in and on the way out, and work that must wait for the commit. A session route reads
// its user and memberships in that same transaction (withSession, docs/plan.md §1.90).

import { AgentsError } from "@countersign/agents";
import {
  type AuthRefusal,
  accountFresh,
  type CarriedAccount,
  epochSec,
  requireRole,
  type Session,
  secondFactorGate,
  sessionFromAccount,
  tenantScope,
  type WorkOSClient,
} from "@countersign/auth";
import type { CodeVerifier } from "@countersign/connectors";
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
  withSession,
  withTenant,
} from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import { captureException } from "@sentry/cloudflare";
import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { type AuditEntry, auditAction, auditAlone, auditInTx, auditTarget } from "./audit";
import { type AdapterChoice, accountInTx, authDirectory, chooseAdapter } from "./auth";
import type { BrowserDeps } from "./browser/services";
import type { Bindings } from "./env";
import type { ExportJobs } from "./exports/instances";
import type { McpDeps } from "./mcp/routes";
import { reportHandled } from "./observability/report";
import { type Platform, platformFor } from "./platform";
import type { QboSyncInstances } from "./qbo/instances";
import { workerTransport } from "./runs/execute";
import { type RunInstances, workflowInstances } from "./runs/instances";
import { secondFactorPolicy, secondFactorSetupOf } from "./second-factor";
// v0.12 W2-C
import type { TestSuiteJobs } from "./testbench/instances";

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
  // Wave 4 (docs/plan.md §1.86 "Scripts (wave 4)")
  /**
   * A fresh browser for a script's recording or test; default Browser Run over the `BROWSER`
   * binding (tests pass a fake browser). Undefined: no browser here.
   */
  browserOpener?(env: Bindings): BrowserDeps["open"];
  /**
   * The model transport that reads uploaded and forwarded documents in the background; null when
   * no model key is configured (documents then wait for an agent's `docs.extract`).
   */
  extractionTransport(env: Bindings): LlmTransport | null;
  // P-7
  /**
   * The model transport that translates messages outside a run (docs/plan.md §1.69); left out, the
   * extraction transport. Tests pass a FakeModel.
   */
  translationTransport?(env: Bindings): LlmTransport | null;
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
  // v0.12 W2-C
  /** Test suites (TestSuiteWorkflow); default the TEST_SUITE_WORKFLOW binding. Tests pass their own. */
  testSuites?(env: Bindings): TestSuiteJobs | null;
  /** The MCP server's authorization server, audit, rate limit and clock; tests pass fakes. */
  mcp?: McpDeps;
  /** §1.99: the code service for sign-in codes; default Twilio Verify. Tests pass one in memory. */
  codeVerifier?(env: Bindings): CodeVerifier;
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
  const logged = promise.catch((error: unknown) =>
    reportHandled("deferred work failed", error, { kind: "deferred" }),
  );
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
          let platform: Platform | undefined;
          services = {
            env,
            db: opened.db,
            // DECISION: built on first use, not for every request (docs/plan.md §1.82): the tool
            // registry and skill catalog take tens of ms to build in a fresh isolate, and most
            // requests (lists, counts, the command center) never read them.
            get platform() {
              platform ??= deps.platform(env);
              return platform;
            },
            instances: deps.instances(env),
            deps,
            auth: () => {
              auth ??= chooseAdapter(
                env,
                opened.db,
                deps.workos?.(env),
                secondFactorPolicy(
                  secondFactorSetupOf(env, {
                    ...(deps.codeVerifier ? { verifier: deps.codeVerifier } : {}),
                  }),
                  opened.db,
                ),
              );
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
              await task().catch((error: unknown) =>
                reportHandled("deferred task failed", error, { kind: "deferred" }),
              );
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
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 501 | 502 | 503,
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

/**
 * A handler answered with something its route's contract does not allow: a bug on our side. The
 * caller gets the plain 500; Sentry gets the validation error (paths and expectations, not values)
 * once, grouped by route, rather than the generic 500 errorResponse would send.
 */
function contractBroken(c: Context, spec: RouteSpec, error: z.ZodError) {
  reportHandled(`response of ${spec.method} ${spec.path} does not match its contract`, error, {
    kind: "contract",
    route: `${spec.method} ${spec.path}`,
  });
  return c.json({ error: { code: "internal", message: "something went wrong" } }, 500);
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
  /**
   * This request changed the signed-in person's own memberships (a client they now serve): the
   * response drops the account their cookie carries, so the next request reads it (§1.93).
   */
  accountChanged(): void;
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
    return contractBroken(c, spec, out.error);
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

/** A portal request acts for exactly one client (invariant 1); the back office for those served. */
function checkScope(scope: Scope): void {
  if (!scope.operator && (scope.tenantIds.length !== 1 || !scope.tenantIds[0])) {
    throw new HttpError(403, "forbidden", "a portal request acts for exactly one client");
  }
}

/** The scoped part of a handler's context for `tx`; after-commit tasks are collected in `after`. */
function scopedFor(c: AppContext, scope: Scope, tx: Tx, after: (() => Promise<unknown>)[]): Scoped {
  return {
    role: scope.role,
    tenantIds: scope.tenantIds,
    operator: scope.operator,
    tx,
    afterCommit: (task) => after.push(task),
    defer: (task) => c.get("req").deferred.push(task),
  };
}

/** Runs the after-commit tasks in order, once the transaction has committed. */
async function runAfterCommit(after: (() => Promise<unknown>)[]): Promise<void> {
  for (const task of after) {
    await task().catch((error: unknown) =>
      reportHandled("after-commit task failed", error, { kind: "after_commit" }),
    );
  }
}

/**
 * Runs `work` in one transaction scoped to `scope` (withOperator for the back office, withTenant
 * for the portal: exactly one client), then the after-commit tasks.
 */
export async function inScope<T>(
  c: AppContext,
  scope: Scope,
  work: (scoped: Scoped) => Promise<T>,
): Promise<T> {
  checkScope(scope);
  const ids = scope.tenantIds;
  const services = c.get("req").services();
  const after: (() => Promise<unknown>)[] = [];
  const run = (tx: Tx) => work(scopedFor(c, scope, tx, after));
  const output = await (scope.operator
    ? withOperator(services.db, ids, run)
    : withTenant(services.db, ids[0] as string, run));
  await runAfterCommit(after);
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

/**
 * What a slow route's handler gets (`mountLong`): the request's scope without a transaction, and
 * `inTx` to open short ones in that scope (withOperator or withTenant, as `mount`'s), each
 * committed before the next starts.
 */
export interface LongHandlerCtx<R extends RouteSpec>
  extends Omit<HandlerCtx<R>, "tx" | "afterCommit"> {
  /** One short transaction in the request's scope; its after-commit tasks run once it commits. */
  inTx<T>(work: (scoped: Scoped) => Promise<T>): Promise<T>;
}

/**
 * A session route whose handler waits on something slow between its reads and writes (a browser,
 * a client's tool through the external-action path): the same sign-in, roles, client scope and
 * input checks as `mount`, but no transaction held across the handler. A Worker's database has one
 * pooled connection (`openDb`), so a handler that opens transactions of its own (the vault, the
 * browser's services, the runtime) must never run inside the request's: it would wait on itself.
 * The handler reads and writes in short `inTx` transactions; the ok audit row is written alone once
 * it returns (auditAlone), and a refusal or failure is audited as `mount` audits it. Not reachable
 * through `invokeRoute`.
 */
// DECISION: a variant of `mount`, not routes with session code of their own: sign-in, roles, scope
// and the audit row stay in one place (invariant 14). The ok row is written after the handler's
// last transaction, so a write that committed beside an audit row that didn't is possible;
// auditAlone reports that miss, as it does for refusals.
export function mountLong<R extends RouteSpec>(
  app: Hono<AppEnv>,
  spec: R,
  handler: (ctx: LongHandlerCtx<R>) => Promise<Result<R>>,
): void {
  mountWith(app, spec, handler, respond, "long");
}

/** A slow route's `inTx` for code that takes only the transaction. */
export function txOnly(
  inTx: LongHandlerCtx<RouteSpec>["inTx"],
): <T>(work: (tx: Tx) => Promise<T>) => Promise<T> {
  return (work) => inTx((scoped) => work(scoped.tx));
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

/**
 * Wave 6: a file route whose handler reads slow things outside a transaction (object storage):
 * `mountLong`'s short `inTx` transactions and its audit row, answered as `mountFile` answers.
 */
export function mountLongFile<R extends RouteSpec>(
  app: Hono<AppEnv>,
  spec: R,
  handler: (ctx: LongHandlerCtx<R>) => Promise<Result<R> & FileResult>,
): void {
  mountWith(app, spec, handler, sendFile, "long");
}

function sendFile<R extends RouteSpec>(c: AppContext, spec: R, result: unknown) {
  const out = spec.response.safeParse(result);
  if (!out.success) {
    return contractBroken(c, spec, out.error);
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
export function contentDisposition(name: string, kind: "inline" | "attachment" = "inline"): string {
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
  handler:
    | ((ctx: HandlerCtx<R>) => Promise<unknown>)
    | ((ctx: LongHandlerCtx<R>) => Promise<unknown>),
  send: (c: AppContext, spec: R, result: unknown) => Response | Promise<Response>,
  mode: "tx" | "long" = "tx",
): void {
  if (spec.auth !== "session") throw new Error(`${spec.path} is public: use mountPublic`);
  const family = routeFamily(spec);
  let handlers = mounted.get(app);
  if (!handlers) {
    handlers = new Map();
    mounted.set(app, handlers);
  }
  // A slow route's handler takes no transaction: invokeRoute (the MCP server) never runs one.
  if (mode === "tx") handlers.set(spec, handler as AnyHandler);
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
      // Who is asking, from the cookie (a WorkOS refresh included): no database transaction yet.
      const now = new Date();
      const identified = await choice.adapter.identify(c.req.raw, now);
      if (!identified.ok) return refused(identified);
      // The second step (docs/plan.md §1.99): a pending sign-in reaches only the step's own routes,
      // which run outside mount. Checked before any account is read or carried.
      const pending = secondFactorGate(identified);
      if (pending) return refused(pending);
      const { userId } = identified;
      const requested = requestedClient(c);
      const nowSec = epochSec(now);
      // The session and its scope from the user's account, or the refusal (with its cookies).
      const decide = (account: Parameters<typeof sessionFromAccount>[0]) => {
        // Each decision starts clean: a carried account that refused, then a read that refused
        // too, is audited as what was read, never as what the cookie carried (§1.93).
        actor = { actorKind: "anonymous" };
        auditTenant = null;
        setCookies = [];
        const result = sessionFromAccount(
          account,
          choice.adapter.kind,
          requested,
          identified.setCookies,
          identified.secondFactor,
        );
        if (!result.ok) return result;
        setCookies = result.setCookies;
        const { session } = result;
        actor = auditActor(session);
        const scope = scopeOf(session, spec.roles, family);
        if (!scope.ok) return { ...scope, setCookies };
        auditTenant = auditClient(scope, requested, routeParams(c));
        return { ok: true as const, session, scope };
      };

      // The account the cookie carries, while it is younger than the window (docs/plan.md §1.93):
      // the session and scope come from it and the account is not read. Only a carried account
      // that admits the request is used; one that would refuse it is read again first, so a
      // request naming a new client or needing a new role is not delayed (lists across clients
      // and a role raised in place wait for the window: §1.93).
      const carried =
        identified.account && accountFresh(identified.account, nowSec) ? identified.account : null;
      const fromCookie = carried ? decide(carried) : null;
      const admitted = fromCookie?.ok ? fromCookie : null;
      // An account read by this request, to carry from now on; and whether the handler changed it.
      let read: CarriedAccount | null = null;
      let changed = false;
      const accountChanged = () => {
        changed = true;
      };
      const readAccount = <
        A extends { user: Session["user"] | null } & Pick<CarriedAccount, "memberships">,
      >(
        account: A,
      ): A => {
        read = account.user
          ? { at: nowSec, user: account.user, memberships: account.memberships }
          : null;
        return account;
      };

      let output: unknown;
      if (mode === "long") {
        // No transaction is held across a slow handler: the account in one of its own (withUser),
        // unless the cookie carries it, then the handler's short `inTx` transactions in the scope.
        const directory = authDirectory(services.db);
        const decided =
          admitted ??
          decide(
            readAccount(
              directory.account
                ? await directory.account(userId)
                : {
                    user: await directory.user(userId),
                    memberships: await directory.memberships(userId),
                  },
            ),
          );
        if (!decided.ok) return refused(decided);
        const { session, scope } = decided;
        const input = await parseInput(c, spec);
        output = await (handler as (ctx: LongHandlerCtx<R>) => Promise<unknown>)({
          c,
          session,
          role: scope.role,
          tenantIds: scope.tenantIds,
          operator: scope.operator,
          defer: (task) => c.get("req").deferred.push(task),
          inTx: (work) => inScope(c, scope, work),
          accountChanged,
          ...input,
          services,
        } as LongHandlerCtx<R>);
        // No request transaction to commit with: its own, once the handler's work is done.
        await auditAlone(services.db, c, entry("ok", 200));
      } else if (admitted) {
        // One transaction in the carried scope: no account read, no `app.user_id` at all.
        if (spec.body) await c.req.text().catch(() => undefined);
        const { session, scope } = admitted;
        output = await inScope(c, scope, async (scoped) => {
          const input = await parseInput(c, spec);
          const out = await (handler as (ctx: HandlerCtx<R>) => Promise<unknown>)({
            c,
            session,
            ...scoped,
            accountChanged,
            ...input,
            services,
          });
          await auditInTx(scoped.tx, c, entry("ok", 200));
          return out;
        });
      } else {
        // One transaction (docs/plan.md §1.90): the user and memberships under `app.user_id`, then
        // the scope in place of it, then the handler and the ok audit row, committed together.
        // DECISION: the body is read before the transaction opens, so a slow or trickled upload
        // never holds a connection and a transaction (docs/plan.md §1.90). Hono keeps what it read;
        // `parseInput` parses it inside, after the scope check, so a refusal still comes before a
        // 400 as it did. A body that fails to read fails there, as before.
        if (spec.body) await c.req.text().catch(() => undefined);
        const after: (() => Promise<unknown>)[] = [];
        const result = await withSession(
          services.db,
          userId,
          async (tx) => {
            const decided = decide(readAccount(await accountInTx(tx, userId)));
            if (!decided.ok) return { ok: false as const, refusal: decided };
            checkScope(decided.scope);
            const input = await parseInput(c, spec);
            return {
              ok: true as const,
              scope: decided.scope,
              value: { session: decided.session, scope: decided.scope, input },
            };
          },
          async (tx, { session, scope, input }) => {
            const out = await (handler as (ctx: HandlerCtx<R>) => Promise<unknown>)({
              c,
              session,
              ...scopedFor(c, scope, tx, after),
              accountChanged,
              ...input,
              services,
            });
            // In the request's own transaction: it commits with what the request wrote.
            await auditInTx(tx, c, entry("ok", 200));
            return out;
          },
        );
        // A refusal is audited alone, after the read-only sign-in half has ended.
        if (!result.ok) return refused(result.refusal);
        await runAfterCommit(after);
        output = result.value;
      }
      // The cookie carries what this request read, or nothing once the handler changed the
      // person's own memberships; a request that used the carried account leaves it as it is.
      if (identified.carry && (changed || read)) {
        setCookies = await identified.carry(changed ? null : read, new Date());
      }
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
      // No cookie here: the MCP server reads the account on each call (docs/plan.md §1.90).
      const accountChanged = () => undefined;
      const out = await handler({ c, session, ...scoped, accountChanged, ...input, services });
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

// ── v0.12 W2-G: a file streamed after the request's transaction commits ─────────────────────────

/** What a streamed file route's handler hands back: a stream, its type and the name to save it as. */
export interface StreamResult {
  filename: string;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}

/**
 * A session route that answers with a stream (the audit export): the same sign-in, roles, client
 * scope, transaction and audit row as `mount`. The handler checks and audits inside the request's
 * transaction and hands back a stream that reads after it commits, each read in its own scoped
 * transaction; the handler `defer`s the stream's end, so the database closes only after it.
 */
export function mountStream<R extends RouteSpec>(
  app: Hono<AppEnv>,
  spec: R,
  handler: (ctx: HandlerCtx<R>) => Promise<Result<R> & StreamResult>,
): void {
  mountWith(app, spec, handler, sendStream);
}

function sendStream<R extends RouteSpec>(c: AppContext, spec: R, result: unknown) {
  const out = spec.response.safeParse(result);
  if (!out.success) {
    return contractBroken(c, spec, out.error);
  }
  const file = out.data as StreamResult;
  return c.body(file.stream, 200, {
    "content-type": file.contentType,
    "content-disposition": contentDisposition(file.filename, "attachment"),
    "cache-control": "private, max-age=0, no-store",
  });
}
