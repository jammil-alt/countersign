// The portal's Connections actions (ARCHITECTURE §6.1 "Who does what", §14): the client admin
// signs in to an offered tool and disconnects it. Only client sessions reach these routes; the
// operator offers connectors and sets matrices from the back office, and never connects a tool on
// a client's behalf. Responses are the portal's connection shape: never credentials.

import { connectionDefaults } from "@countersign/connectors";
import { routes } from "@countersign/core";
import { connection, connectionChange, type Tx, tenant } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, notFound } from "../http";
import type { Platform } from "../platform";
import { offeredConnectors } from "./ops-clients";
import { canSignIn, portalConnections } from "./portal";

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
  if (!connector || !canSignIn(connector.manifest)) {
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

export function connectionRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalAuthorize, async ({ tx, tenantIds, params, session, services }) => {
    const tenantId = tenantIds[0] as string;
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    if (!t) throw notFound("client");
    if (!offeredConnectors(t.settings).includes(params.connector)) {
      throw notFound("connector");
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
      // DECISION: revoking the grant at the provider (Connector.revoke) comes with the first OAuth
      // connector; today's connectors hold no provider grant.
      await tx
        .update(connection)
        .set({ status: "disconnected", credentialsEncrypted: null })
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
