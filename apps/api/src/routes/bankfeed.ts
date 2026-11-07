// v0.12 bankfeed: Plaid's webhook (ARCHITECTURE §6.11, docs/plan.md §1.52).
// `POST /api/connections/bankfeed/webhook/:tenantId`: the URL each client's Link token names, so
// the client is in the path and the lookup is scoped to it (withTenant), like inbound hooks. No
// session: the `Plaid-Verification` JWT is the credential, checked by the connector (ES256 with
// Plaid's key, `iat` at most 5 minutes old, the body's SHA-256) before the body is read. A sync is
// started after the response; an item error marks the connection for reconnecting.

import { dbConnectionAttention } from "@countersign/agents";
import {
  BANKFEED_CONNECTOR_ID,
  credentialKeysFromEnv,
  isBankfeedConnector,
  PLAID_VERIFICATION_HEADER,
  PLAID_WEBHOOK_MAX_BYTES,
  PlaidWebhookBody,
  plaidWebhookAction,
} from "@countersign/connectors";
import { routes } from "@countersign/core";
import { connection, withTenant } from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { syncBankfeedItem } from "../bankfeed/sync";
import { type AppEnv, errorResponse, HttpError } from "../http";
import { reportHandled } from "../observability/report";
import { dispatchEvents, senseEmitter } from "../runs/dispatch";
import { credentialsFor } from "../runs/execute";

const spec = routes.bankfeedWebhook;
const Params = z.object({ tenantId: z.uuid() });

/** Reads at most `limit + 1` bytes, so an oversized body is refused without reading it all. */
async function readBody(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function bankfeedRoutes(app: Hono<AppEnv>): void {
  app.post(spec.path, async (c) => {
    try {
      const params = Params.safeParse(c.req.param());
      if (!params.success) throw new HttpError(401, "unauthorized", "not a Plaid webhook");
      const { tenantId } = params.data;
      const services = c.get("req").services();
      const connector = services.platform.connectors.get(BANKFEED_CONNECTOR_ID);
      if (!isBankfeedConnector(connector) || !connector.isConfigured?.()) {
        throw new HttpError(503, "not_configured", "bank feeds are not set up here");
      }
      const body = await readBody(c.req.raw, PLAID_WEBHOOK_MAX_BYTES);
      if (!body) throw new HttpError(413, "too_large", "Plaid's webhooks are smaller");
      const jwt = c.req.header(PLAID_VERIFICATION_HEADER) ?? "";
      if (!(await connector.verifyWebhook?.({ [PLAID_VERIFICATION_HEADER]: jwt }, body))) {
        throw new HttpError(
          401,
          "invalid_signature",
          "the Plaid-Verification header doesn't match",
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new HttpError(400, "invalid_request", "the body is not JSON");
      }
      const parsed = PlaidWebhookBody.safeParse(json);
      if (!parsed.success) throw new HttpError(400, "invalid_request", "not a Plaid webhook");
      const action = plaidWebhookAction(parsed.data);
      const respond = (outcome: "sync" | "attention" | "ignored") =>
        c.json(spec.response.parse({ outcome }));
      if (action.kind === "ignore") return respond("ignored");

      // The item must be one of this client's bank feeds; an unknown one is acknowledged and left.
      const [row] = await withTenant(services.db, tenantId, (tx) =>
        tx
          .select({ id: connection.id, status: connection.status })
          .from(connection)
          .where(
            and(
              eq(connection.tenantId, tenantId),
              eq(connection.connector, BANKFEED_CONNECTOR_ID),
              eq(connection.externalAccountId, action.itemId),
            ),
          )
          .limit(1),
      );
      if (!row || row.status === "disconnected") return respond("ignored");

      if (action.kind === "attention") {
        const events: EventRow[] = [];
        await dbConnectionAttention(services.db, {
          emit: senseEmitter(services.platform.events, { collect: events }),
        }).needsAttention(tenantId, {
          connectionId: row.id,
          reason: "signin_expired",
          detail: `Plaid: ${action.code.slice(0, 64)}`,
        });
        if (events.length > 0) {
          c.get("req").deferred.push(() =>
            dispatchEvents({ db: services.db, instances: services.instances }, events),
          );
        }
        return respond("attention");
      }

      if (!services.env.ENCRYPTION_KEY) {
        throw new HttpError(503, "not_configured", "account logins can't be read here");
      }
      const at = new Date();
      const itemId = action.itemId;
      c.get("req").deferred.push(async () => {
        try {
          const out = await syncBankfeedItem(
            {
              db: services.db,
              platform: services.platform,
              credentials: credentialsFor(services.db, credentialKeysFromEnv(services.env)),
            },
            tenantId,
            itemId,
            at,
          );
          if (out.events.length > 0) {
            await dispatchEvents({ db: services.db, instances: services.instances }, out.events);
          }
        } catch (error) {
          reportHandled("bank feed sync failed", error, { connector: BANKFEED_CONNECTOR_ID });
        }
      });
      return respond("sync");
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
