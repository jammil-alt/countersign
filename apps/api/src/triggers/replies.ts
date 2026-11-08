// What the platform says back to a message sent to an agent (ARCHITECTURE §10.8; docs/plan.md
// §1.48 "Senders"): `reply.confirm` to a sender a trigger takes, and the polite fixed reply to one
// it doesn't (by email only when the From domain passed DMARC; texts always, from the same number),
// with a note to the lead in the client's lead thread. These are fixed words, behind no approval:
// they go only to the sender, on the channel the message came in on, and say only that it was
// received or can't be taken. Nothing from the message is echoed.
//
// Replies are sent after the inbound transaction commits (best effort, once): email through
// Mezonas' own mail (as notifications send), texts through the client's subaccount, as release
// codes send (no raw record, no thread line).

import {
  // P-8
  a2pServiceFor,
  type FetchLike,
  globalFetch,
  // v0.14 W4-A
  metaCredentialsOf,
  readTwilioConfig,
  readWhatsappMetaConfig,
  sendMetaReply,
  sendReleaseText,
  TWILIO_CONNECTOR_ID,
  twilioCredentialsOf,
  WHATSAPP_META_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  type InboundChannel,
  type Locale,
  type MessageChannel,
  pickLocalized,
  triggerWords,
} from "@countersign/core";
import { connection, type Db, type Tx, withTenant } from "@countersign/db";
import type { EventRow, EventTypeRegistry } from "@countersign/senses";
import { leadThread, postMessage, senseEmitPosted } from "@countersign/threads";
import { and, eq } from "drizzle-orm";
import type { Bindings } from "../env";
import { type Mailer, mailerFromEnv } from "../notify/mailer";
import { connectionCredentials } from "../secrets";

export interface ReplyDeps {
  mailer: Mailer;
  fetch: FetchLike;
  secrets: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">;
}

export function replyDepsFromEnv(env: Bindings, fetch?: FetchLike): ReplyDeps {
  return {
    mailer: mailerFromEnv(env, fetch),
    fetch: fetch ?? globalFetch(),
    secrets: {
      ...(env.ENCRYPTION_KEY ? { ENCRYPTION_KEY: env.ENCRYPTION_KEY } : {}),
      ...(env.ENCRYPTION_KEY_PREVIOUS
        ? { ENCRYPTION_KEY_PREVIOUS: env.ENCRYPTION_KEY_PREVIOUS }
        : {}),
    },
  };
}

export type InboundReply =
  | { channel: "email"; to: string; subject: string; text: string; idempotencyKey: string }
  | { channel: "sms" | "whatsapp"; from: string; to: string; body: string };

/** The polite reply to a sender no trigger takes; null when it may not be sent (email without DMARC). */
export function strangerReply(input: {
  channel: InboundChannel;
  agentName: string;
  locale: Locale;
  /** Email: the From address, only when its domain passed DMARC; texts: the sender's number. */
  to: string | null;
  /** Texts: the client's number it came in on. */
  from?: string;
  key: string;
}): InboundReply | null {
  if (!input.to) return null;
  const w = triggerWords(input.locale);
  if (input.channel === "email") {
    return {
      channel: "email",
      to: input.to,
      subject: w.strangerSubject(input.agentName),
      text: w.strangerReply(input.agentName),
      idempotencyKey: `stranger-${input.key}`,
    };
  }
  if (!input.from) return null;
  return {
    channel: input.channel,
    from: input.from,
    to: input.to,
    body: w.strangerReply(input.agentName),
  };
}

/** `reply.confirm` on the channel the message came in on. */
export function confirmReply(input: {
  channel: InboundChannel;
  confirm: Parameters<typeof pickLocalized>[0];
  agentName: string;
  locale: Locale;
  to: string;
  from?: string;
  key: string;
}): InboundReply | null {
  const text = pickLocalized(input.confirm, input.locale);
  if (input.channel === "email") {
    return {
      channel: "email",
      to: input.to,
      subject: triggerWords(input.locale).confirmSubject(input.agentName),
      text,
      idempotencyKey: `confirm-${input.key}`,
    };
  }
  if (!input.from) return null;
  return { channel: input.channel, from: input.from, to: input.to, body: text };
}

/** Tells the lead, in the client's lead thread (operators only), that a stranger wrote. */
export async function noteStranger(
  tx: Tx,
  input: {
    tenantId: string;
    agentName: string;
    channel: MessageChannel;
    from: string;
    locale: Locale;
    registry: EventTypeRegistry;
    collect: EventRow[];
  },
): Promise<void> {
  const lead = await leadThread(tx, input.tenantId);
  await postMessage(
    tx,
    {
      tenantId: input.tenantId,
      thread: lead,
      senderType: "system",
      senderId: null,
      kind: "text",
      // The sender's address or number only: never their words.
      body: {
        text: triggerWords(input.locale).strangerNote(
          input.agentName,
          input.channel,
          input.from.slice(0, 254),
        ),
      },
      sources: [],
      audience: "operator",
    },
    senseEmitPosted({ registry: input.registry, collect: input.collect }),
  );
}

/** Sends replies for one client; a failure is logged and nothing is retried (fixed words, once). */
export async function sendReplies(
  db: Db,
  tenantId: string,
  deps: ReplyDeps,
  replies: readonly InboundReply[],
): Promise<void> {
  for (const r of replies) {
    try {
      if (r.channel === "email") {
        if (!deps.mailer.isConfigured) continue;
        await deps.mailer.send({
          to: r.to,
          subject: r.subject,
          text: r.text,
          idempotencyKey: r.idempotencyKey,
        });
        continue;
      }
      // v0.14 W4-A: a WhatsApp message to the client's own number (Meta) is answered from it.
      if (r.channel === "whatsapp" && (await replyThroughMeta(db, tenantId, deps, r))) continue;
      await withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(connection)
          .where(
            and(
              eq(connection.tenantId, tenantId),
              eq(connection.connector, TWILIO_CONNECTOR_ID),
              eq(connection.status, "connected"),
            ),
          )
          .limit(1);
        const config = row ? readTwilioConfig(row.config) : null;
        if (!row || !config?.numbers.some((n) => n.phoneNumber === r.from)) return;
        const creds = twilioCredentialsOf(
          await (await connectionCredentials(tx, deps.secrets, row)).get(),
        );
        if (!creds) return;
        const prefix = r.channel === "whatsapp" ? "whatsapp:" : "";
        await sendReleaseText(deps.fetch, creds, {
          from: `${prefix}${r.from}`,
          to: `${prefix}${r.to}`,
          body: r.body,
          // P-8: a text goes through the client's Messaging Service once its campaign is verified.
          messagingServiceSid: r.channel === "sms" ? a2pServiceFor(config, r.from) : null,
        });
      });
    } catch (error) {
      console.warn(`a reply on ${r.channel} for client ${tenantId} was not sent`, String(error));
    }
  }
}

// v0.14 W4-A: the reply through the client's own WhatsApp number (Meta), when the message came to
// it: free text inside the window the sender's message just opened; nothing recorded, as Twilio's
// replies aren't. False when no connected Meta number is the reply's sender.
async function replyThroughMeta(
  db: Db,
  tenantId: string,
  deps: ReplyDeps,
  r: Extract<InboundReply, { channel: "sms" | "whatsapp" }>,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.tenantId, tenantId),
          eq(connection.connector, WHATSAPP_META_CONNECTOR_ID),
          eq(connection.status, "connected"),
        ),
      );
    const row = rows.find((c) => readWhatsappMetaConfig(c.config)?.phoneNumber === r.from);
    if (!row) return false;
    const creds = metaCredentialsOf(
      await (await connectionCredentials(tx, deps.secrets, row)).get(),
    );
    if (creds) await sendMetaReply(deps.fetch, creds, { to: r.to, body: r.body });
    return true;
  });
}
