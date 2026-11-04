// What a messaging connector (Twilio now, Meta's WhatsApp later) asks of the platform for one
// client: may this person be sent to now (consent, opt-out, quiet hours, checked in code before any
// provider is called), was this send already made (a re-run after a crash), and record a message
// the provider accepted. apps/api implements it over the client's contacts inside withTenant; the
// connector never reads the database itself.

import type { MessagingChannel, SendBlock } from "@countersign/core";

export interface SendCheckInput {
  channel: MessagingChannel;
  /** E.164. */
  to: string;
  now: Date;
  /** Skip the quiet-hours check (an approval card is drawn at any hour; the send itself is not). */
  ignoreQuietHours?: boolean;
}

export interface SendContact {
  id: string;
  name: string;
  language: string | null;
}

export type SendCheck =
  | {
      ok: true;
      contact: SendContact;
      /** The contact's last message to us on this channel (WhatsApp's 24-hour window). */
      lastInboundAt: Date | null;
    }
  | { ok: false; block: SendBlock | "no_contact"; message: string };

/** A message the provider accepted. */
export interface OutboundMessage {
  connectionId: string;
  channel: MessagingChannel;
  contactId: string;
  /** E.164, without any `whatsapp:` prefix. */
  to: string;
  from: string;
  /** The provider's id (Twilio: SM…). */
  sid: string;
  status: string;
  /** What was sent: the text, or the template's id when a template went out. */
  text: string;
  templateId: string | null;
  segments: number | null;
  /** The external action's key: one send per key. */
  idempotencyKey: string;
  sentAt: Date;
}

export interface SentRecord {
  sid: string;
  status: string;
  channel: MessagingChannel;
  to: string;
  from: string;
}

export interface MessagingServices {
  checkSend(input: SendCheckInput): Promise<SendCheck>;
  /** The message already sent under this key, if any. */
  sentFor(idempotencyKey: string): Promise<SentRecord | null>;
  /** Stores the message once (by sid) in the contact's thread and counts it as usage. */
  recordOutbound(message: OutboundMessage): Promise<void>;
}

export class SendBlockedError extends Error {
  constructor(
    readonly block: SendBlock | "no_contact" | "no_services" | "outside_window" | "no_sender",
    message: string,
  ) {
    super(message);
    this.name = "SendBlockedError";
  }
}
