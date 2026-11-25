import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Request an action (docs/step-model-plan.md §10c; owner, 2026-11-25): "can be made from a connector,
// an agent or the account". Whoever asks only describes what they need; a client never has to know it
// is a connector's action. It becomes a Dev queue request (`code_request`), with the reuse check, and
// we resolve it. The back office asks from a connector's page or an agent's; a client asks from their
// account, in their own words, and is told only that we have it.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const ACTION_REQUEST_MAX = 2000;

/** What a person needs, in their own words. */
const What = z.string().trim().min(10).max(ACTION_REQUEST_MAX);

export const NewActionRequest = z.strictObject({
  what: What,
  /** Asked from this connector's page (its id). */
  connector: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .optional(),
  /** Asked from this agent's page. */
  agentId: Id.optional(),
  /** The client it is for, when one is known. */
  clientId: Id.optional(),
});
export type NewActionRequest = z.infer<typeof NewActionRequest>;

export const ActionRequestAnswer = z.object({
  /** The Dev queue request it became (DQ-012); null when an open one already asks for it. */
  ref: z.string().nullable(),
  /** The open request that already asks for the same thing. */
  duplicate: z.object({ ref: z.string(), title: z.string() }).nullable(),
});
export type ActionRequestAnswer = z.infer<typeof ActionRequestAnswer>;

/** What a client is told: that we have it, and nothing about how we keep it. */
export const PortalActionRequestAnswer = z.object({ received: z.literal(true) });
export type PortalActionRequestAnswer = z.infer<typeof PortalActionRequestAnswer>;

export const actionRequestRoutes = {
  opsRequestAction: defineRoute({
    method: "POST",
    path: "/api/ops/action-requests",
    auth: "session",
    roles: OPS,
    summary: "Request an action from a connector or an agent",
    body: NewActionRequest,
    response: ActionRequestAnswer,
  }),
  portalRequestAction: defineRoute({
    method: "POST",
    path: "/api/action-requests",
    auth: "session",
    roles: CLIENT,
    summary: "Ask for something your agents can't do yet, from your account",
    body: z.strictObject({ what: What }),
    response: PortalActionRequestAnswer,
  }),
} as const;
