// v0.14 W4-B: Zoho CRM's notifications (docs/plan.md §1.9 "Sync (W4-B)"). The watch the cron renews
// gives Zoho this address and a token made from the deployment's secret and the connection; Zoho
// echoes the token in every notification. Checked in constant time, then a short sync of that
// connection runs after the response. Nothing in the body is stored or trusted beyond the check.

import {
  credentialKeysFromEnv,
  noopLogger,
  parseZohoNotification,
  ReconnectRequiredError,
  readZohoFieldCache,
  verifyZohoNotification,
  ZOHO_CRM_CONNECTOR_ID,
  ZOHO_NOTIFY_MAX_BYTES,
  ZohoApiError,
  type ZohoFieldCache,
  zohoFieldCacheStale,
} from "@countersign/connectors";
import { routes } from "@countersign/core";
import { connection } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { readBodyLimited } from "../body";
import { type AppEnv, errorResponse, HttpError, mount, notFound } from "../http";
import { dispatchByIds } from "../runs/dispatch";
import { credentialsFor } from "../runs/execute";
import { connectionCredentials } from "../secrets";
import { zohoFieldsView } from "../zoho/fields";
import {
  refOf,
  runZohoSync,
  storeZohoFieldCache,
  ZOHO_NOTIFY_PAGES,
  zohoConnectorOf,
} from "../zoho/sync";

const spec = routes.zohoNotify;

export function zohoRoutes(app: Hono<AppEnv>): void {
  // docs/plan.md §1.164 step 3: a connection's fields, read from Zoho when asked or a day old, for
  // the back office's sync-fields setup. The operator sees field names and types, never data.
  mount(app, routes.opsZohoFields, async (ctx) => {
    const { tx, params, query, services, tenantIds } = ctx;
    if (!tenantIds.includes(params.id)) throw notFound("client");
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, params.connectionId), eq(connection.tenantId, params.id)));
    if (row?.connector !== ZOHO_CRM_CONNECTOR_ID) throw notFound("connection");
    let cache: ZohoFieldCache | null = readZohoFieldCache(row.syncCursor);
    const connector = zohoConnectorOf(services.platform);
    const now = new Date();
    const due = query.refresh === "true" || zohoFieldCacheStale(cache, now);
    if (
      due &&
      connector &&
      row.status === "connected" &&
      row.credentialsEncrypted &&
      services.env.ENCRYPTION_KEY
    ) {
      try {
        cache = await connector.fieldCache({
          tenantId: row.tenantId,
          connection: refOf(row),
          credentials: await connectionCredentials(tx, services.env, row),
          logger: noopLogger,
          now: () => now,
        });
      } catch (error) {
        if (error instanceof ReconnectRequiredError) {
          throw new HttpError(409, "reconnect", "the client needs to sign in to Zoho again");
        }
        if (error instanceof ZohoApiError) {
          throw new HttpError(502, "zoho_unavailable", `Zoho didn't answer: ${error.message}`);
        }
        throw error;
      }
      await storeZohoFieldCache(tx, { tenantId: row.tenantId, connectionId: row.id }, cache);
    }
    return zohoFieldsView(row, cache);
  });

  app.post(spec.path, async (c) => {
    try {
      const services = c.get("req").services();
      const secret = services.env.OAUTH_STATE_SECRET;
      if (!zohoConnectorOf(services.platform) || !secret || !services.env.ENCRYPTION_KEY) {
        throw new HttpError(503, "not_configured", "Zoho CRM notifications are not set up here");
      }
      const params = spec.params?.safeParse(c.req.param());
      if (!params?.success) throw new HttpError(401, "unauthorized", "unknown notification");
      const { tenantId, connectionId } = params.data;
      const body = await readBodyLimited(c.req.raw, ZOHO_NOTIFY_MAX_BYTES);
      if (!body) throw new HttpError(413, "too_large", "Zoho's notifications are smaller");
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new HttpError(400, "invalid_request", "the body is not JSON");
      }
      const n = parseZohoNotification(json);
      // DECISION: a wrong token, another connection's channel and a body that isn't a notification
      // all answer 401 alike, so the address tells a caller nothing.
      if (!n || !(await verifyZohoNotification(n, { secret, connectionId }))) {
        throw new HttpError(401, "unauthorized", "unknown notification");
      }
      const db = services.db;
      const deps = {
        db,
        platform: services.platform,
        credentials: credentialsFor(db, credentialKeysFromEnv(services.env)),
      };
      // The sync checks the connection is this client's and connected; a mismatch reads nothing.
      c.get("req").deferred.push(() =>
        runZohoSync(
          deps,
          { tenantId, connectionId },
          (ids) => dispatchByIds({ db, instances: services.instances }, tenantId, ids),
          ZOHO_NOTIFY_PAGES,
        ),
      );
      return c.json(spec.response.parse({ accepted: true }));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
