// Reggie, the operator's account agent (docs/plan.md §1.101): conversations in the back office, the
// changes Reggie proposes for the operator to confirm, and the lead's requests on a client admin's
// Desk (which Reggie, and the back office, can make).

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const IdParams = z.object({ id: Id });

export const REGGIE_TEXT_MAX = 4000;
export const REGGIE_NAME = "Reggie";

export const ReggieConversation = z.object({
  id: z.string(),
  title: z.string(),
  /** The client it was opened about, if any. */
  client: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReggieConversation = z.infer<typeof ReggieConversation>;

export const ReggieMessage = z.object({
  id: z.string(),
  role: z.enum(["operator", "reggie"]),
  text: z.string(),
  /** Reggie's: the tools it used to answer, by name. */
  tools: z.array(z.string()),
  createdAt: z.string(),
});
export type ReggieMessage = z.infer<typeof ReggieMessage>;

export const REGGIE_ACTION_STATUSES = ["proposed", "done", "cancelled", "failed"] as const;

/** A change Reggie proposed, as its card shows it. */
export const ReggieAction = z.object({
  id: z.string(),
  /** The message whose turn proposed it. */
  messageId: z.string().nullable(),
  tool: z.string(),
  title: z.string(),
  /** What will happen, line by line, in plain words. */
  lines: z.array(z.string()),
  client: z.object({ id: z.string(), name: z.string() }).nullable(),
  status: z.enum(REGGIE_ACTION_STATUSES),
  /** What the change did, once done; why it failed. */
  outcome: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ReggieAction = z.infer<typeof ReggieAction>;

export const ReggieConversationStart = z.strictObject({ clientId: Id.optional() });
export const ReggieTurn = z.strictObject({ text: z.string().trim().min(1).max(REGGIE_TEXT_MAX) });

const OneConversation = z.object({
  conversation: ReggieConversation,
  messages: z.array(ReggieMessage),
  actions: z.array(ReggieAction),
});

// ── The lead's requests on a client admin's Desk ─────────────────────────────────────────────────

export const LEAD_REQUEST_SUBJECT = "lead_request";
export const LEAD_REQUEST_CHOICES_MAX = 6;

export const LeadRequestCreate = z.strictObject({
  /** The question or the ask, as the client admin reads it on their Desk. */
  question: z.string().trim().min(3).max(300),
  /** More words under it, if needed. */
  detail: z.string().trim().max(2000).optional(),
  /** Answers to pick from; without them, the admin writes one. */
  choices: z
    .array(z.string().trim().min(1).max(80))
    .min(2)
    .max(LEAD_REQUEST_CHOICES_MAX)
    .optional(),
});
export type LeadRequestCreateInput = z.input<typeof LeadRequestCreate>;

export const LeadRequest = z.object({
  id: z.string(),
  question: z.string(),
  detail: z.string().nullable(),
  choices: z.array(z.string()),
  status: z.enum(["open", "resolved", "expired"]),
  /** The admin's answer once given; declined is an answer too. */
  answer: z.string().nullable(),
  declined: z.boolean(),
  answeredBy: z.string().nullable(),
  askedBy: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type LeadRequest = z.infer<typeof LeadRequest>;

export const reggieRoutes = {
  opsReggieConversations: defineRoute({
    method: "GET",
    path: "/api/ops/reggie/conversations",
    auth: "session",
    roles: OPS,
    summary: "Your conversations with Reggie, newest first",
    response: z.object({ items: z.array(ReggieConversation) }),
  }),
  opsReggieConversationStart: defineRoute({
    method: "POST",
    path: "/api/ops/reggie/conversations",
    auth: "session",
    roles: OPS,
    summary: "Start a conversation with Reggie, about a client or about everything",
    body: ReggieConversationStart,
    response: OneConversation,
  }),
  opsReggieConversation: defineRoute({
    method: "GET",
    path: "/api/ops/reggie/conversations/:id",
    auth: "session",
    roles: OPS,
    summary: "A conversation with Reggie: its messages and the changes it proposed",
    params: IdParams,
    response: OneConversation,
  }),
  opsReggieTurn: defineRoute({
    method: "POST",
    path: "/api/ops/reggie/conversations/:id/turns",
    auth: "session",
    roles: OPS,
    summary: "Ask Reggie: it reads what you can read, and proposes changes for you to confirm",
    params: IdParams,
    body: ReggieTurn,
    response: OneConversation,
  }),
  opsReggieActionConfirm: defineRoute({
    method: "POST",
    path: "/api/ops/reggie/actions/:id/confirm",
    auth: "session",
    roles: OPS,
    summary: "Make a change Reggie proposed, once",
    params: IdParams,
    response: z.object({ action: ReggieAction }),
  }),
  opsReggieActionCancel: defineRoute({
    method: "POST",
    path: "/api/ops/reggie/actions/:id/cancel",
    auth: "session",
    roles: OPS,
    summary: "Turn down a change Reggie proposed",
    params: IdParams,
    response: z.object({ action: ReggieAction }),
  }),
  opsLeadRequestCreate: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/lead-requests",
    auth: "session",
    roles: OPS,
    summary: "Ask the client admin something on their Desk, as their Mezonas lead",
    params: IdParams,
    body: LeadRequestCreate,
    response: z.object({ request: LeadRequest }),
  }),
  opsLeadRequests: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/lead-requests",
    auth: "session",
    roles: OPS,
    summary: "What the lead asked the client admin, and their answers",
    params: IdParams,
    response: z.object({ items: z.array(LeadRequest) }),
  }),
} as const;
