import { z } from "zod";
import { isUuid } from "../ids";
import {
  MessageAudience,
  MessageKind,
  MessageSender,
  THREAD_SOURCES_MAX,
  THREAD_TEXT_MAX,
  ThreadKind,
} from "../threads/schemas";
// P-7
import { OpsTranslationView, TranslationView } from "../translate/settings";
import { defineRoute } from "./contract";

// Threads, the lead and `/commands` (ARCHITECTURE §11.2, §14; docs/plan.md §1.38). The portal reads
// and posts in its client's lead thread, its agent threads ("Message Pia") and its account threads
// (a Sloan conversation each); the back office reads every thread of the clients it serves and
// posts as itself, to the client or as an operator-only note. A message starting with `/<word>`
// is a command; the message trigger (W2-E) starts runs from `thread.message_posted`.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;
const Named = z.object({ id: z.string(), name: z.string() });

/** A person's message: text, and the record ids it rests on (checked to be this client's). */
export const ThreadPost = z.strictObject({
  text: z.string().trim().min(1).max(THREAD_TEXT_MAX),
  sources: z.array(Id).max(THREAD_SOURCES_MAX).default([]),
});
export type ThreadPostInput = z.input<typeof ThreadPost>;

/** An operator chooses who reads it: the client, or operators only (a note). */
export const OpsThreadPost = ThreadPost.extend({
  audience: MessageAudience,
  // P-7: also store the message in the client's working language, for the client (§1.69).
  translate: z.boolean().optional(),
});
export type OpsThreadPostInput = z.input<typeof OpsThreadPost>;

/** Older pages: messages before an instant, newest page first in time order. */
const MessagesQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** The lead as the portal sees them: the one operator person a client sees named (§4). */
export const PortalLead = z.object({ name: z.string() });
export type PortalLead = z.infer<typeof PortalLead>;

export const OpsLead = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});
export type OpsLead = z.infer<typeof OpsLead>;

/** A thread as the client sees it: what it is about and what is unread, nothing internal. */
export const PortalThread = z.object({
  id: z.string(),
  subject: ThreadKind,
  /** The agent's service, for an agent thread. */
  service: Named.nullable(),
  /** Who started an account thread (a Sloan conversation). */
  startedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  lastMessageAt: z.string().nullable(),
  unread: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type PortalThread = z.infer<typeof PortalThread>;

export const PortalMessageSender = z.object({
  type: MessageSender,
  /** A client member's name, the lead's, an agent's service name; null for Mezonas and the system. */
  name: z.string().nullable(),
  /** The signed-in person wrote it. */
  you: z.boolean(),
  /** The client's lead wrote it. */
  lead: z.boolean(),
});

export const PortalMessage = z.object({
  id: z.string(),
  kind: MessageKind,
  sender: PortalMessageSender,
  text: z.string(),
  /** The command's name for a `/command` message. */
  command: z.string().nullable(),
  sources: z.array(z.string()),
  createdAt: z.string(),
  // P-7: the message in the reader's working language, beside the original (docs/plan.md §1.69).
  translation: TranslationView.optional(),
});
export type PortalMessage = z.infer<typeof PortalMessage>;

export const OpsThread = z.object({
  id: z.string(),
  clientId: z.string(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  /** The client agent, for an agent thread. */
  agent: z.object({ id: z.string(), slug: z.string(), name: z.string() }).nullable(),
  lastMessageAt: z.string().nullable(),
  unread: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type OpsThread = z.infer<typeof OpsThread>;

export const OpsMessage = z.object({
  id: z.string(),
  kind: MessageKind,
  sender: z.object({ type: MessageSender, id: z.string().nullable(), name: z.string().nullable() }),
  agentVersionId: z.string().nullable(),
  text: z.string(),
  command: z.string().nullable(),
  audience: MessageAudience,
  sources: z.array(z.string()),
  createdAt: z.string(),
  // P-7: a client user's message in English, or the lead's in the working language (§1.69).
  translation: OpsTranslationView.optional(),
});
export type OpsMessage = z.infer<typeof OpsMessage>;

const PortalThreadsQuery = z.object({
  /**
   * `lead` finds or opens the client's lead thread; `agent` with `service` finds or opens that
   * service's thread; otherwise the existing threads of that kind (all kinds when left out).
   */
  subject: ThreadKind.optional(),
  service: Id.optional(),
});

const OpsThreadsQuery = z.object({
  /** Any subject type; `lead` and `agent` (with `subjectId`) find or open the thread. */
  subject: z.string().min(1).max(64).optional(),
  subjectId: Id.optional(),
});

export const threadRoutes = {
  // ── Portal ─────────────────────────────────────────────────────────────────────────────────────
  portalThreads: defineRoute({
    method: "GET",
    path: "/api/threads",
    auth: "session",
    roles: CLIENT,
    summary:
      "Your threads with your lead, your services and Sloan, with what is unread (the lead thread is opened on first ask)",
    query: PortalThreadsQuery,
    response: z.object({ lead: PortalLead.nullable(), threads: z.array(PortalThread) }),
  }),
  portalStartThread: defineRoute({
    method: "POST",
    path: "/api/threads",
    auth: "session",
    roles: CLIENT,
    summary: "Start a conversation with Sloan, your account agent",
    body: z.strictObject({ subject: z.literal("account") }),
    response: z.object({ thread: PortalThread }),
  }),
  portalThreadMessages: defineRoute({
    method: "GET",
    path: "/api/threads/:id/messages",
    auth: "session",
    roles: CLIENT,
    summary: "A thread's messages, oldest first (operator-only notes are never here)",
    params: IdParams,
    query: MessagesQuery,
    response: z.object({ thread: PortalThread, messages: z.array(PortalMessage) }),
  }),
  portalPostMessage: defineRoute({
    method: "POST",
    path: "/api/threads/:id/messages",
    auth: "session",
    roles: CLIENT,
    summary: "Post a message; `/name …` asks one of your agents (an unknown name gets an answer)",
    params: IdParams,
    body: ThreadPost,
    response: z.object({ messages: z.array(PortalMessage) }),
  }),
  portalReadThread: defineRoute({
    method: "POST",
    path: "/api/threads/:id/read",
    auth: "session",
    roles: CLIENT,
    summary: "Mark a thread read up to now",
    params: IdParams,
    response: z.object({ ok: z.literal(true) }),
  }),

  // ── Back office ────────────────────────────────────────────────────────────────────────────────
  opsThreads: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/threads",
    auth: "session",
    roles: OPS,
    summary: "A client's threads with what is unread for you, and its lead",
    params: IdParams,
    query: OpsThreadsQuery,
    response: z.object({ lead: OpsLead.nullable(), threads: z.array(OpsThread) }),
  }),
  opsThreadMessages: defineRoute({
    method: "GET",
    path: "/api/ops/threads/:id/messages",
    auth: "session",
    roles: OPS,
    summary: "A thread's messages, oldest first, notes included",
    params: IdParams,
    query: MessagesQuery,
    response: z.object({ thread: OpsThread, messages: z.array(OpsMessage) }),
  }),
  opsPostMessage: defineRoute({
    method: "POST",
    path: "/api/ops/threads/:id/messages",
    auth: "session",
    roles: OPS,
    summary:
      "Post as yourself: to the client, or an operator-only note; `/name` asks an agent, `/skill` on an agent thread names a skill",
    params: IdParams,
    body: OpsThreadPost,
    response: z.object({ messages: z.array(OpsMessage) }),
  }),
  // DECISION: §14 lists read only for the portal; the lead needs unread counts too, so the back
  // office marks its own reads the same way.
  opsReadThread: defineRoute({
    method: "POST",
    path: "/api/ops/threads/:id/read",
    auth: "session",
    roles: OPS,
    summary: "Mark a thread read up to now, for you",
    params: IdParams,
    response: z.object({ ok: z.literal(true) }),
  }),
  opsSetLead: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/lead",
    auth: "session",
    roles: OPS,
    summary: "Set the client's lead: an operator who serves the client (null clears it)",
    params: IdParams,
    body: z.strictObject({
      userId: Id.nullable(),
      reason: z.string().trim().max(500).default(""),
    }),
    response: z.object({ lead: OpsLead.nullable() }),
  }),
} as const;
