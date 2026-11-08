// P-6: the client runs it, we step in (docs/plan.md §1.68; ARCHITECTURE §4, §10.1, §10.12, §11).
// The client's team runs its agents day to day; the operator oversees and can step into anything,
// but is never the default step. Stepping in on an item takes the client's own resolve path; a
// live conversation can be taken over or ended from both surfaces; a message waiting for approval
// can be edited before it is approved (the portal edits through PUT /api/inbox/:id/edit).

import { z } from "zod";
import { ConverseOpsView, ConversePortalView } from "../converse";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const STEP_IN_REASON_MAX = 500;
/** A message edited before it is approved: the longest any channel takes (§10.12, reach out). */
export const EDITED_MESSAGE_MAX = 1600;

/** Why the operator stepped in: required, kept on the item and shown to the client. */
export const StepInReason = z.string().trim().min(1).max(STEP_IN_REASON_MAX);

/** Who a reassigned item goes to: a client role, or one person of that client. */
export const ReassignTarget = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("role"), role: z.enum(["client_admin", "client_user"]) }),
    z.strictObject({ kind: z.literal("user"), userId: Id }),
  ])
  .meta({ id: "ReassignTarget" });
export type ReassignTarget = z.infer<typeof ReassignTarget>;

/** The text a person approves in place of a drafted message (a conversation's or a reach-out's). */
export const EditedMessage = z.string().trim().min(1).max(EDITED_MESSAGE_MAX);

export const StepInBody = z
  .discriminatedUnion("action", [
    z.strictObject({
      action: z.literal("approve"),
      reason: StepInReason,
      note: z.string().max(2000).optional(),
      /** A message waiting for approval: the text to send instead (edit, then approve). */
      message: EditedMessage.optional(),
    }),
    z.strictObject({
      action: z.literal("reject"),
      reason: StepInReason,
      note: z.string().max(2000).optional(),
    }),
    z.strictObject({ action: z.literal("answer"), reason: StepInReason, answer: z.unknown() }),
    z.strictObject({ action: z.literal("reassign"), reason: StepInReason, to: ReassignTarget }),
  ])
  .meta({ id: "StepInBody" });
export type StepInBody = z.infer<typeof StepInBody>;

/**
 * What an item keeps of the operator stepping in (`payload.steppedIn`), as the portal shows it:
 * "Mezonas, on your behalf", the action and the reason. Never the operator person's name.
 */
export const SteppedIn = z
  .object({
    action: z.enum(["approve", "reject", "answer", "reassign", "take_over", "end"]),
    reason: z.string(),
    at: z.string(),
  })
  .meta({ id: "SteppedIn" });
export type SteppedIn = z.infer<typeof SteppedIn>;

/** The item after stepping in; the screens read the full item again. */
export const StepInItemState = z.object({
  id: z.string(),
  status: z.enum(["open", "resolved", "expired"]),
  assigneeRole: z.string().nullable(),
  assigneeUserId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  deliverAfter: z.string().nullable(),
  steppedIn: SteppedIn.nullable(),
});
export type StepInItemState = z.infer<typeof StepInItemState>;

/** Take a live conversation over (the agent sends nothing more; it waits on you) or end it. */
export const ConversationAction = z.enum(["take_over", "end"]);
export type ConversationAction = z.infer<typeof ConversationAction>;

export const OpsConversationControlBody = z.strictObject({
  action: ConversationAction,
  reason: StepInReason,
});
export const PortalConversationControlBody = z.strictObject({
  action: ConversationAction,
  reason: z.string().trim().max(STEP_IN_REASON_MAX).optional(),
});

export const stepInRoutes = {
  opsStepInInbox: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/inbox/:itemId/step-in",
    auth: "session",
    roles: OPS,
    summary:
      "Step in on an open item of a client you serve: approve, reject, answer or reassign it, with a reason",
    params: z.object({ id: Id, itemId: Id }),
    body: StepInBody,
    response: z.object({ item: StepInItemState }),
  }),
  opsConversationControl: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/runs/:runId/conversations/:stepRunId",
    auth: "session",
    roles: OPS,
    summary: "Take a live conversation over, or end it (the step's onReject), with a reason",
    params: z.object({ id: Id, runId: Id, stepRunId: Id }),
    body: OpsConversationControlBody,
    response: z.object({ conversation: ConverseOpsView }),
  }),
  portalConversationControl: defineRoute({
    method: "POST",
    path: "/api/runs/:id/conversations/:stepRunId",
    auth: "session",
    roles: CLIENT,
    summary: "The conversation's approver takes it over, or ends it",
    params: z.object({ id: Id, stepRunId: Id }),
    body: PortalConversationControlBody,
    response: z.object({ conversation: ConversePortalView }),
  }),
} as const;
