// v0.14 W4-B: Zoho CRM's notifications (docs/plan.md §1.9 "Sync (W4-B)"). The watch the cron renews
// gives Zoho this address and a token made from the deployment's secret and the connection; Zoho
// echoes the token in every notification. Checked in constant time, then a short sync of that
// connection runs after the response. Nothing in the body is stored or trusted beyond the check.

import {
  credentialKeysFromEnv,
  parseZohoNotification,
  verifyZohoNotification,
  ZOHO_NOTIFY_MAX_BYTES,
} from "@countersign/connectors";
import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, errorResponse, HttpError } from "../http";
import { dispatchByIds } from "../runs/dispatch";
import { credentialsFor } from "../runs/execute";
import { runZohoSync, ZOHO_NOTIFY_PAGES, zohoConnectorOf } from "../zoho/sync";

const spec = routes.zohoNotify;

/** Reads at most `limit` bytes; null when the body is bigger. */
async function readBody(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.length > limit ? null : bytes;
}

export function zohoRoutes(app: Hono<AppEnv>): void {
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
      const body = await readBody(c.req.raw, ZOHO_NOTIFY_MAX_BYTES);
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
