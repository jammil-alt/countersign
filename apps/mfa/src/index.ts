// @countersign/mfa: the code service (ARCHITECTURE §6.9, docs/plan.md §1.26), Worker
// `mezonas-codes`. Three ways in, and no others:
//  - `Codes`, a WorkerEntrypoint: the RPC apps/api calls through its `CODES` service binding
//    (core's `CodesService`). Not reachable over HTTP.
//  - `fetch`: Twilio's signed inbound texts, `POST /twilio/sms/:identityId`, and `GET /health`.
//  - `email`: Cloudflare Email Routing's mail for AGENT_EMAIL_DOMAIN.
// It imports @countersign/core only and holds its own key and storage (Durable Objects).

import { Hono } from "hono";
import { identityFromAddress, MAX_EMAIL_BYTES, parseInboundEmail } from "./email";
import type { CodesEnv } from "./env";
import { logEvent } from "./log";
import { EMPTY_TWIML, verifyTwilioSignature } from "./twilio";

export { Directory } from "./directory";
export { Identity } from "./identity";
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

/** What `email()` needs of Cloudflare's ForwardableEmailMessage. */
export interface InboundEmail {
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
}

// DECISION: mail that names no identity, is too large or fails authentication is dropped without a
// bounce (as apps/api's forwarding does): a bounce would tell a guesser which addresses exist.
export async function handleEmail(message: InboundEmail, env: CodesEnv): Promise<string> {
  const domain = env.AGENT_EMAIL_DOMAIN?.trim();
  const identityId = domain ? identityFromAddress(message.to, domain) : null;
  if (!identityId) {
    logEvent("email.dropped", { reason: "unknown_address" });
    return "unknown_address";
  }
  if (message.rawSize > MAX_EMAIL_BYTES) {
    logEvent("email.dropped", { identityId, reason: "too_large" });
    return "too_large";
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const parsed = await parseInboundEmail(raw);
  const stub = env.IDENTITY.get(env.IDENTITY.idFromName(identityId));
  const outcome = await stub.receive({
    channel: "email",
    sender: parsed.from,
    subject: parsed.subject,
    text: parsed.text,
    authenticated: parsed.authenticated,
  });
  logEvent("email.received", {
    identityId,
    outcome: outcome.outcome,
    spf: parsed.auth.spf,
    dkim: parsed.auth.dkim,
    dmarc: parsed.auth.dmarc,
  });
  return outcome.outcome === "ignored" ? outcome.reason : outcome.outcome;
}

export default {
  fetch: app.fetch,
  async email(message, env) {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<CodesEnv>;
