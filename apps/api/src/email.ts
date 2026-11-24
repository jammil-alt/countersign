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
// §1.150: Sloan by email
import { receiveSloanEmail } from "./account/reach";
// §1.124.4: the back office's support@ and hello@
import { receiveBackOfficeEmail } from "./backoffice/inbound-email";
import { backOfficeLocals } from "./backoffice/outbound-email";
import type { Bindings } from "./env";
import { wakeForm } from "./forms/service";
import { type AppDeps, defaultDeps, type Services } from "./http";
import { reportHandled } from "./observability/report";
import { forwardingAddress, receiveReachOutReply, wakeAll } from "./reach/replies";
import { extractInBackground } from "./routes/documents";
import { dispatchEvents } from "./runs/dispatch";
// P-7: message translation
import { translateLater, translationDepsFor } from "./translate/service";
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
    // A reply to a reach-out email (its reply address `r-<client>+<tag>`, or the forwarding address
    // with a tag for reach-outs sent before) ends that reach-out; it is never forwarded mail.
    const reply = await receiveReachOutReply(
      db,
      { from: message.from, to: message.to, raw },
      // P-3: the reply's PDFs and images become the client's documents (docs/plan.md §1.65).
      { domain, now: new Date(), forwardingAddress, content: new ContentStore(deps.objects(env)) },
    );
    if (reply) {
      await wakeAll(deps.instances(env), reply.woken);
      // P-7: the reply's words, translated beside it where the client has it on (§1.69); a late
      // reply's too, kept in the thread.
      const translate = reply.woken.length > 0 || reply.keptOnly;
      // P-3: then dispatched and read in the background, like forwarded mail.
      if (reply.events.length > 0 || reply.fresh.length > 0 || translate) {
        const services = { db, env, deps } as Pick<Services, "db" | "env" | "deps">;
        closeLater = true;
        waitUntil(
          (async () => {
            try {
              if (reply.events.length > 0 || reply.fresh.length > 0) {
                await dispatchEvents({ db, instances: deps.instances(env) }, reply.events);
                await extractInBackground(services, reply.tenantId, reply.fresh);
              }
              if (translate) await translateLater(translationDepsFor(services), reply.tenantId);
            } finally {
              await close();
            }
          })(),
        );
      }
      return { status: "dropped", tenantId: reply.tenantId, reason: "unknown_address" };
    }
    // §1.124.4: mail to the back office (`support@`, `hello@` and their `+tag` replies) becomes an
    // issue, a reply on one, a lead deal or a to-do; never forwarded mail.
    const office = await receiveBackOfficeEmail(
      db,
      { from: message.from, to: message.to, raw },
      { domain, locals: backOfficeLocals(env), content: new ContentStore(deps.objects(env)) },
    );
    if (office.handled) {
      if (office.tenantId && (office.events.length > 0 || office.fresh.length > 0)) {
        const services = { db, env, deps } as Pick<Services, "db" | "env" | "deps">;
        const tenantId = office.tenantId;
        closeLater = true;
        waitUntil(
          (async () => {
            try {
              await dispatchEvents({ db, instances: deps.instances(env) }, office.events);
              await extractInBackground(services, tenantId, office.fresh);
            } finally {
              await close();
            }
          })(),
        );
      }
      return { status: "dropped", tenantId: office.tenantId, reason: "unknown_address" };
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
    // §1.150: mail to Sloan's address (`sloan.<client>-<id>@domain`) is the person's message in
    // their conversation with Sloan; it is never an agent's mail or forwarded mail.
    const toSloan = await receiveSloanEmail(
      { db, content, registry: deps.platform(env).events },
      { from: message.from, to: message.to, raw, size: message.rawSize },
      { domain },
    );
    if (toSloan) {
      if (toSloan.status !== "accepted") {
        console.log(`sloan email ${toSloan.status}: ${toSloan.reason}`, {
          tenantId: toSloan.tenantId,
        });
      }
      const tenantId = toSloan.tenantId;
      if (tenantId && (toSloan.events.length > 0 || toSloan.replies.length > 0)) {
        const services = { db, env, deps } as Pick<Services, "db" | "env" | "deps">;
        closeLater = true;
        waitUntil(
          (async () => {
            try {
              await dispatchEvents({ db, instances: deps.instances(env) }, toSloan.events);
              await sendReplies(
                db,
                tenantId,
                replyDepsFromEnv(env, deps.fetch?.(env)),
                toSloan.replies,
              );
              if (toSloan.status === "accepted") {
                await extractInBackground(services, tenantId, toSloan.fresh);
                await translateLater(translationDepsFor(services), tenantId);
              }
            } finally {
              await close();
            }
          })(),
        );
      }
      return toSloan.status === "accepted"
        ? {
            status: "accepted",
            tenantId: toSloan.tenantId ?? "",
            documents: [],
            skipped: [],
            events: [],
          }
        : { status: "dropped", tenantId: toSloan.tenantId, reason: "unknown_address" };
    }
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
                // Collect reports: a report emailed to its step wakes the step's run (the cron
                // re-sends until the run takes it).
                // Collect reports: the first report starts its run (the row is written; the
                // reconciler starts it if this misses); a later one goes to the run listening.
                if (toAgent.start) {
                  try {
                    await deps.instances(env).start(toAgent.start);
                  } catch (error) {
                    reportHandled(
                      `starting run ${toAgent.start.runId} for a report failed; the reconciler starts it`,
                      error,
                      { job: "email", client: tenantId, run: toAgent.start.runId },
                    );
                  }
                }
                if (toAgent.listen) {
                  await deps
                    .instances(env)
                    .sendEvent(toAgent.listen.runId, {
                      type: toAgent.listen.eventType,
                      payload: { documents: toAgent.listen.documents },
                    })
                    .catch((error: unknown) =>
                      reportHandled(
                        `sending a report to run ${toAgent.listen?.runId} failed`,
                        error,
                        {
                          job: "email",
                          client: tenantId,
                        },
                      ),
                    );
                }
                if (toAgent.wake) {
                  await wakeForm(
                    { instances: deps.instances(env) },
                    {
                      id: toAgent.wake.formRequestId,
                      runId: toAgent.wake.runId,
                      reachOutId: toAgent.wake.reachOutId,
                    },
                  );
                }
                await extractInBackground(services, tenantId, toAgent.fresh);
                // P-7: the email's words, translated beside it where the client has it on.
                await translateLater(translationDepsFor(services), tenantId);
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
