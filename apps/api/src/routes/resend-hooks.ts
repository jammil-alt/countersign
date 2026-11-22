// Resend's webhook (docs/plan.md §1.220, C7): `POST /api/hooks/resend`, public, signed the way Svix
// signs (`@countersign/connectors` resend/webhook.ts). The signature is checked over the raw body
// before anything is parsed; anything unsigned is 400 with nothing to probe. A verified event about
// one of our onboarding emails is logged on its intake (../onboarding/delivery.ts); every other
// event is acknowledged, so Resend stops retrying it.

import {
  RESEND_WEBHOOK_ID_HEADER,
  RESEND_WEBHOOK_MAX_BYTES,
  RESEND_WEBHOOK_SIGNATURE_HEADER,
  RESEND_WEBHOOK_TIMESTAMP_HEADER,
  ResendWebhookEvent,
  verifyResendSignature,
} from "@countersign/connectors";
import { welcomeRoutes } from "@countersign/core";
import type { Hono } from "hono";
import { readTextLimited } from "../body";
import { type AppEnv, errorResponse, HttpError } from "../http";
import { applyResendEvent } from "../onboarding/delivery";

export function resendHookRoutes(app: Hono<AppEnv>): void {
  app.post(welcomeRoutes.resendEvents.path, async (c) => {
    try {
      const secret = c.env.RESEND_WEBHOOK_SECRET?.trim();
      if (!secret) {
        throw new HttpError(503, "not_configured", "Resend's webhook secret is not set");
      }
      // The signature covers the body exactly as sent: read it as text, parse after.
      const payload = await readTextLimited(c.req.raw, RESEND_WEBHOOK_MAX_BYTES);
      if (payload === null) {
        throw new HttpError(413, "too_large", "Resend's events are smaller than this");
      }
      const verified = await verifyResendSignature({
        payload,
        headers: {
          id: c.req.header(RESEND_WEBHOOK_ID_HEADER) ?? null,
          timestamp: c.req.header(RESEND_WEBHOOK_TIMESTAMP_HEADER) ?? null,
          signature: c.req.header(RESEND_WEBHOOK_SIGNATURE_HEADER) ?? null,
        },
        secret,
        now: new Date(),
      });
      if (!verified.ok) {
        throw new HttpError(400, "invalid_signature", `the signature is ${verified.reason}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        throw new HttpError(400, "invalid_request", "the body is not JSON");
      }
      const event = ResendWebhookEvent.safeParse(json);
      if (!event.success) throw new HttpError(400, "invalid_request", "not a Resend event");
      const { db } = c.get("req").services();
      const answer = await applyResendEvent(db, event.data);
      return c.json(welcomeRoutes.resendEvents.response.parse({ received: true, ...answer }));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
