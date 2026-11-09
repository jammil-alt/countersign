// Where the Worker's incoming mail goes (docs/operations.md, "Email Routing"). Cloudflare Email
// Routing has one catch-all per zone, so mail for the agent domain (the code service's) reaches this
// Worker with the forwarding domain's: mail to AGENT_EMAIL_DOMAIN is handed to the code service
// through its service binding, everything else is forwarding (./email.ts).

import type { InboundEmail } from "./email";
import type { Bindings } from "./env";

/** The code service's limit (apps/mfa MAX_EMAIL_BYTES): bigger mail isn't read or passed on. */
export const AGENT_EMAIL_MAX_BYTES = 25 * 1024 * 1024;

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/** Mail for the code service, when the recipient is on AGENT_EMAIL_DOMAIN. */
export function isAgentMail(to: string, env: Pick<Bindings, "AGENT_EMAIL_DOMAIN">): boolean {
  const agents = env.AGENT_EMAIL_DOMAIN?.trim().toLowerCase();
  return !!agents && domainOf(to) === agents;
}

// DECISION: mail for the agent domain is never read as forwarding, even when the code service isn't
// bound: it is dropped and logged (without content), as the code service drops what it can't use.
export async function routeEmail(
  message: InboundEmail,
  env: Bindings,
  forward: (message: InboundEmail) => Promise<unknown>,
): Promise<{ to: "codes" | "forwarding"; outcome: string }> {
  if (!isAgentMail(message.to, env)) {
    await forward(message);
    return { to: "forwarding", outcome: "handled" };
  }
  const codes = env.CODES;
  if (!codes?.receiveEmail) {
    console.warn("agent email received but the code service isn't bound; dropped");
    return { to: "codes", outcome: "not_configured" };
  }
  if (message.rawSize > AGENT_EMAIL_MAX_BYTES) {
    console.log("agent email dropped", { reason: "too_large" });
    return { to: "codes", outcome: "too_large" };
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const r = await codes.receiveEmail({ to: message.to, raw });
  return { to: "codes", outcome: r.outcome };
}
