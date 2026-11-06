// v0.14 W4-E: Google Chat's routes (docs/plan.md §1.60, ARCHITECTURE §6.11 row 8).
// - `POST /api/hooks/gchat`: Google Chat's events to the Mezonas app, public. The bearer token
//   (signed by Chat for our project number) is verified before the body is read; anything else is
//   401 with nothing to probe. The answer is immediate: one fixed line in the space, or nothing.
// - `GET /api/connections/:id/gchat`, `POST …/code`, `DELETE …/spaces/:spaceId`: the client
//   admin's card: the bound spaces, a one-time code (shown once), and disconnecting a space.

import { CHAT_EVENT_MAX_BYTES, GCHAT_CONNECTOR_ID, parseChatEvent } from "@countersign/connectors";
import { routes } from "@countersign/core";
import type { Hono } from "hono";
import {
  gchatConnection,
  gchatView,
  handleChatEvent,
  makeCode,
  unbindFromPortal,
} from "../gchat/spaces";
import { type AppEnv, errorResponse, HttpError, mount } from "../http";
import { reportHandled } from "../observability/report";

async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) throw new HttpError(413, "too_large", "the event is too large");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > limit) throw new HttpError(413, "too_large", "the event is too large");
  return bytes;
}

export function gchatRoutes(app: Hono<AppEnv>): void {
  app.post(routes.gchatEvents.path, async (c) => {
    try {
      const services = c.get("req").services();
      const connector = services.platform.connectors.get(GCHAT_CONNECTOR_ID);
      if (!connector?.verifyWebhook || connector.isConfigured?.() === false) {
        throw new HttpError(503, "not_configured", "Google Chat is not set up here");
      }
      // The token first: nothing of the request is read before it holds.
      const ok = await connector.verifyWebhook(
        { authorization: c.req.header("authorization") ?? "" },
        new Uint8Array(),
      );
      if (!ok) throw new HttpError(401, "unauthorized", "not a request from Google Chat");
      const body = await readBody(c.req.raw, CHAT_EVENT_MAX_BYTES);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new HttpError(400, "invalid_request", "the body is not JSON");
      }
      const event = parseChatEvent(json);
      if (!event) throw new HttpError(400, "invalid_request", "not a Google Chat event");
      let answer: { text?: string };
      try {
        answer = await handleChatEvent(services.db, services.env, event);
      } catch (error) {
        // Chat shows its own error for a failed answer; ours is reported, never echoed.
        reportHandled("google chat event failed", error, { connector: GCHAT_CONNECTOR_ID });
        throw new HttpError(500, "internal", "something went wrong");
      }
      return c.json(routes.gchatEvents.response.parse(answer));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  mount(app, routes.portalGchat, async ({ tx, tenantIds, params, services }) => {
    const row = await gchatConnection(tx, tenantIds[0] as string, params.id);
    return gchatView(tx, services.env, row);
  });

  mount(app, routes.portalGchatCode, async ({ tx, tenantIds, params, session, services }) => {
    const row = await gchatConnection(tx, tenantIds[0] as string, params.id);
    const connector = services.platform.connectors.get(GCHAT_CONNECTOR_ID);
    if (connector?.isConfigured?.() === false) {
      throw new HttpError(409, "not_available", "Google Chat is not available yet");
    }
    const made = await makeCode(tx, services.env, row, session.user.id);
    return gchatView(tx, services.env, row, made.code);
  });

  mount(app, routes.portalGchatUnbind, async ({ tx, tenantIds, params, session, services }) => {
    const row = await gchatConnection(tx, tenantIds[0] as string, params.id);
    const next = await unbindFromPortal(tx, row, `spaces/${params.spaceId}`, session.user.id);
    return gchatView(tx, services.env, next);
  });
}
