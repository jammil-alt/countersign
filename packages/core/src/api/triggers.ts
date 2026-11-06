import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// v0.12 W2-E: the triggers list (ARCHITECTURE §10.8, §14; docs/plan.md §1.48). The operator's view
// of how a client agent starts: each trigger of its live (else latest) version, with its workflow,
// guards and when it last fired (from `run.trigger`, no new table).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

export const TriggerListItem = z.object({
  workflow: z.string(),
  workflowName: z.string(),
  enabled: z.boolean(),
  triggerId: z.string(),
  type: z.string(),
  /** True for the workflow's first trigger, false for one of `moreTriggers`. */
  first: z.boolean(),
  /** One line in plain words: "Weekdays at 0 7 * * 1-5, skips holidays". */
  summary: z.string(),
  /** The trigger's guards as written: filter, dedupe key, rate limit, People, channels, holidays. */
  guards: z.record(z.string(), z.unknown()),
  lastFired: z
    .object({ at: z.string(), runId: z.string(), status: z.string(), mode: z.string() })
    .nullable(),
});
export type TriggerListItem = z.infer<typeof TriggerListItem>;

export const AgentTriggers = z.object({
  agentId: z.string(),
  versionId: z.string().nullable(),
  /** Whether the version listed is the live one (else the latest). */
  live: z.boolean(),
  /** `/name` in client threads; null while the agent isn't active. */
  commandName: z.string().nullable(),
  /** The agent's own email address; null without EMAIL_FORWARDING_DOMAIN or a command name. */
  address: z.string().nullable(),
  triggers: z.array(TriggerListItem),
});
export type AgentTriggers = z.infer<typeof AgentTriggers>;

export const triggerRoutes = {
  opsAgentTriggers: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/triggers",
    auth: "session",
    roles: OPS,
    summary: "A client agent's triggers: each with its workflow, guards and when it last fired",
    params: z.object({ id: Id }),
    response: AgentTriggers,
  }),
} as const;
