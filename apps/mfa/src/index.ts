// @countersign/mfa: the code service (ARCHITECTURE §6.9, docs/plan.md §1.26), Worker
// `mezonas-codes`. Three ways in, and no others:
//  - `Codes`, a WorkerEntrypoint: the RPC apps/api calls through its `CODES` service binding
//    (core's `CodesService`). Not reachable over HTTP.
//  - `fetch`: Twilio's signed inbound texts, `POST /twilio/sms/:identityId`, and `GET /health`.
//  - `email`: Cloudflare Email Routing's mail for AGENT_EMAIL_DOMAIN, when a zone routes it here;
//    usually apps/api passes it on through `Codes.receiveEmail` instead (one catch-all per zone).
// It imports @countersign/core only and holds its own key and storage (Durable Objects).

import { Hono } from "hono";
import type { CodesEnv } from "./env";
import { handleEmail } from "./inbox";
import { logEvent } from "./log";
import { EMPTY_TWIML, verifyTwilioSignature } from "./twilio";

export { Directory } from "./directory";
export { Identity } from "./identity";
export { handleEmail, type InboundEmail } from "./inbox";
export { Codes } from "./service";

const IDENTITY_ID = /^[a-z2-7]{12}$/;

export const app = new Hono<{ Bindings: CodesEnv }>();

app.get("/health", (c) => c.json({ ok: true }));

/**
 * An inbound text to an identity's number. Twilio calls the URL set when the number was bought
 * (`MFA_ORIGIN/twilio/sms/<identity id>`); the signature is checked over MFA_ORIGIN + the path, so
 * neither the identity nor the parameters can be changed in transit.
 */
app.post("/twilio/sms/:identityId", async (c) => {
  const token = c.env.MFA_TWILIO_AUTH_TOKEN;
  const origin = c.env.MFA_ORIGIN?.replace(/\/+$/, "");
  if (!token || !origin) return c.text("not configured", 503);
  const identityId = c.req.param("identityId");
  const body = await c.req.parseBody();
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") params[k] = v;
  const url = new URL(c.req.url);
  const valid = await verifyTwilioSignature({
    authToken: token,
    url: `${origin}${url.pathname}${url.search}`,
    params,
    signature: c.req.header("x-twilio-signature"),
  });
  if (!valid) {
    logEvent("sms.refused", { reason: "bad_signature" });
    return c.text("forbidden", 403);
  }
  // A text for another account's number is not ours, even with a good signature.
  if (c.env.MFA_TWILIO_ACCOUNT_SID && params.AccountSid !== c.env.MFA_TWILIO_ACCOUNT_SID) {
    logEvent("sms.refused", { reason: "other_account" });
    return c.text("forbidden", 403);
  }
  if (IDENTITY_ID.test(identityId)) {
    const stub = c.env.IDENTITY.get(c.env.IDENTITY.idFromName(identityId));
    const outcome = await stub.receive({
      channel: "sms",
      sender: params.From ?? null,
      to: params.To ?? null,
      text: params.Body ?? "",
      authenticated: true,
    });
    logEvent("sms.received", { identityId, outcome: outcome.outcome });
  }
  return c.body(EMPTY_TWIML, 200, { "content-type": "text/xml" });
});

app.all("*", (c) => c.text("not found", 404));

export default {
  fetch: app.fetch,
  async email(message, env) {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<CodesEnv>;
