import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { INVITE_EMAIL_MAX, InviteEmail } from "./onboarding";

// Mezonas's own people (docs/plan.md §1.122): the back office's Users screen lists the operators
// who serve the same clients as you, invites another, and removes one. Every operator is equal (an
// admin of the back office); there are no lesser operator roles yet.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

/** An operator, as another operator sees them. */
export const OperatorMember = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  /** Whether they have signed in yet; null where sign-in can't tell (the dev sign-in). */
  signedIn: z.boolean().nullable(),
  /** How many of the clients you serve they serve too. */
  clients: z.int(),
  /** The signed-in operator's own row. */
  you: z.boolean(),
});
export type OperatorMember = z.infer<typeof OperatorMember>;

export const OperatorInviteBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(INVITE_EMAIL_MAX).email(),
  name: z.string().trim().max(200).optional(),
});
export type OperatorInviteBody = z.infer<typeof OperatorInviteBody>;

export const OperatorInviteResult = z.object({
  operator: OperatorMember,
  /** Clients they were added to by this invite (0 when they already served them all). */
  added: z.int(),
  email: InviteEmail,
});
export type OperatorInviteResult = z.infer<typeof OperatorInviteResult>;

export const OperatorRemoveResult = z.object({
  removed: z.object({ userId: z.string(), email: z.string() }),
  /** Clients they no longer serve. */
  clients: z.int(),
  /** Open items that named them, now any operator's. */
  reassigned: z.int(),
});
export type OperatorRemoveResult = z.infer<typeof OperatorRemoveResult>;

export const operatorRoutes = {
  opsOperators: defineRoute({
    method: "GET",
    path: "/api/ops/operators",
    auth: "session",
    roles: OPS,
    summary: "The operators who serve the clients you serve",
    response: z.object({ operators: z.array(OperatorMember), clients: z.int() }),
  }),
  opsInviteOperator: defineRoute({
    method: "POST",
    path: "/api/ops/operators",
    auth: "session",
    roles: OPS,
    summary:
      "Invite an operator, or give one every client you serve; they sign in with that address",
    body: OperatorInviteBody,
    response: OperatorInviteResult,
  }),
  opsRemoveOperator: defineRoute({
    method: "DELETE",
    path: "/api/ops/operators/:userId",
    auth: "session",
    roles: OPS,
    summary: "Stop an operator serving the clients you serve; they lose access within 5 minutes",
    params: z.object({ userId: Id }),
    response: OperatorRemoveResult,
  }),
} as const;
