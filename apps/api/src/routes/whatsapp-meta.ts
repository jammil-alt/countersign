// v0.14 W4-A: WhatsApp through Meta's routes (docs/plan.md §1.57).
// - `GET /api/hooks/whatsapp_meta`: Meta's subscription handshake: `hub.challenge` echoed as
//   text/plain when `hub.mode` is `subscribe` and `hub.verify_token` is ours (compared in constant
//   time); 403 otherwise; 503 while the deployment has no Meta app.
// - `POST /api/hooks/whatsapp_meta`: Meta's deliveries. The body is read once, as bytes, up to a
//   limit, and `X-Hub-Signature-256` (HMAC-SHA256 under the app secret) is checked over those
//   bytes before any parse or query: 401 with nothing to probe otherwise. Then each message and
//   status goes to the client whose number it came to (whatsapp-meta/inbound.ts). A failure is
//   answered 500 so Meta retries the delivery (each message is stored once, so a retry only does
//   what is missing); 503 while unconfigured.
// - `PUT /api/ops/clients/:id/messaging/whatsapp-groups`: the operator turns group messages on or
//   off for a client (off by default), with a reason, logged as a `tenant_change`.

import {
  META_SIGNATURE_HEADER,
  parseMetaWebhook,
  verifyMetaChallenge,
  verifyMetaSignature,
  WHATSAPP_META_CONNECTOR_ID,
} from "@countersign/connectors";
import { isPlainObject, routes } from "@countersign/core";
import { tenant, tenantChange, withTenant } from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { CaptureParams } from "../conversations/media";
import { captureDepsFor, captureJobsFor } from "../conversations/start";
import { type AppEnv, ensureClient, errorResponse, HttpError, mount, notFound } from "../http";
import { dispatchEvents } from "../runs/dispatch";
import { type InboundReply, replyDepsFromEnv, sendReplies } from "../triggers/replies";
import {
  type MetaRoute,
  metaRouteFor,
  receiveMetaMessage,
  receiveMetaStatus,
} from "../whatsapp-meta/inbound";

/** Meta's deliveries are small; a larger body is refused unread. */
export const META_WEBHOOK_MAX_BYTES = 3 * 1024 * 1024;

/** The deployment's Meta app, or null (503) when any part is missing. */
function metaApp(c: Context<AppEnv>) {
  const services = c.get("req").services();
  const connector = services.platform.connectors.get(WHATSAPP_META_CONNECTOR_ID);
  const secret = services.env.META_APP_SECRET?.trim();
  const verifyToken = services.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  if (!connector || !secret || !verifyToken) return null;
  return { services, secret, verifyToken };
}

const notConfigured = () =>
  new HttpError(503, "not_configured", "WhatsApp through Meta is not set up here");

/**
 * The body as bytes, read in chunks and never past `limit` (null when it is longer): the declared
 * length is checked first, and the count while reading, so nothing larger is ever held.
 */
export async function readBodyLimited(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function whatsappMetaRoutes(app: Hono<AppEnv>): void {
  app.get(routes.metaWebhookVerify.path, (c) => {
    try {
      const meta = metaApp(c);
      if (!meta) throw notConfigured();
      const challenge = verifyMetaChallenge({
        mode: c.req.query("hub.mode"),
        token: c.req.query("hub.verify_token"),
        challenge: c.req.query("hub.challenge"),
        verifyToken: meta.verifyToken,
      });
      if (challenge === null) throw new HttpError(403, "forbidden", "the verify token is wrong");
      c.header("cache-control", "no-store");
      return c.text(challenge, 200, { "content-type": "text/plain; charset=utf-8" });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(routes.metaWebhook.path, async (c) => {
    try {
      const meta = metaApp(c);
      if (!meta) throw notConfigured();
      const { services } = meta;
      // The raw bytes, once; the signature over them before anything is parsed or queried.
      const raw = await readBodyLimited(c.req.raw, META_WEBHOOK_MAX_BYTES);
      if (!raw) throw new HttpError(413, "too_large", "the delivery is too large");
      const signed = await verifyMetaSignature({
        rawBody: raw,
        header: c.req.header(META_SIGNATURE_HEADER),
        appSecret: meta.secret,
      });
      if (!signed) throw new HttpError(401, "invalid_signature", "the signature does not match");
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        throw new HttpError(400, "invalid_request", "the body is not JSON");
      }
      const delivery = parseMetaWebhook(json);
      // DECISION: a signed delivery that isn't a WhatsApp Business Account's (another product of
      // our app) is acknowledged and left alone: retrying it would not help.
      if (!delivery) return c.json(routes.metaWebhook.response.parse({ ok: true }));

      const now = new Date();
      const routesByNumber = new Map<string, MetaRoute | null>();
      const routeOf = async (phoneNumberId: string) => {
        if (!routesByNumber.has(phoneNumberId)) {
          routesByNumber.set(phoneNumberId, await metaRouteFor(services.db, phoneNumberId));
        }
        return routesByNumber.get(phoneNumberId) ?? null;
      };
      const ctx = { registry: services.platform.events, now };
      const events: EventRow[] = [];
      const captures: CaptureParams[] = [];
      const replies: { tenantId: string; replies: InboundReply[] }[] = [];
      for (const msg of delivery.messages) {
        // Routed by the number it came to; a number no client has is ignored.
        const route = await routeOf(msg.phoneNumberId);
        if (!route) continue;
        const got = await withTenant(services.db, route.tenantId, (tx) =>
          receiveMetaMessage(tx, route, msg, ctx),
        );
        events.push(...got.events);
        if (got.capture) captures.push(got.capture);
        if (got.replies.length) replies.push({ tenantId: route.tenantId, replies: got.replies });
      }
      for (const st of delivery.statuses) {
        const route = await routeOf(st.phoneNumberId);
        if (!route) continue;
        events.push(
          ...(await withTenant(services.db, route.tenantId, (tx) =>
            receiveMetaStatus(tx, route, st, ctx),
          )),
        );
      }

      const deferred = c.get("req").deferred;
      if (events.length > 0) {
        deferred.push(() =>
          dispatchEvents({ db: services.db, instances: services.instances }, events),
        );
      }
      // The attachments are fetched after the commit, as durable jobs (plan §1.55).
      for (const params of captures) {
        deferred.push(() =>
          captureJobsFor(
            services.env,
            captureDepsFor({
              db: services.db,
              env: services.env,
              deps: services.deps,
              platform: services.platform,
            }),
          ).start(params),
        );
      }
      for (const r of replies) {
        deferred.push(() =>
          sendReplies(
            services.db,
            r.tenantId,
            replyDepsFromEnv(services.env, services.deps.fetch?.(services.env)),
            r.replies,
          ),
        );
      }
      return c.json(routes.metaWebhook.response.parse({ ok: true }));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  mount(app, routes.opsWhatsappGroups, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const [t] = await ctx.tx.select().from(tenant).where(eq(tenant.id, tenantId));
    if (!t) throw notFound("client");
    const settings = isPlainObject(t.settings) ? t.settings : {};
    const messaging = isPlainObject(settings.messaging) ? settings.messaging : {};
    const before = messaging.whatsappGroups === true;
    if (before === ctx.body.enabled) throw new HttpError(409, "no_op", "nothing changed");
    await ctx.tx
      .update(tenant)
      .set({
        settings: { ...settings, messaging: { ...messaging, whatsappGroups: ctx.body.enabled } },
      })
      .where(eq(tenant.id, tenantId));
    await ctx.tx.insert(tenantChange).values({
      tenantId,
      actorId: ctx.session.user.id,
      change: { setting: "messaging.whatsappGroups", from: before, to: ctx.body.enabled },
      reason: ctx.body.reason,
    });
    return { enabled: ctx.body.enabled };
  });
}
