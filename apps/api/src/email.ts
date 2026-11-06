// The Worker's `email()` handler (ARCHITECTURE §6.5): Cloudflare Email Routing delivers mail sent to
// any address on EMAIL_FORWARDING_DOMAIN here. packages/documents decides what to keep (exact
// client address, allowed sender, PDF and image attachments, headers only); this file reads the
// message, dispatches the events after commit and starts the background reading.

import { ContentStore, MAX_FORWARDED_BYTES } from "@countersign/connectors";
import {
  type ForwardingOutcome,
  isVoiceSampleAddress,
  receiveForwardedEmail,
  receiveVoiceSampleEmail,
} from "@countersign/documents";
import { receiveReleaseEmail, wakeRelease } from "./access/release";
import type { Bindings } from "./env";
import { type AppDeps, defaultDeps, type Services } from "./http";
import { forwardingAddress, receiveReachOutReply, wakeAll } from "./reach/replies";
import { extractInBackground } from "./routes/documents";
import { dispatchEvents } from "./runs/dispatch";
// v0.12 W2-E: agent addresses
import { receiveAgentEmail } from "./triggers/inbound-email";
import { replyDepsFromEnv, sendReplies } from "./triggers/replies";

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
    // A reply to a human release email (its `+rel…` tag) carries a code: consumed here, never
    // forwarded or stored (docs/plan.md §1.26).
    const release = await receiveReleaseEmail(
      { db, secrets: env },
      { from: message.from, to: message.to, raw },
      { domain, now: new Date() },
    );
    if (release) {
      await wakeRelease(deps.instances(env), release.wake);
      return { status: "dropped", tenantId: release.tenantId, reason: "unknown_address" };
    }
    // A reply to a reach-out email (its tagged reply-to address) ends that reach-out; it is not
    // forwarded mail.
    const reply = await receiveReachOutReply(
      db,
      { from: message.from, to: message.to, raw },
      { domain, now: new Date(), forwardingAddress },
    );
    if (reply) {
      await wakeAll(deps.instances(env), reply.woken);
      return { status: "dropped", tenantId: reply.tenantId, reason: "unknown_address" };
    }
    // v0.12 W1-G: mail to `<forwarding address>+voice` is a voice sample (docs/plan.md §1.42): its
    // text is kept as one, nothing else; it is never ordinary forwarded mail.
    if (isVoiceSampleAddress(message.to, domain)) {
      const voice = await receiveVoiceSampleEmail(
        { db },
        { from: message.from, to: message.to, raw, size: message.rawSize },
        { domain },
      );
      if (voice.status === "dropped") {
        console.log(`voice sample email dropped: ${voice.reason}`, { tenantId: voice.tenantId });
        return { status: "dropped", tenantId: voice.tenantId, reason: "unknown_address" };
      }
      return {
        status: "accepted",
        tenantId: voice.tenantId,
        documents: [],
        skipped: [],
        events: [],
      };
    }
    const content = new ContentStore(deps.objects(env));
    // v0.12 W2-E: mail to an agent's own address (`<agent>.<client>-<id>@domain`, docs/plan.md
    // §1.48) is a message to that agent: its message triggers, never forwarded mail.
    const toAgent = await receiveAgentEmail(
      { db, content, registry: deps.platform(env).events },
      { from: message.from, to: message.to, raw, size: message.rawSize },
      { domain },
    );
    if (toAgent) {
      if (toAgent.status !== "accepted") {
        console.log(`agent email ${toAgent.status}: ${toAgent.reason}`, {
          tenantId: toAgent.tenantId,
        });
      }
      const services = { db, env, deps } as Pick<Services, "db" | "env" | "deps">;
      const tenantId = toAgent.tenantId;
      closeLater = true;
      waitUntil(
        (async () => {
          try {
            if (tenantId) {
              await dispatchEvents({ db, instances: deps.instances(env) }, toAgent.events);
              await sendReplies(
                db,
                tenantId,
                replyDepsFromEnv(env, deps.fetch?.(env)),
                toAgent.replies,
              );
              if (toAgent.status === "accepted") {
                await extractInBackground(services, tenantId, toAgent.fresh);
              }
            }
          } finally {
            await close();
          }
        })(),
      );
      return toAgent.status === "accepted"
        ? { status: "accepted", tenantId: toAgent.tenantId, documents: [], skipped: [], events: [] }
        : { status: "dropped", tenantId: toAgent.tenantId, reason: "unknown_address" };
    }
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
