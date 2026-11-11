import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// v0.12 W2-E: the triggers list (ARCHITECTURE §10.8, §14; docs/plan.md §1.48). The operator's view
// of how a client agent starts: each trigger of its live (else latest) version, with its workflow,
// guards and when it last fired (from `run.trigger`, no new table).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

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

/**
 * How one of the client's agents starts, as the portal's Agent settings tab says it: what kind of
 * trigger, the facts its words need and when it last started a run. Never its guards, filters,
 * hooks or anything else of the bundle (invariant 11); event types are mapped to words by the
 * portal, which shows a generic line for any it has none for.
 */
export const PortalTrigger = z.object({
  /** The job (workflow) it starts, by its name. */
  job: z.string(),
  type: z.enum(["event", "schedule", "manual", "command", "webhook", "message", "handoff"]),
  /** For an event trigger: the event type ("document.extracted"). */
  event: z.string().nullable(),
  /** For a schedule: its cron and zone (null: the client's own), and whether it skips holidays. */
  cron: z.string().nullable(),
  tz: z.string().nullable(),
  skipsHolidays: z.boolean(),
  /** For a manual trigger: the client may start it with Run now. */
  clientCanRun: z.boolean(),
  /** For a message trigger: the channels it listens on (email, sms, whatsapp, command, sloan). */
  channels: z.array(z.string()),
  /** When it last started a live run; null when it never has. */
  lastStartedAt: z.string().nullable(),
});
export type PortalTrigger = z.infer<typeof PortalTrigger>;

export const PortalAgentTriggers = z.object({
  /** `/name` in the client's threads; null while the agent isn't active. */
  commandName: z.string().nullable(),
  /** The triggers of its enabled jobs, in the order its jobs are listed. */
  triggers: z.array(PortalTrigger),
});
export type PortalAgentTriggers = z.infer<typeof PortalAgentTriggers>;

export const triggerRoutes = {
  portalAgentTriggers: defineRoute({
    method: "GET",
    path: "/api/services/:id/triggers",
    auth: "session",
    roles: CLIENT,
    summary:
      "How one of your services starts: each trigger of its jobs in plain facts, never its rules",
    params: z.object({ id: Id }),
    response: PortalAgentTriggers,
  }),
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
