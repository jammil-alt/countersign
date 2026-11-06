// QuickBooks Online's routes (plan M9, ARCHITECTURE §6.2, §14). The paths are the ones registered
// with the Intuit app (docs/operations.md, "Intuit"):
// - `GET /api/connections/qbo/callback`: Intuit sends the client back here after signing in. The
//   generic forwarder in ./connections.ts (shared with Gmail) hands the parameters on to the
//   portal's callback page, which finishes the sign-in (POST /api/connections/qbo/callback).
// - `POST /api/connections/qbo/webhook`: Intuit's signed notifications. Checked, then a sync is
//   started for each connection to a company it names; nothing is processed inline.
// - `POST /api/ops/connections/:id/sync`: the operator starts a sync now.
// The cron starts a sync of every connected QuickBooks every 15 minutes (qboCronTick).

import {
  parseQboWebhook,
  QBO_CONNECTOR_ID,
  QBO_SIGNATURE_HEADER,
  QBO_WEBHOOK_MAX_BYTES,
} from "@countersign/connectors";
import { routes } from "@countersign/core";
import { connection, type Db, tenant, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Bindings } from "../env";
import { type AppDeps, type AppEnv, errorResponse, HttpError, mount, notFound } from "../http";
import { reportHandled } from "../observability/report";
import { type QboSyncInstances, type QboSyncParams, qboSyncInstances } from "../qbo/instances";
import { qboConnectorOf } from "../qbo/sync";
import { claimQboSync, requestQboSync, type SyncAsked, startClaimed } from "../qbo/sync-now";

/** The deployment's QboSyncWorkflow (tests pass memory instances); null where it isn't bound. */
export function qboSyncFor(deps: AppDeps, env: Bindings): QboSyncInstances | null {
  if (deps.qboSync) return deps.qboSync(env);
  return env.QBO_SYNC ? qboSyncInstances(env.QBO_SYNC) : null;
}

/**
 * Asks for a sync of one connection: starts one when none runs, or queues one to run when the
 * running one ends (v0.12 W1-H, ./qbo/sync-now.ts). Null instance where sync isn't bound.
 */
export async function startQboSync(
  db: Db,
  instances: QboSyncInstances | null,
  params: QboSyncParams,
  at = new Date(),
): Promise<SyncAsked> {
  return requestQboSync(db, instances, params, at);
}

/**
 * The connected QuickBooks connections to a company, across clients.
 */
// DECISION: the webhook finds a company's connections by looking in each client in turn (each in
// its own withTenant), not through a global index: no table outside RLS learns which client uses
// which company, and the number of clients is small. A global lookup is the follow-up if it grows.
export async function qboConnectionsFor(
  db: Db,
  realmId: string | null,
): Promise<{ tenantId: string; connectionId: string }[]> {
  const clients = await db.select({ id: tenant.id }).from(tenant);
  const out: { tenantId: string; connectionId: string }[] = [];
  for (const client of clients) {
    const rows = await withTenant(db, client.id, (tx) =>
      tx
        .select({ id: connection.id })
        .from(connection)
        .where(
          and(
            eq(connection.tenantId, client.id),
            eq(connection.connector, QBO_CONNECTOR_ID),
            eq(connection.status, "connected"),
            ...(realmId === null ? [] : [eq(connection.externalAccountId, realmId)]),
          ),
        ),
    );
    for (const r of rows) out.push({ tenantId: client.id, connectionId: r.id });
  }
  return out;
}

/** The cron's minute within each quarter hour for QuickBooks syncs (4, 19, 34, 49). */
export const QBO_CRON_MINUTE = 4;

/** Every 15 minutes: a sync of every connected QuickBooks (CDC since its last sync). */
export async function qboCronTick(
  db: Db,
  instances: QboSyncInstances | null,
  at: Date,
): Promise<number> {
  if (!instances || at.getUTCMinutes() % 15 !== QBO_CRON_MINUTE) return 0;
  let started = 0;
  for (const c of await qboConnectionsFor(db, null)) {
    try {
      const r = await startQboSync(db, instances, { ...c, reason: "cron" }, at);
      if (r.started) started += 1;
    } catch (error) {
      reportHandled("qbo sync did not start", error, { connector: "qbo" });
    }
  }
  return started;
}

async function readBody(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.length > limit ? null : bytes;
}

export function qboRoutes(app: Hono<AppEnv>): void {
  app.post(routes.qboWebhook.path, async (c) => {
    try {
      const services = c.get("req").services();
      const connector = qboConnectorOf(services.platform);
      if (!connector || !c.env.QBO_WEBHOOK_VERIFIER) {
        throw new HttpError(503, "not_configured", "QuickBooks webhooks are not set up here");
      }
      const body = await readBody(c.req.raw, QBO_WEBHOOK_MAX_BYTES);
      if (!body) throw new HttpError(413, "too_large", "QuickBooks notifications are smaller");
      const signature = c.req.header(QBO_SIGNATURE_HEADER) ?? "";
      if (!(await connector.verifyWebhook?.({ [QBO_SIGNATURE_HEADER]: signature }, body))) {
        throw new HttpError(401, "invalid_signature", "the signature does not match");
      }
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new HttpError(400, "invalid_request", "the body is not JSON");
      }
      const companies = parseQboWebhook(json);
      if (!companies) throw new HttpError(400, "invalid_request", "not a QuickBooks notification");
      const instances = qboSyncFor(services.deps, services.env);
      let syncs = 0;
      for (const { realmId } of companies) {
        for (const conn of await qboConnectionsFor(services.db, realmId)) {
          const r = await startQboSync(services.db, instances, { ...conn, reason: "webhook" });
          if (r.started) syncs += 1;
        }
      }
      return c.json(routes.qboWebhook.response.parse({ syncs }));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  mount(
    app,
    routes.opsConnectionSync,
    async ({ c, tx, params, tenantIds, services, afterCommit }) => {
      const [row] = await tx.select().from(connection).where(eq(connection.id, params.id));
      if (!row || !tenantIds.includes(row.tenantId)) throw notFound("connection");
      if (row.connector !== QBO_CONNECTOR_ID) {
        throw new HttpError(409, "not_syncable", "only QuickBooks connections sync");
      }
      if (row.status !== "connected") {
        throw new HttpError(409, "not_connected", `the connection is ${row.status}`);
      }
      const instances = qboSyncFor(services.deps, services.env);
      if (!instances)
        throw new HttpError(503, "not_configured", "QuickBooks sync is not set up here");
      // v0.12 W1-H: claimed in this request's transaction, started once it commits; while a sync
      // runs, one more is queued (202) and the running one starts it when it ends.
      const asked: QboSyncParams = {
        tenantId: row.tenantId,
        connectionId: row.id,
        reason: "operator",
      };
      const claim = await claimQboSync(tx, asked);
      if (claim.kind === "queued") {
        c.status(202);
        return { started: false, queued: true, instanceId: claim.instanceId };
      }
      if (claim.kind === "missing") throw notFound("connection");
      afterCommit(() => startClaimed(services.db, instances, asked, claim.instanceId));
      return { started: true, queued: false, instanceId: claim.instanceId };
    },
  );
}
