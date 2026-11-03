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

export function connectionRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalAuthorize, async ({ tx, tenantIds, params, session, services }) => {
    const tenantId = tenantIds[0] as string;
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    if (!t) throw notFound("client");
    if (!offeredConnectors(t.settings).includes(params.connector)) {
      throw notFound("connector");
    }
    const connector = services.platform.connectors.get(params.connector);
    if (!connector || !canSignIn(connector.manifest)) {
      throw new HttpError(
        409,
        "not_available",
        `signing in to ${connector?.manifest.name ?? params.connector} is not available yet`,
      );
    }
    // One connection per connector and client: reconnecting reuses the row, so the matrix the
    // client tightened and the agents' bindings stay as they were.
    // DECISION: a client has at most one connection per connector in v1 (the newest row is used).
    const [existing] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, params.connector)))
      .orderBy(desc(connection.createdAt))
      .limit(1);
    let id: string;
    if (existing) {
      id = existing.id;
      if (existing.status !== "connected") {
        await tx
          .update(connection)
          .set({ status: "connected", connectedBy: session.user.id })
          .where(and(eq(connection.id, existing.id), eq(connection.tenantId, tenantId)));
        await tx.insert(connectionChange).values({
          tenantId,
          connectionId: existing.id,
          actorId: session.user.id,
          change: { kind: "status", by: "client", before: existing.status, after: "connected" },
        });
      }
    } else {
      const [row] = await tx
        .insert(connection)
        .values({
          tenantId,
          connector: params.connector,
          status: "connected",
          permissions: connectionDefaults(connector.manifest),
          connectedBy: session.user.id,
        })
        .returning();
      if (!row) throw new Error("connection insert returned nothing");
      id = row.id;
      await tx.insert(connectionChange).values({
        tenantId,
        connectionId: row.id,
        actorId: session.user.id,
        change: { kind: "status", by: "client", before: null, after: "connected" },
      });
    }
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
