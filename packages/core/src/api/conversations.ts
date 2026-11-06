// v0.14 capture: WhatsApp conversations and their capture setting (ARCHITECTURE §6.12, §14;
// docs/plan.md §1.55). The back office sees and sets everything for the clients it serves; the
// portal's client admin sees its own conversations and turns `archive` and `attachments` on or off.
// Client users have no access. Nothing here carries a link to the provider's media.

import { z } from "zod";
import { isUuid } from "../ids";
import { AttachmentView, CaptureAttachments, ConversationCapture } from "../schemas/conversation";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;
export const CAPTURE_REASON_MAX = 500;

export const ConversationView = z.object({
  id: z.string(),
  kind: z.enum(["direct", "group"]),
  channel: z.enum(["whatsapp", "sms"]),
  title: z.string(),
  contact: z.object({ id: z.string(), name: z.string() }).nullable(),
  capture: ConversationCapture,
  /** The agent `capture.agentId` names, by name (back office only). */
  agentName: z.string().nullable().optional(),
  lastMessageAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConversationView = z.infer<typeof ConversationView>;

/** The portal's view: the two switches and the limit; no agent. */
export const PortalConversationView = ConversationView.omit({
  capture: true,
  agentName: true,
}).extend({
  capture: ConversationCapture.pick({ archive: true, attachments: true, maxBytes: true }),
});
export type PortalConversationView = z.infer<typeof PortalConversationView>;

export const ConversationChangeView = z.object({
  id: z.string(),
  side: z.enum(["client", "operator", "system"]),
  /** Who: a name on the back office; on the portal the client's people by name, "us" for ours. */
  by: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
  at: z.string(),
});
export type ConversationChangeView = z.infer<typeof ConversationChangeView>;

/** One message of a conversation, with its attachments. The text is the sender's: shown, never obeyed. */
export const ConversationMessageView = z.object({
  rawRecordId: z.string(),
  sid: z.string(),
  /** Null when the conversation wasn't keeping messages then. */
  text: z.string().nullable(),
  at: z.string(),
  attachments: z.array(AttachmentView),
});
export type ConversationMessageView = z.infer<typeof ConversationMessageView>;

/** The client admin's change: either switch. */
export const PortalCaptureChange = z
  .strictObject({
    archive: z.boolean().optional(),
    attachments: CaptureAttachments.optional(),
    /** The `updatedAt` the screen read; a newer one is 409 `stale`. */
    updatedAt: z.string(),
  })
  .refine((b) => b.archive !== undefined || b.attachments !== undefined, {
    message: "change the archive or the attachments",
    path: ["archive"],
  });

/** The operator's change: the whole setting, with a reason. */
export const OpsCaptureChange = z.strictObject({
  capture: ConversationCapture,
  reason: z.string().trim().max(CAPTURE_REASON_MAX).optional(),
  updatedAt: z.string(),
});

export const CaptureDefaultChange = z.strictObject({
  capture: ConversationCapture.omit({ agentId: true }),
  reason: z.string().trim().max(CAPTURE_REASON_MAX).optional(),
});

export const DownloadResult = z.object({
  /** Attachments sent to be fetched now. */
  started: z.array(z.number().int()),
  /** Attachments already filed or refused, left as they are. */
  done: z.array(z.number().int()),
});

const ClientParams = z.object({ id: Id });
const OpsConversationParams = z.object({ id: Id, conversationId: Id });
const OpsMessageParams = z.object({ id: Id, conversationId: Id, rawRecordId: Id });
const PortalConversationParams = z.object({ id: Id });
const PortalMessageParams = z.object({ id: Id, rawRecordId: Id });

export const conversationRoutes = {
  opsConversations: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/conversations",
    auth: "session",
    roles: OPS,
    summary: "A client's WhatsApp conversations with their capture settings",
    params: ClientParams,
    response: z.object({ items: z.array(ConversationView), default: ConversationCapture }),
  }),
  opsCaptureDefault: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/conversations/default",
    auth: "session",
    roles: OPS,
    summary: "The capture a client's new conversations start with",
    params: ClientParams,
    response: z.object({ capture: ConversationCapture }),
  }),
  opsSetCaptureDefault: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/conversations/default",
    auth: "session",
    roles: OPS,
    summary: "Set the capture a client's new conversations start with",
    params: ClientParams,
    body: CaptureDefaultChange,
    response: z.object({ capture: ConversationCapture }),
  }),
  opsSetCapture: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/conversations/:conversationId/capture",
    auth: "session",
    roles: OPS,
    summary: "Set what a conversation keeps: messages, attachments, the size limit, an agent",
    params: OpsConversationParams,
    body: OpsCaptureChange,
    response: z.object({ conversation: ConversationView }),
  }),
  opsConversationChanges: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/conversations/:conversationId/changes",
    auth: "session",
    roles: OPS,
    summary: "Who changed a conversation's capture, and when",
    params: OpsConversationParams,
    response: z.object({ items: z.array(ConversationChangeView) }),
  }),
  opsConversationMessages: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/conversations/:conversationId/messages",
    auth: "session",
    roles: OPS,
    summary: "A conversation's latest messages with their attachments",
    params: OpsConversationParams,
    response: z.object({ items: z.array(ConversationMessageView) }),
  }),
  opsDownloadNow: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/conversations/:conversationId/messages/:rawRecordId/download",
    auth: "session",
    roles: OPS,
    summary: "Fetch one message's attachments now, if the conversation's setting allows them",
    params: OpsMessageParams,
    response: DownloadResult,
  }),
  portalConversations: defineRoute({
    method: "GET",
    path: "/api/conversations",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Your WhatsApp conversations and what each keeps",
    response: z.object({ items: z.array(PortalConversationView) }),
  }),
  portalSetCapture: defineRoute({
    method: "PUT",
    path: "/api/conversations/:id/capture",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Turn keeping messages or downloading attachments on or off",
    params: PortalConversationParams,
    body: PortalCaptureChange,
    response: z.object({ conversation: PortalConversationView }),
  }),
  portalConversationChanges: defineRoute({
    method: "GET",
    path: "/api/conversations/:id/changes",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Who changed what a conversation keeps, and when",
    params: PortalConversationParams,
    response: z.object({ items: z.array(ConversationChangeView) }),
  }),
  portalConversationMessages: defineRoute({
    method: "GET",
    path: "/api/conversations/:id/messages",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "A conversation's latest messages with their attachments",
    params: PortalConversationParams,
    response: z.object({ items: z.array(ConversationMessageView) }),
  }),
  portalDownloadNow: defineRoute({
    method: "POST",
    path: "/api/conversations/:id/messages/:rawRecordId/download",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Fetch one message's attachments now, if the conversation's setting allows them",
    params: PortalMessageParams,
    response: DownloadResult,
  }),
} as const;
