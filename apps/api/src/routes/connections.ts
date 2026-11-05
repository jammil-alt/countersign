// The portal's Connections actions (ARCHITECTURE §6.1 "Who does what", §14): the client admin
// signs in to an offered tool and disconnects it. Only client sessions reach these routes; the
// operator offers connectors and sets matrices from the back office, and never connects a tool on
// a client's behalf. Responses are the portal's connection shape: never credentials.

import {
  beginAuthorization,
  type ConnectionRef,
  completeAuthorization,
  connectionDefaults,
  noopLogger,
  OAuthCallbackError,
  QBO_CONNECTOR_ID,
} from "@countersign/connectors";
import { routes, uuidv7 } from "@countersign/core";
import { connection, connectionChange, type Tx, tenant } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Bindings } from "../env";
import { type AppContext, type AppEnv, HttpError, mount, notFound } from "../http";
import type { Platform } from "../platform";
import { connectionCredentials, vaultFor } from "../secrets";
import { offeredConnectors } from "./ops-clients";
import { canSignIn, portalConnections } from "./portal";
import { qboSyncFor, startQboSync } from "./qbo";

async function connectionOut(tx: Tx, tenantId: string, platform: Platform, id: string) {
  const [out] = await portalConnections(tx, tenantId, platform, id);
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
async function connectorOut(tx: Tx, tenantId: string, platform: Platform, connectorId: string) {
  const all = await portalConnections(tx, tenantId, platform);
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
// DECISION: QuickBooks is the exception: the Intuit app has `/api/connections/qbo/callback`
// registered (ARCHITECTURE §14), and that route forwards to the same portal page (routes/qbo.ts).
export function oauthRedirectUri(c: AppContext, env: Bindings, connectorId: string): string {
  const origin = (env.APP_ORIGIN?.trim() || new URL(c.req.url).origin).replace(/\/+$/, "");
  if (connectorId === QBO_CONNECTOR_ID) return `${origin}/api/connections/qbo/callback`;
  return `${origin}/connections/${connectorId}/callback`;
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
  mount(app, routes.portalAuthorize, async ({ c, tx, tenantIds, params, session, services }) => {
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, params.connector);
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
        connection: await connectorOut(tx, tenantId, services.platform, params.connector),
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
      connection: await connectionOut(tx, tenantId, services.platform, id),
      redirectUrl: null,
    };
  });

  mount(app, routes.portalAuthorizeCallback, async (ctx) => {
    const { c, tx, tenantIds, params, body, session, services, defer } = ctx;
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, params.connector);
    const connector = services.platform.connectors.get(params.connector);
    if (connector?.manifest.auth !== "oauth2" || !canSignIn(connector)) {
      throw new HttpError(409, "not_available", "signing in to that tool is not available");
    }
    const existing = await newestConnection(tx, tenantId, params.connector);
    const id = existing?.id ?? uuidv7();
    let done: Awaited<ReturnType<typeof completeAuthorization>>;
    try {
      done = await completeAuthorization({
        connector,
        params: body.params,
        session: { tenantId, userId: session.user.id },
        connectionId: id,
        redirectUri: oauthRedirectUri(c, services.env, params.connector),
        stateSecret: stateSecret(services.env),
        cipher: await vaultFor(tx, services.env),
      });
    } catch (error) {
      if (error instanceof OAuthCallbackError) {
        throw new HttpError(400, error.reason, error.message);
      }
      if (error instanceof HttpError) throw error;
      console.error(`sign-in to ${params.connector} failed`, error);
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
      connectedBy: session.user.id,
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
        connector: params.connector,
        permissions: connectionDefaults(connector.manifest),
        config: done.grant.config ?? {},
        ...values,
      });
    }
    await tx.insert(connectionChange).values({
      tenantId,
      connectionId: id,
      actorId: session.user.id,
      change: {
        kind: "status",
        by: "client",
        before: existing?.status ?? null,
        after: "connected",
        account: done.grant.externalAccountId,
      },
    });
    if (params.connector === QBO_CONNECTOR_ID) {
      // The first sync starts as soon as the client is connected (then the cron and webhooks).
      defer(() =>
        startQboSync(qboSyncFor(services.deps, services.env), {
          tenantId,
          connectionId: id,
          reason: "connected",
        }),
      );
    }
    return { connection: await connectionOut(tx, tenantId, services.platform, id) };
  });

  mount(app, routes.portalDisconnect, async ({ tx, tenantIds, params, session, services }) => {
    const tenantId = tenantIds[0] as string;
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, params.id), eq(connection.tenantId, tenantId)));
    if (!row) throw notFound("connection");
    if (row.status !== "disconnected") {
      // The credentials go; the row, its matrix and its history stay (bindings keep pointing at
      // it, so reconnecting puts the agents back to work).
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
        actorId: session.user.id,
        change: { kind: "status", by: "client", before: row.status, after: "disconnected" },
      });
    }
    return { connection: await connectionOut(tx, tenantId, services.platform, row.id) };
  });
}
