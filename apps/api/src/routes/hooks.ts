// Inbound webhooks (ARCHITECTURE §6.6): `POST /api/hooks/:tenantId/:hookId` from Zapier, Make, n8n
// or anything that can POST. No session: the hook's secret (token or signature) is the credential.
// The delivery is checked, stored once as a raw record and emitted as `webhook.received` in one
// transaction for its one client; the event is dispatched after the response, so workflows start
// the same way as for any other sense. The body is the sender's data, never instructions
// (invariant 9): it reaches steps only as the trigger payload.

import {
  DELIVERIES_PER_MINUTE,
  deliveryKey,
  deliveryText,
  parseDelivery,
  readWebhookConfig,
  readWebhookCredentials,
  verifyDelivery,
  WEBHOOK_CONNECTOR_ID,
  WEBHOOK_DELIVERY_ENTITY,
  WEBHOOK_RECEIVED_EVENT,
  type WebhookReceivedPayload,
} from "@countersign/connectors";
import { routes } from "@countersign/core";
import { connection, rawRecord, withTenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, count, eq, gt, like, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, errorResponse, HttpError } from "../http";
import { dispatchEvents } from "../runs/dispatch";
import { connectionCredentials } from "../secrets";

const spec = routes.inboundHook;
const Params = z.object({ tenantId: z.uuid(), hookId: z.uuid() });

/** Reads at most `limit + 1` bytes, so an oversized body is refused without reading it all. */
async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return new Uint8Array(limit + 1);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > limit) {
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function refused(r: { status: number; code: string; message: string }): HttpError {
  return new HttpError(r.status as HttpError["status"], r.code, r.message);
}

export function hookRoutes(app: Hono<AppEnv>): void {
  app.post(spec.path, async (c) => {
    try {
      const params = Params.safeParse(c.req.param());
      // Unknown and malformed hooks get the same answer as a wrong token: nothing to probe.
      if (!params.success) throw new HttpError(401, "unauthorized", "unknown hook or wrong token");
      const { tenantId, hookId } = params.data;
      const services = c.get("req").services();
      const now = new Date();
      const bytes = await readBody(c.req.raw, 64 * 1024);
      const text = deliveryText(bytes);
      if (!text.ok) throw refused(text);
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      const collect: EventRow[] = [];
      const result = await withTenant(services.db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(connection)
          .where(
            and(
              eq(connection.tenantId, tenantId),
              eq(connection.connector, WEBHOOK_CONNECTOR_ID),
              eq(connection.status, "connected"),
              sql`${connection.config} -> 'hooks' @> ${JSON.stringify([{ id: hookId }])}::jsonb`,
            ),
          )
          .limit(1);
        const hook = row
          ? readWebhookConfig(row.config).hooks.find((h) => h.id === hookId)
          : undefined;
        if (!row || !hook) throw new HttpError(401, "unauthorized", "unknown hook or wrong token");
        const creds = readWebhookCredentials(
          await (await connectionCredentials(tx, services.env, row)).get(),
        );
        const verified = await verifyDelivery({
          token: creds.tokens[hookId],
          headers,
          queryToken: c.req.query("token"),
          body: text.text,
          now,
        });
        if (!verified.ok) throw refused(verified);

        // DECISION: the rate limit counts this hook's stored deliveries in the last minute; no
        // counter table, and duplicates (stored nothing) don't count.
        const [recent] = await tx
          .select({ n: count() })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, row.id),
              eq(rawRecord.entityType, WEBHOOK_DELIVERY_ENTITY),
              like(rawRecord.externalId, `${hookId}:%`),
              gt(rawRecord.syncedAt, new Date(now.getTime() - 60_000)),
            ),
          );
        if ((recent?.n ?? 0) >= DELIVERIES_PER_MINUTE) {
          throw new HttpError(
            429,
            "rate_limited",
            `at most ${DELIVERIES_PER_MINUTE} deliveries a minute per hook`,
          );
        }

        const parsed = parseDelivery(headers["content-type"], text.text);
        if (!parsed.ok) throw refused(parsed);
        const key = await deliveryKey(headers, bytes);
        const externalId = `${hookId}:${key}`;
        const [stored] = await tx
          .insert(rawRecord)
          .values({
            tenantId,
            connectionId: row.id,
            connector: WEBHOOK_CONNECTOR_ID,
            entityType: WEBHOOK_DELIVERY_ENTITY,
            externalId,
            externalVersion: null,
            payload: {
              hookId,
              format: parsed.format,
              signed: verified.signed,
              contentType: headers["content-type"] ?? null,
              data: parsed.data,
            },
            syncedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: rawRecord.id });
        if (!stored) {
          // Sent before: acknowledged, nothing stored, nothing started.
          const [first] = await tx
            .select({ id: rawRecord.id })
            .from(rawRecord)
            .where(
              and(
                eq(rawRecord.tenantId, tenantId),
                eq(rawRecord.connectionId, row.id),
                eq(rawRecord.entityType, WEBHOOK_DELIVERY_ENTITY),
                eq(rawRecord.externalId, externalId),
              ),
            );
          return { status: "duplicate" as const, id: first?.id ?? "" };
        }
        const payload: WebhookReceivedPayload = {
          connectionId: row.id,
          hookId,
          hookName: hook.name,
          rawRecordId: stored.id,
          format: parsed.format,
          signed: verified.signed,
          receivedAt: now.toISOString(),
          data: parsed.data,
        };
        const ev = await emit(
          tx,
          {
            tenantId,
            type: WEBHOOK_RECEIVED_EVENT,
            subjectType: "raw_record",
            subjectId: stored.id,
            payload,
          },
          { registry: services.platform.events },
        );
        if (ev) collect.push(ev);
        return { status: "accepted" as const, id: stored.id };
      });
      if (collect.length > 0) {
        c.get("req").deferred.push(() =>
          dispatchEvents({ db: services.db, instances: services.instances }, collect),
        );
      }
      return c.json(spec.response.parse(result), result.status === "accepted" ? 202 : 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
