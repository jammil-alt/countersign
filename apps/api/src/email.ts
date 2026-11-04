// The Worker's `email()` handler (ARCHITECTURE §6.5): Cloudflare Email Routing delivers mail sent to
// any address on EMAIL_FORWARDING_DOMAIN here. packages/documents decides what to keep (exact
// client address, allowed sender, PDF and image attachments, headers only); this file reads the
// message, dispatches the events after commit and starts the background reading.

import { ContentStore, MAX_FORWARDED_BYTES } from "@countersign/connectors";
import { type ForwardingOutcome, receiveForwardedEmail } from "@countersign/documents";
import type { Bindings } from "./env";
import { type AppDeps, defaultDeps, type Services } from "./http";
import { extractInBackground } from "./routes/documents";
import { dispatchEvents } from "./runs/dispatch";

/** What `email()` needs of Cloudflare's ForwardableEmailMessage. */
export interface InboundEmail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
}

// DECISION: dropped mail is never bounced (setReject): a bounce would tell a guesser which
// addresses exist and which senders are allowed. It is counted on the client's upload connection
// and logged without its content.
export async function handleEmail(
  message: InboundEmail,
  env: Bindings,
  waitUntil: (p: Promise<unknown>) => void,
  deps: AppDeps = defaultDeps,
): Promise<ForwardingOutcome | null> {
  const domain = env.EMAIL_FORWARDING_DOMAIN?.trim();
  if (!domain) {
    console.warn("email received but EMAIL_FORWARDING_DOMAIN is not set; dropped");
    return null;
  }
  const { db, close } = deps.openDb(env);
  let closeLater = false;
  try {
    // Over the limit: not read at all; packages/documents drops it by its size.
    const raw =
      message.rawSize > MAX_FORWARDED_BYTES
        ? new Uint8Array(0)
        : new Uint8Array(await new Response(message.raw).arrayBuffer());
    const content = new ContentStore(deps.objects(env));
    const outcome = await receiveForwardedEmail(
      { db, content },
      { from: message.from, to: message.to, raw, size: message.rawSize },
      { domain },
    );
    if (outcome.status === "dropped") {
      console.log(`forwarded email dropped: ${outcome.reason}`, { tenantId: outcome.tenantId });
      return outcome;
    }
    const services = { db, env, deps } as Pick<Services, "db" | "env" | "deps">;
    const fresh = outcome.documents.filter((d) => d.created).map((d) => d.id);
    closeLater = true;
    waitUntil(
      (async () => {
        try {
          await dispatchEvents({ db, instances: deps.instances(env) }, outcome.events);
          await extractInBackground(services, outcome.tenantId, fresh);
        } finally {
          await close();
        }
      })(),
    );
    return outcome;
  } finally {
    if (!closeLater) await close();
  }
}
