// The code service's incoming mail (ARCHITECTURE §6.9): a message to an identity's address, from
// Cloudflare Email Routing directly (`email()`) or handed on by apps/api (`Codes.receiveEmail`).

import { identityFromAddress, MAX_EMAIL_BYTES, parseInboundEmail } from "./email";
import type { CodesEnv } from "./env";
import { logEvent } from "./log";

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
