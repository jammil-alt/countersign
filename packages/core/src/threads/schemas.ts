// Threads (ARCHITECTURE §11.2; docs/plan.md §1.38): the kinds, the limits on a person's message,
// and `thread.message_posted`'s payload. The route shapes are in ../api/threads.ts.
import { z } from "zod";

/** The v0.12 thread kinds, by `thread.subject_type`; `run`, `contact` and record subjects stay. */
export const THREAD_KINDS = ["lead", "account", "agent"] as const;
export const ThreadKind = z.enum(THREAD_KINDS);
export type ThreadKind = z.infer<typeof ThreadKind>;

/** True for the kinds a client reads and posts in (§11.2); every other subject is the back office's. */
export function isClientThreadKind(
  subjectType: string | null | undefined,
): subjectType is ThreadKind {
  return (THREAD_KINDS as readonly string[]).includes(subjectType ?? "");
}

/**
 * The account agent's slug (Sloan, the supervisor's client fork; ARCHITECTURE §9.8): the only agent
 * that writes model text to a client thread.
 */
export const ACCOUNT_AGENT_SLUG = "supervisor";

/** A person step's `assignee` for a lead check (ARCHITECTURE §11.2). */
export const LEAD_ASSIGNEE = "lead";

/**
 * A lead check's label on the client's timeline, with the lead's first name: "Ana: Check new
 * matches".
 */
// DECISION: the name goes before the step's own label, not into a sentence ("Ana checks …"), so
// the operator's label stays as written in any language and needs no new words.
export function leadCheckLabel(label: string, leadFirstName: string | null): string {
  return leadFirstName ? `${leadFirstName}: ${label}` : label;
}

/** A person's message: 1–4,000 characters (docs/plan.md §1.38 "Posting"). */
export const THREAD_TEXT_MAX = 4000;
/** Record ids one message may cite. */
export const THREAD_SOURCES_MAX = 50;

/** `operator`: a note the portal never shows (invariant 11). */
export const MessageAudience = z.enum(["client", "operator"]);
export type MessageAudience = z.infer<typeof MessageAudience>;

export const MessageSender = z.enum(["agent", "user", "system", "contact"]);
export type MessageSender = z.infer<typeof MessageSender>;

export const MessageKind = z.enum(["text", "command", "result"]);
export type MessageKind = z.infer<typeof MessageKind>;

const Id = z.uuid();

/**
 * What a command message pointed at when it was posted: an agent of the client (its message
 * trigger, channel `command`, W2-E) or, in the back office's agent thread, one of its skills.
 */
// DECISION: the event carries the resolved target, so the message trigger (W2-E) starts the right
// agent without parsing again; the command's words stay in the message (never in the event).
export const PostedCommand = z.strictObject({
  name: z.string().min(1),
  agentId: Id,
  /** The skill an operator's `/skill` names on an agent thread; absent for an agent command. */
  skill: z.string().min(1).optional(),
});
export type PostedCommand = z.infer<typeof PostedCommand>;

/**
 * `thread.message_posted` (ARCHITECTURE §8, §11.2): ids only, never the text, so a trigger filter
 * or a notification can't carry what was written.
 */
// DECISION: `audience` is added to §11.2's field list so notifications (W1-B) and triggers can skip
// operator-only notes without reading the message.
export const ThreadMessagePostedPayload = z.strictObject({
  threadId: Id,
  subjectType: z.string().nullable(),
  subjectId: Id.nullable(),
  messageId: Id,
  senderType: MessageSender,
  senderId: Id.nullable(),
  audience: MessageAudience,
  command: PostedCommand.optional(),
});
export type ThreadMessagePostedPayload = z.infer<typeof ThreadMessagePostedPayload>;
