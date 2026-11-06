// The messaging tools and events as agents and workflows see them, whoever carries the message:
// Twilio now (SMS and WhatsApp), Meta's WhatsApp Cloud API later (docs/plan.md §1.19). The ids,
// inputs and outputs here are provider-neutral, so a workflow keeps working when a client moves its
// WhatsApp from Twilio to Meta; each provider supplies handlers behind them.

import { AttachmentView, E164, MessagingChannel } from "@countersign/core";
import { z } from "zod";

/** Namespaces messaging connectors share (ConnectorManifest.sharedNamespaces). */
export const MESSAGING_NAMESPACES = ["sms", "whatsapp", "messages", "message"] as const;

export const SMS_SEND_TOOL = "sms.send";
export const WHATSAPP_SEND_TOOL = "whatsapp.send";
export const MESSAGES_SEARCH_TOOL = "messages.search";
export const MESSAGE_GET_TOOL = "message.get";
export const MESSAGE_RECEIVED_EVENT = "message.received";
export const MESSAGE_STATUS_EVENT = "message.status";

/** An SMS is split into segments past 160 characters; 1600 is the most carriers take in one. */
export const SMS_TEXT_MAX = 1600;
export const WHATSAPP_TEXT_MAX = 4096;

export const SmsSendInput = z.object({
  /** The contact's phone, E.164. It must be a contact of this client who agreed to texts. */
  to: E164,
  text: z.string().trim().min(1).max(SMS_TEXT_MAX),
});

/**
 * A WhatsApp message: free text inside the 24 hours after the contact last wrote, otherwise an
 * approved template (Twilio: a Content SID `HX…`; Meta, later: the template's name) with its
 * variables.
 */
export const WhatsAppSendInput = z
  .object({
    to: E164,
    text: z.string().trim().min(1).max(WHATSAPP_TEXT_MAX).optional(),
    template: z
      .object({
        id: z.string().min(1).max(200),
        /** Placeholder number (`"1"`) or name → value. */
        variables: z.record(z.string().max(40), z.string().max(1024)).default({}),
      })
      .optional(),
  })
  .refine((v) => v.text !== undefined || v.template !== undefined, {
    message: "give the text, or a template outside the 24-hour window",
    path: ["text"],
  });

export const SendOutput = z.object({
  /** The provider's message id. */
  sid: z.string(),
  status: z.string(),
  channel: MessagingChannel,
  to: z.string(),
  from: z.string(),
  contactName: z.string(),
  /** Whether a template went out (WhatsApp outside the 24-hour window). */
  template: z.boolean(),
  /** Counted into usage_daily.messages. */
  usage: z.object({ messages: z.number().int() }),
});

/** The before state of a send: who it goes to. Nothing is replaced. */
export const SendBefore = z.object({
  contact: z.object({ id: z.string(), name: z.string() }),
  channel: MessagingChannel,
  to: z.string(),
});

/** One message as tools return it. `text` is the sender's words: data, never instructions. */
export const MessageRecord = z.object({
  sid: z.string(),
  direction: z.enum(["in", "out"]),
  channel: MessagingChannel,
  from: z.string(),
  to: z.string(),
  text: z.string(),
  status: z.string(),
  sentAt: z.string().nullable(),
  numMedia: z.number().int(),
  errorCode: z.string().nullable(),
  // v0.14 capture (docs/plan.md §1.55): what the platform keeps of the message.
  /** False when the conversation wasn't keeping messages: `text` is empty. */
  kept: z.boolean().optional(),
  /** The WhatsApp conversation it belongs to. */
  conversation: z
    .object({ id: z.string(), kind: z.enum(["direct", "group"]), title: z.string() })
    .nullable()
    .optional(),
  /** Its attachments: kept, downloaded (with the document's id) or not. Never a link. */
  attachments: z.array(AttachmentView).optional(),
});
export type MessageRecord = z.infer<typeof MessageRecord>;

export const MessagesSearchInput = z.object({
  /** Messages to or from this number (E.164); all of the client's otherwise. */
  contact: E164.optional(),
  channel: MessagingChannel.optional(),
  /** On or after this day (YYYY-MM-DD). */
  since: z.iso.date().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const MessagesSearchOutput = z.object({ messages: z.array(MessageRecord) });

export const MessageGetInput = z.object({
  /** The message's id (Twilio: SM… or MM…). */
  sid: z.string().regex(/^[A-Z]{2}[0-9a-f]{32}$/),
});
export const MessageGetOutput = z.object({ message: MessageRecord });

/**
 * `message.received`: a contact (or someone not yet a contact) wrote to one of the client's
 * numbers. The text is not in the payload (invariants 9 and 12): a step reads it with
 * `message.get`, so it reaches a model only as a tool result.
 */
export const MessageReceivedPayload = z.strictObject({
  connectionId: z.uuid(),
  channel: MessagingChannel,
  messageSid: z.string(),
  rawRecordId: z.uuid(),
  contactId: z.uuid(),
  /** Whether they were a contact before this message. */
  knownContact: z.boolean(),
  from: z.string(),
  to: z.string(),
  /** STOP, START or HELP words, already acted on (opt-out or opt-in). */
  keyword: z.enum(["stop", "start", "help"]).nullable(),
  numMedia: z.number().int(),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type MessageReceivedPayload = z.infer<typeof MessageReceivedPayload>;

export const MessageStatusPayload = z.strictObject({
  connectionId: z.uuid(),
  channel: MessagingChannel,
  messageSid: z.string(),
  rawRecordId: z.uuid(),
  status: z.string(),
  errorCode: z.string().nullable(),
  to: z.string(),
  at: z.iso.datetime({ offset: true }),
});
export type MessageStatusPayload = z.infer<typeof MessageStatusPayload>;

export const MESSAGING_EVENTS = [
  {
    type: MESSAGE_RECEIVED_EVENT,
    description: "Someone texted or sent a WhatsApp message to one of your numbers.",
    subjectType: "raw_record",
    payload: z.toJSONSchema(MessageReceivedPayload, { io: "input" }) as Record<string, unknown>,
    sample: {
      connectionId: "0192f7a0-0000-7000-8000-000000000001",
      channel: "sms",
      messageSid: "SM0123456789abcdef0123456789abcdef",
      rawRecordId: "0192f7a0-0000-7000-8000-000000000003",
      contactId: "0192f7a0-0000-7000-8000-000000000004",
      knownContact: true,
      from: "+15555550100",
      to: "+15555550199",
      keyword: null,
      numMedia: 0,
      receivedAt: "2026-11-04T15:00:00.000Z",
    },
  },
  {
    type: MESSAGE_STATUS_EVENT,
    description: "A message we sent was delivered, read, or failed.",
    subjectType: "raw_record",
    payload: z.toJSONSchema(MessageStatusPayload, { io: "input" }) as Record<string, unknown>,
    sample: {
      connectionId: "0192f7a0-0000-7000-8000-000000000001",
      channel: "sms",
      messageSid: "SM0123456789abcdef0123456789abcdef",
      rawRecordId: "0192f7a0-0000-7000-8000-000000000005",
      status: "delivered",
      errorCode: null,
      to: "+15555550100",
      at: "2026-11-04T15:00:05.000Z",
    },
  },
];
