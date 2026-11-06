// The portal's Connections actions (ARCHITECTURE §6.1 "Who does what", §14): the client admin
// signs in to an offered tool and disconnects it. Client sessions reach the portal routes; the
// operator offers connectors and sets matrices from the back office, and never connects a tool on
// a client's behalf. The one exception is the Sandbox client, the operator's own test client: the
// operator signs in to its OAuth tools through the `/api/ops` routes at the end of this file, over
// the same redirect URIs. Portal responses are the portal's connection shape: never credentials.

import {
  beginAuthorization,
  type ConnectionRef,
  type Connector,
  completeAuthorization,
  connectionDefaults,
  GMAIL_CONNECTOR_ID,
  GmailApiError,
  GmailNoAddressError,
  GmailNotConfiguredError,
  isGmailConnector,
  MimeError,
  noopLogger,
  OAuthCallbackError,
  type OAuthOrigin,
  QBO_CONNECTOR_ID,
  ReconnectRequiredError,
  readOAuthState,
  SignInRefusedError,
} from "@countersign/connectors";
import {
  clientLanguage,
  GMAIL_TEST_WORDS,
  type Locale,
  parseAcceptLanguage,
  resolveLocale,
  routes,
  userLanguage,
  uuidv7,
} from "@countersign/core";
import { connection, connectionChange, type Tx, tenant } from "@countersign/db";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Bindings } from "../env";
import { type AppContext, type AppEnv, HttpError, mount, notFound, type Services } from "../http";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { connectionCredentials, vaultFor } from "../secrets";
import { opsConnection } from "./mappers";
import { offeredConnectors, sandboxClient } from "./ops-clients";
import { canSignIn, PERSONAL_CONNECTORS, portalConnections } from "./portal";
import { qboSyncFor, startQboSync } from "./qbo";

async function connectionOut(
  tx: Tx,
  tenantId: string,
  platform: Platform,
  id: string,
  viewerId?: string,
) {
  const [out] = await portalConnections(tx, tenantId, platform, id, viewerId);
  if (!out) throw notFound("connection");
  return out;
}

/**
 * Connects a connector that needs no provider sign-in in one client, reusing its existing row so
 * the matrix the client tightened and the agents' bindings stay as they were. Returns the id.
 */
export async function connectNoAuth(
  tx: Tx,
  input: {
    tenantId: string;
    connector: string;
    platform: Platform;
    actorId: string;
    by: "client" | "operator";
  },
): Promise<string> {
  const { tenantId } = input;
  const connector = input.platform.connectors.get(input.connector);
  if (connector?.manifest.auth !== "none") {
    throw new HttpError(
      409,
      "not_available",
      `signing in to ${connector?.manifest.name ?? input.connector} is not available yet`,
    );
  }
  // DECISION: a client has at most one connection per connector in v1 (the newest row is used).
  const [existing] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, input.connector)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  if (existing) {
    if (existing.status !== "connected") {
      await tx
        .update(connection)
        .set({ status: "connected", connectedBy: input.actorId })
        .where(and(eq(connection.id, existing.id), eq(connection.tenantId, tenantId)));
      await tx.insert(connectionChange).values({
        tenantId,
        connectionId: existing.id,
        actorId: input.actorId,
        change: { kind: "status", by: input.by, before: existing.status, after: "connected" },
      });
    }
    return existing.id;
  }
  const [row] = await tx
    .insert(connection)
    .values({
      tenantId,
      connector: input.connector,
      status: "connected",
      permissions: connectionDefaults(connector.manifest),
      connectedBy: input.actorId,
    })
    .returning();
  if (!row) throw new Error("connection insert returned nothing");
  await tx.insert(connectionChange).values({
    tenantId,
    connectionId: row.id,
    actorId: input.actorId,
    change: { kind: "status", by: input.by, before: null, after: "connected" },
  });
  return row.id;
}

/** The portal entry for one connector (its connection may be null: not signed in yet). */
async function connectorOut(
  tx: Tx,
  tenantId: string,
  platform: Platform,
  connectorId: string,
  viewerId?: string,
) {
  const all = await portalConnections(tx, tenantId, platform, undefined, viewerId);
  const out = all.find((x) => x.connector === connectorId);
  if (!out) throw notFound("connector");
  return out;
}

export async function offeredTo(tx: Tx, tenantId: string, connectorId: string): Promise<void> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  if (!offeredConnectors(t.settings).includes(connectorId)) throw notFound("connector");
}

/**
 * Where the provider sends the client back: the portal's callback page for the connector, which
 * posts the parameters to `POST /api/connections/:connector/callback` in the client's session.
 */
// DECISION: the provider redirects to a portal page (one fixed path per connector, as providers
// register exact redirect URIs), not to an API route, so the callback runs as an ordinary JSON
// route with the session's role and client checks, and the page shows the outcome.
// DECISION: QuickBooks returns to the API path too: the Intuit app has
// `/api/connections/qbo/callback` registered (ARCHITECTURE §14, plan §1.30).
export function oauthRedirectUri(c: AppContext, env: Bindings, connectorId: string): string {
  const origin = (env.APP_ORIGIN?.trim() || new URL(c.req.url).origin).replace(/\/+$/, "");
  // DECISION: Google's OAuth client (owner, 2026-11-05) registers `/api/connections/gmail/callback`
  // per environment, so Gmail returns to that API path (GOOGLE_REDIRECT_URI when set, ARCHITECTURE
  // §17), which only forwards the parameters to the portal page below (`API_RETURN_PATH`).
  if (connectorId === "gmail") {
    return env.GOOGLE_REDIRECT_URI?.trim() || `${origin}/api/connections/gmail/callback`;
  }
  if (connectorId === QBO_CONNECTOR_ID) return `${origin}/api/connections/qbo/callback`;
  return `${origin}/connections/${connectorId}/callback`;
}

/** The API path a provider may return to; it forwards to a callback page as it is. */
const API_RETURN_PATH = "/api/connections/:connector/callback";

/**
 * Whether a callback belongs to a back-office sign-in to this connector (the operator in the
 * Sandbox client). Decided from the signed state only once its signature holds and it has not
 * expired; anything else (no state, no secret, a bad or stale state) is the portal's, as before.
 */
// DECISION: the forwarder tells the two apart by the state's signed origin (`o: "ops"`), so the
// providers keep exactly one registered redirect URI per connector (docs/plan.md §1.5).
async function startedInBackOffice(
  env: Bindings,
  connectorId: string,
  state: string | null,
): Promise<boolean> {
  const secret = env.OAUTH_STATE_SECRET;
  if (!state || !secret || secret.length < 32) return false;
  const read = await readOAuthState(state, { secret });
  return read.ok && read.claims.origin === "ops" && read.claims.connector === connectorId;
}

/**
 * Whether this session may sign in to, or disconnect, a connector's connection. The client admin
 * may, for every tool. A client user may only for a person's own account (Gmail), and only when no
 * one else's is connected: one person can't take over another's mailbox.
 */
function mayManage(
  role: string,
  userId: string,
  connectorId: string,
  existing: { status: string; connectedBy: string | null } | undefined,
): { ok: true } | { ok: false; message: string } {
  if (role === "client_admin") return { ok: true };
  if (!PERSONAL_CONNECTORS.has(connectorId)) {
    return { ok: false, message: "your admin connects this tool" };
  }
  // Someone else's mailbox stays theirs until it is disconnected, also while it needs reconnecting.
  if (existing && existing.status !== "disconnected" && existing.connectedBy !== userId) {
    return { ok: false, message: "someone else connected this account; your admin can change it" };
  }
  return { ok: true };
}

function stateSecret(env: Bindings): string {
  const secret = env.OAUTH_STATE_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(503, "not_configured", "signing in to tools is not set up here yet");
  }
  return secret;
}

/** What a connector sees of a connection row (for revoking). */
function refOf(row: ConnectionRow): ConnectionRef {
  return {
    id: row.id,
    tenantId: row.tenantId,
    connector: row.connector,
    status: row.status,
    externalAccountId: row.externalAccountId,
    config: row.config as ConnectionRef["config"],
    permissions: row.permissions,
  };
}

type ConnectionRow = typeof connection.$inferSelect;

/**
 * Disconnects a connection: the provider's grant is revoked, the credentials go, and the change is
 * recorded with who made it. The row, its matrix and its history stay (bindings keep pointing at
 * it, so reconnecting puts the agents back to work). Already disconnected: nothing happens.
 */
export async function disconnect(
  tx: Tx,
  services: Services,
  row: ConnectionRow,
  who: { actorId: string; by: "client" | "operator" },
): Promise<void> {
  if (row.status === "disconnected") return;
  const { tenantId } = row;
  // DECISION: the grant is revoked at the provider first (Connector.revoke), best effort: a
  // provider that is down must not keep the client from disconnecting, and the stored
  // credentials are dropped either way.
  const connector = services.platform.connectors.get(row.connector);
  if (connector?.revoke && row.credentialsEncrypted && services.env.ENCRYPTION_KEY) {
    try {
      await connector.revoke({
        tenantId,
        connection: refOf(row),
        credentials: await connectionCredentials(tx, services.env, row),
        logger: noopLogger,
        now: () => new Date(),
      });
    } catch (error) {
      console.warn(`revoking ${row.connector} for connection ${row.id} failed`, error);
    }
  }
  // The vault's read model of the credentials goes with them (docs/plan.md §1.26).
  const { vault: _vault, ...config } = row.config as Record<string, unknown>;
  await tx
    .update(connection)
    .set({ status: "disconnected", credentialsEncrypted: null, config })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
  await tx.insert(connectionChange).values({
    tenantId,
    connectionId: row.id,
    actorId: who.actorId,
    change: { kind: "status", by: who.by, before: row.status, after: "disconnected" },
  });
}

/** `connection_change.change.kind` of a Gmail test email the person sent to their own mailbox. */
export const GMAIL_TEST_CHANGE = "gmail_test_email";

/** An OAuth connector this deployment can sign in to, or 409 `not_available`. */
function oauthConnector(platform: Platform, connectorId: string): Connector {
  const connector = platform.connectors.get(connectorId);
  if (connector?.manifest.auth !== "oauth2" || !canSignIn(connector)) {
    throw new HttpError(409, "not_available", "signing in to that tool is not available");
  }
  return connector;
}

/**
 * Finishes a provider sign-in: checks the state against the session that posts it (client,
 * connector, user and where it started), exchanges the code, and stores the credentials on the
 * client's one connection for the connector (a reconnect keeps its matrix and bindings). Records
 * the change with who made it, and starts QuickBooks' first sync. Returns the connection id.
 */
async function finishSignIn(
  ctx: {
    c: AppContext;
    tx: Tx;
    services: Services;
    defer(task: () => Promise<unknown>): void;
  },
  input: {
    tenantId: string;
    connector: Connector;
    params: Record<string, string>;
    userId: string;
    origin: OAuthOrigin;
    by: "client" | "operator";
    existing: ConnectionRow | undefined;
  },
): Promise<string> {
  const { c, tx, services } = ctx;
  const { tenantId, connector, existing } = input;
  const connectorId = connector.manifest.id;
  const id = existing?.id ?? uuidv7();
  let done: Awaited<ReturnType<typeof completeAuthorization>>;
  try {
    done = await completeAuthorization({
      connector,
      params: input.params,
      session: { tenantId, userId: input.userId },
      origin: input.origin,
      connectionId: id,
      redirectUri: oauthRedirectUri(c, services.env, connectorId),
      stateSecret: stateSecret(services.env),
      cipher: await vaultFor(tx, services.env),
    });
  } catch (error) {
    if (error instanceof OAuthCallbackError) {
      throw new HttpError(400, error.reason, error.message);
    }
    // The sign-in worked but the grant can't be kept (Gmail: send left unticked); nothing stored.
    if (error instanceof SignInRefusedError) {
      throw new HttpError(422, "sign_in_refused", error.message);
    }
    if (error instanceof HttpError) throw error;
    reportHandled(`sign-in to ${connectorId} failed`, error, { connector: connectorId });
    throw new HttpError(
      502,
      "sign_in_failed",
      `${connector.manifest.name} did not complete the sign-in`,
    );
  }
  const values = {
    status: "connected" as const,
    credentialsEncrypted: done.credentials as Record<string, unknown>,
    externalAccountId: done.grant.externalAccountId,
    connectedBy: input.userId,
  };
  if (existing) {
    await tx
      .update(connection)
      .set({ ...values, config: { ...existing.config, ...(done.grant.config ?? {}) } })
      .where(and(eq(connection.id, existing.id), eq(connection.tenantId, tenantId)));
  } else {
    await tx.insert(connection).values({
      id,
      tenantId,
      connector: connectorId,
      permissions: connectionDefaults(connector.manifest),
      config: done.grant.config ?? {},
      ...values,
    });
  }
  await tx.insert(connectionChange).values({
    tenantId,
    connectionId: id,
    actorId: input.userId,
    change: {
      kind: "status",
      by: input.by,
      before: existing?.status ?? null,
      after: "connected",
      account: done.grant.externalAccountId,
    },
  });
  if (connectorId === QBO_CONNECTOR_ID) {
    // The first sync starts as soon as the client is connected (then the cron and webhooks).
    ctx.defer(() =>
      startQboSync(services.db, qboSyncFor(services.deps, services.env), {
        tenantId,
        connectionId: id,
        reason: "connected",
      }),
    );
  }
  return id;
}

async function newestConnection(tx: Tx, tenantId: string, connectorId: string) {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, connectorId)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  return row;
}

export function connectionRoutes(app: Hono<AppEnv>): void {
  // A provider that returns to the API (Gmail, QuickBooks): the same parameters, on to a callback
  // page. Nothing is stored here; the page posts them to a callback route in the person's session.
  // A sign-in the operator started in the back office (a signed `ops` state) goes to the back
  // office's page; every other one to the portal's, as before.
  app.get(API_RETURN_PATH, async (c) => {
    const id = c.req.param("connector") ?? "";
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return c.notFound();
    const url = new URL(c.req.url);
    const page = (await startedInBackOffice(c.env, id, url.searchParams.get("state")))
      ? `/ops/connections/${id}/callback`
      : `/connections/${id}/callback`;
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.redirect(`${page}${url.search}`, 302);
  });

  mount(app, routes.portalAuthorize, async (ctx) => {
    const { c, tx, tenantIds, params, session, services, role } = ctx;
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, params.connector);
    const allowed = mayManage(
      role,
      session.user.id,
      params.connector,
      await newestConnection(tx, tenantId, params.connector),
    );
    if (!allowed.ok) throw new HttpError(403, "forbidden", allowed.message);
    const connector = services.platform.connectors.get(params.connector);
    if (connector?.manifest.auth === "oauth2") {
      if (!canSignIn(connector)) {
        throw new HttpError(
          409,
          "not_available",
          `signing in to ${connector.manifest.name} is not available yet`,
        );
      }
      const { redirectUrl } = await beginAuthorization({
        connector,
        tenantId,
        userId: session.user.id,
        redirectUri: oauthRedirectUri(c, services.env, params.connector),
        stateSecret: stateSecret(services.env),
      });
      return {
        connection: await connectorOut(
          tx,
          tenantId,
          services.platform,
          params.connector,
          session.user.id,
        ),
        redirectUrl,
      };
    }
    const id = await connectNoAuth(tx, {
      tenantId,
      connector: params.connector,
      platform: services.platform,
      actorId: session.user.id,
      by: "client",
    });
    return {
      connection: await connectionOut(tx, tenantId, services.platform, id, session.user.id),
      redirectUrl: null,
    };
  });

  mount(app, routes.portalAuthorizeCallback, async (ctx) => {
    const { tx, tenantIds, params, body, session, services } = ctx;
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, params.connector);
    const connector = oauthConnector(services.platform, params.connector);
    const existing = await newestConnection(tx, tenantId, params.connector);
    const allowed = mayManage(ctx.role, session.user.id, params.connector, existing);
    if (!allowed.ok) throw new HttpError(403, "forbidden", allowed.message);
    const id = await finishSignIn(ctx, {
      tenantId,
      connector,
      params: body.params,
      userId: session.user.id,
      origin: "portal",
      by: "client",
      existing,
    });
    return {
      connection: await connectionOut(tx, tenantId, services.platform, id, session.user.id),
    };
  });

  mount(
    app,
    routes.portalDisconnect,
    async ({ tx, tenantIds, params, session, services, role }) => {
      const tenantId = tenantIds[0] as string;
      const [row] = await tx
        .select()
        .from(connection)
        .where(and(eq(connection.id, params.id), eq(connection.tenantId, tenantId)));
      if (!row) throw notFound("connection");
      // A client user disconnects only a personal account they connected themselves.
      if (
        role !== "client_admin" &&
        !(PERSONAL_CONNECTORS.has(row.connector) && row.connectedBy === session.user.id)
      ) {
        throw new HttpError(403, "forbidden", "your admin disconnects this tool");
      }
      await disconnect(tx, services, row, { actorId: session.user.id, by: "client" });
      return {
        connection: await connectionOut(tx, tenantId, services.platform, row.id, session.user.id),
      };
    },
  );

  // The client admin may, and the person who connected the mailbox (mayManage's rule).
  mount(app, routes.portalGmailTestSend, async ({ c, tx, tenantIds, session, services, role }) => {
    const tenantId = tenantIds[0] as string;
    return sendGmailTest(tx, services, {
      tenantId,
      actorId: session.user.id,
      by: "client",
      allowed: (found) => {
        if (!mayManage(role, session.user.id, GMAIL_CONNECTOR_ID, found).ok) {
          throw new HttpError(
            403,
            "forbidden",
            "only your admin or the person who connected this mailbox can send a test",
          );
        }
      },
      // The reader's language: their own, else the client's, else the browser's.
      locale: (settings) =>
        resolveLocale({
          user: userLanguage(settings, session.user.id),
          client: clientLanguage(settings),
          browser: parseAcceptLanguage(c.req.header("accept-language")),
        }),
    });
  });

  // ── The Sandbox client: the operator's own sign-in (docs/plan.md §1.5) ─────────────────────────

  // DECISION: the operator signs in to OAuth tools only in the Sandbox client, their own test client
  // with no client users, so templates can be test-run against a provider's sandbox account (e.g.
  // the Intuit sandbox company). In a real client the client signs in from the portal (403
  // `not_sandbox` here). Same redirect URIs: the state carries a signed `ops` origin, the forwarder
  // sends it to the back office's page, and only this route completes it.
  mount(app, routes.opsSandboxAuthorize, async (ctx) => {
    const { c, tx, params, services, session } = ctx;
    const t = await sandboxClient(ctx, params.id);
    await offeredTo(tx, t.id, params.connector);
    const connector = oauthConnector(services.platform, params.connector);
    const { redirectUrl } = await beginAuthorization({
      connector,
      tenantId: t.id,
      userId: session.user.id,
      origin: "ops",
      redirectUri: oauthRedirectUri(c, services.env, params.connector),
      stateSecret: stateSecret(services.env),
    });
    return { redirectUrl };
  });

  mount(app, routes.opsSandboxAuthorizeCallback, async (ctx) => {
    const { tx, params, body, session, services } = ctx;
    // The state names the client. Nothing in it counts until its signature holds; then it must be a
    // back-office sign-in to this connector by this operator.
    const state = body.params.state;
    if (!state) throw new HttpError(400, "missing_state", "the callback has no state");
    const read = await readOAuthState(state, { secret: stateSecret(services.env) });
    if (!read.ok) throw new HttpError(400, read.reason, `invalid OAuth state: ${read.reason}`);
    const { claims } = read;
    if (
      claims.origin !== "ops" ||
      claims.connector !== params.connector ||
      claims.userId !== session.user.id
    ) {
      throw new HttpError(400, "mismatch", "invalid OAuth state: mismatch");
    }
    // A client this operator serves (404 otherwise), and the Sandbox (403 otherwise).
    const t = await sandboxClient(ctx, claims.tenantId);
    await offeredTo(tx, t.id, params.connector);
    const connector = oauthConnector(services.platform, params.connector);
    const id = await finishSignIn(ctx, {
      tenantId: t.id,
      connector,
      params: body.params,
      userId: session.user.id,
      origin: "ops",
      by: "operator",
      existing: await newestConnection(tx, t.id, params.connector),
    });
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, id), eq(connection.tenantId, t.id)));
    if (!row) throw notFound("connection");
    return { clientId: t.id, connection: opsConnection(row) };
  });

  // DECISION: the operator sends the same test email from the Sandbox client's Gmail, which they
  // connected themselves (Google's verification video is recorded there), with the same rules; any
  // other client is 403 `not_sandbox`. The back office reads English, so the email is in English.
  // DECISION: the operator disconnects what they connected in the Sandbox client (OAuth tools such
  // as Gmail, QuickBooks, Zoho CRM and Podio, and no-sign-in tools), with the portal's disconnect:
  // revoke at the provider, drop the credentials, record it `by: operator`. In a real client only
  // the client disconnects (403 `not_sandbox` here).
  mount(app, routes.opsSandboxDisconnect, async (ctx) => {
    const { tx, params, services, session } = ctx;
    const t = await sandboxClient(ctx, params.id);
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, params.connectionId), eq(connection.tenantId, t.id)));
    if (!row) throw notFound("connection");
    await disconnect(tx, services, row, { actorId: session.user.id, by: "operator" });
    const [after] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, t.id)));
    if (!after) throw notFound("connection");
    return { connection: opsConnection(after) };
  });

  mount(app, routes.opsSandboxGmailTestSend, async (ctx) => {
    const t = await sandboxClient(ctx, ctx.params.id);
    return sendGmailTest(ctx.tx, ctx.services, {
      tenantId: t.id,
      actorId: ctx.session.user.id,
      by: "operator",
      allowed: () => {},
      locale: () => "en",
    });
  });
}

// DECISION: "Send a test email" (plan §1.31) is a person's own action on their own mailbox, not an
// agent's: it doesn't run through a run or the approval gate, and it can only ever go to the
// connection's own address (the route bodies are strictly empty). At most one a minute per
// connection, counted from the connection's history, where each send is recorded with who sent
// it and Gmail's message id.
async function sendGmailTest(
  tx: Tx,
  services: Services,
  input: {
    tenantId: string;
    actorId: string;
    by: "client" | "operator";
    /** Throws when this session may not send from this connection. */
    allowed: (found: ConnectionRow) => void;
    locale: (settings: Record<string, unknown> | null | undefined) => Locale;
  },
): Promise<{ to: string; sentAt: string }> {
  const { tenantId } = input;
  await offeredTo(tx, tenantId, GMAIL_CONNECTOR_ID);
  const connector = services.platform.connectors.get(GMAIL_CONNECTOR_ID);
  if (!isGmailConnector(connector)) {
    throw new HttpError(409, "not_available", "Gmail is not available here");
  }
  const found = await newestConnection(tx, tenantId, GMAIL_CONNECTOR_ID);
  if (found?.status !== "connected" || !found.credentialsEncrypted) {
    throw new HttpError(409, "not_connected", "Gmail isn't connected");
  }
  input.allowed(found);
  // The row is locked until the send is recorded, so two clicks at once send one email.
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, found.id), eq(connection.tenantId, tenantId)))
    .for("update");
  if (row?.status !== "connected") {
    throw new HttpError(409, "not_connected", "Gmail isn't connected");
  }
  const [recent] = await tx
    .select({ n: count() })
    .from(connectionChange)
    .where(
      and(
        eq(connectionChange.tenantId, tenantId),
        eq(connectionChange.connectionId, row.id),
        sql`${connectionChange.change}->>'kind' = ${GMAIL_TEST_CHANGE}`,
        gt(connectionChange.createdAt, sql`now() - interval '1 minute'`),
      ),
    );
  if ((recent?.n ?? 0) > 0) {
    throw new HttpError(
      429,
      "rate_limited",
      "we sent a test email less than a minute ago; wait a minute and try again",
    );
  }
  if (!row.externalAccountId) {
    throw new HttpError(409, "no_address", "we don't know this mailbox's address; connect again");
  }
  if (!services.env.ENCRYPTION_KEY) {
    throw new HttpError(503, "not_configured", "sending is not set up here yet");
  }

  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const locale = input.locale(t?.settings);
  const words = GMAIL_TEST_WORDS[locale];
  const now = new Date();
  let sent: Awaited<ReturnType<typeof connector.sendToSelf>>;
  try {
    sent = await connector.sendToSelf(
      {
        tenantId,
        connection: refOf(row),
        credentials: await connectionCredentials(tx, services.env, row),
        logger: noopLogger,
        now: () => now,
      },
      { subject: words.subject, text: words.text, key: uuidv7() },
    );
  } catch (error) {
    if (error instanceof GmailNoAddressError || error instanceof MimeError) {
      throw new HttpError(409, "no_address", "we don't know this mailbox's address; connect again");
    }
    if (error instanceof ReconnectRequiredError) {
      throw new HttpError(
        409,
        "not_connected",
        "Google ended this connection; connect Gmail again",
      );
    }
    if (error instanceof GmailNotConfiguredError) {
      throw new HttpError(503, "not_configured", "Gmail sign-in is not set up here yet");
    }
    if (error instanceof GmailApiError) {
      throw new HttpError(502, "connector_failed", error.message);
    }
    reportHandled("Gmail test email failed", error, { connector: GMAIL_CONNECTOR_ID });
    throw new HttpError(502, "connector_failed", "Gmail didn't send the test email");
  }
  await tx.insert(connectionChange).values({
    tenantId,
    connectionId: row.id,
    actorId: input.actorId,
    change: {
      kind: GMAIL_TEST_CHANGE,
      by: input.by,
      to: sent.to,
      gmailMessageId: sent.id,
      threadId: sent.threadId,
      language: locale,
    },
  });
  return { to: sent.to, sentAt: now.toISOString() };
}
