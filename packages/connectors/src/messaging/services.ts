// What a messaging connector (Twilio now, Meta's WhatsApp later) asks of the platform for one
// client: may this person be sent to now (consent, opt-out, quiet hours, checked in code before any
// provider is called), was this send already made or started (a re-run after a crash), and record
// a message the provider accepted. apps/api implements it over the client's contacts inside withTenant; the
// connector never reads the database itself.

import type { AttachmentView, MessagingChannel, SendBlock } from "@countersign/core";

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
      /**
       * Texts (docs/plan.md §1.97): when this contact was last sent one (null: never), and the
       * client's name, for the first text's introduction and opt-out line. Absent: unknown, and
       * the text is treated as a first one.
       */
      lastTextAt?: Date | null;
      client?: string;
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
  templateId: string | null;
  /** Who it went to, as recorded then (a re-run returns the message without checking again). */
  contactId: string;
  contactName: string;
}

/**
 * A send that was started: recorded before the provider is called, so a re-run after a crash knows
 * the provider may have accepted it (docs/plan.md §1.22 "At most once").
 */
export interface SendAttempt {
  /** The external action's key: one attempt per key. */
  idempotencyKey: string;
  connectionId: string;
  channel: MessagingChannel;
  contactId: string;
  contactName: string;
  /** E.164, without any `whatsapp:` prefix. */
  to: string;
  from: string;
  /** What is being sent: the text, or the template's id when a template goes out. */
  text: string;
  templateId: string | null;
  startedAt: Date;
  /**
   * PLATFORM_QA INTEG-6: 1 for the first try. A try the provider refused (it answered, and sent
   * nothing) may be followed by the next under the same key; the newest is what a re-run sees.
   */
  attempt?: number;
  /** From `attemptFor`: the provider refused this try, so nothing was sent. */
  refused?: boolean;
}

/**
 * A send's error that says the provider answered and sent nothing (`notWritten`): any 4xx but 408
 * and 409, so a rate limit (Twilio's 20429, Meta's 130429) or a refusal. A timeout, a 5xx or no
 * answer may have been sent.
 */
export function sendRefused(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409;
}

export interface MessagingServices {
  checkSend(input: SendCheckInput): Promise<SendCheck>;
  /** The message already sent under this key, if any. */
  sentFor(idempotencyKey: string): Promise<SentRecord | null>;
  /**
   * Records that a send is starting, before the provider is called. The first one per key and
   * try (`attempt`, 1 when absent) stands.
   */
  startAttempt(attempt: SendAttempt): Promise<void>;
  /** The newest send started under this key, if any, with `attempt` and `refused`. */
  attemptFor(idempotencyKey: string): Promise<SendAttempt | null>;
  /**
   * PLATFORM_QA INTEG-6: records that the provider refused try `attempt` (it answered and sent
   * nothing), so a re-run may send again instead of stopping for a person. Without it, every
   * started try stands.
   */
  refuseAttempt?(input: {
    idempotencyKey: string;
    attempt: number;
    reason: string;
    at: Date;
  }): Promise<void>;
  /** Which of these provider ids are recorded already, under any key. */
  recordedSids(sids: readonly string[]): Promise<string[]>;
  /** Stores the message once (by sid) in the contact's thread and counts it as usage. */
  recordOutbound(message: OutboundMessage): Promise<void>;
  // v0.14 capture (docs/plan.md §1.55)
  /** What the platform keeps of these messages: conversation, attachments, whether text is kept. */
  messageFacts?(sids: readonly string[]): Promise<Map<string, MessageFacts>>;
  // v0.14 W4-A (docs/plan.md §1.57): Meta keeps no list of messages to read back, so its
  // `messages.search` and `message.get` read what the platform recorded on the connection, with
  // the same capture facts (text hidden where it wasn't kept), and a send that lost Meta's answer
  // is matched by the key we sent with it (`biz_opaque_callback_data`, echoed in status callbacks).
  /** Messages recorded on this connection, newest first. */
  storedMessages?(query: StoredMessageQuery): Promise<StoredMessageRecord[]>;
  /** One message recorded on this connection, or null. */
  storedMessage?(sid: string): Promise<StoredMessageRecord | null>;
  /** The message a status callback tied to this send's key, when one arrived and isn't recorded. */
  statusSidFor?(idempotencyKey: string): Promise<{ sid: string; status: string } | null>;
}

// v0.14 W4-A
export interface StoredMessageQuery {
  /** E.164: messages to or from this number. */
  contact?: string | undefined;
  channel?: MessagingChannel | undefined;
  /** YYYY-MM-DD: on or after this day. */
  since?: string | undefined;
  limit: number;
}

// v0.14 W4-A: as `messages.search` and `message.get` return a message (messaging/spec.ts).
export interface StoredMessageRecord {
  sid: string;
  direction: "in" | "out";
  channel: MessagingChannel;
  from: string;
  to: string;
  text: string;
  status: string;
  sentAt: string | null;
  numMedia: number;
  errorCode: string | null;
  kept?: boolean;
  conversation?: { id: string; kind: "direct" | "group"; title: string } | null;
  attachments?: AttachmentView[];
}

// v0.14 capture
export interface MessageFacts {
  kept: boolean;
  conversation: { id: string; kind: "direct" | "group"; title: string } | null;
  attachments: AttachmentView[];
}

export class SendBlockedError extends Error {
  constructor(
    readonly block:
      | SendBlock
      | "no_contact"
      | "no_services"
      | "outside_window"
      | "no_sender"
      | "too_long",
    message: string,
  ) {
    super(message);
    this.name = "SendBlockedError";
  }
}
