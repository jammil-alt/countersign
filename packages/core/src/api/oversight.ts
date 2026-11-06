import { z } from "zod";
import { isUuid } from "../ids";
import { OVERSIGHT_ACTIONS, OVERSIGHT_CAUSES } from "../oversight/decision";
import { defineRoute } from "./contract";

// v0.13 W2-I: run oversight in the back office (ARCHITECTURE §10.11, §5.6; docs/plan.md §1.54).
// Operator only: a decision's note, the input change, the model and the cost never reach the portal
// (invariant 11), which shows only the platform's words for each decision (i18n/oversight.ts).

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** One `oversight_decision` row, as the run view and the agent lab show it. */
export const OversightDecisionView = z.object({
  id: z.string(),
  runId: z.string(),
  stepRunId: z.string(),
  nodeId: z.string(),
  seq: z.number().int(),
  cause: z.enum(OVERSIGHT_CAUSES),
  action: z.enum(OVERSIGHT_ACTIONS),
  /** `retry_with` only. */
  inputBefore: z.unknown().nullable(),
  inputAfter: z.unknown().nullable(),
  /** The agent's diagnosis (operator only). */
  note: z.string(),
  proposal: z.object({ summary: z.string(), change: z.unknown() }).nullable(),
  inboxItemId: z.string().nullable(),
  sources: z.array(z.string()),
  model: z.string(),
  costUsd: z.string(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  agentVersionId: z.string(),
  createdAt: z.string(),
});
export type OversightDecisionView = z.infer<typeof OversightDecisionView>;

/** A decision in the agent lab's list: with its client, agent and workflow. */
export const OpsOversightDecision = OversightDecisionView.extend({
  tenantId: z.string(),
  agentId: z.string(),
  workflowSlug: z.string(),
});
export type OpsOversightDecision = z.infer<typeof OpsOversightDecision>;

export const OpsOversightQuery = z.object({
  client: Id.optional(),
  agent: Id.optional(),
  action: z.enum(OVERSIGHT_ACTIONS).optional(),
  cause: z.enum(OVERSIGHT_CAUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const oversightRoutes = {
  opsOversight: defineRoute({
    method: "GET",
    path: "/api/ops/oversight",
    auth: "session",
    roles: ["operator"],
    summary:
      "Run oversight decisions across the clients you serve, newest first, with counts by action and their cost",
    query: OpsOversightQuery,
    response: z.object({
      decisions: z.array(OpsOversightDecision),
      totals: z.object({
        count: z.number().int(),
        costUsd: z.string(),
        byAction: z.record(z.string(), z.number().int()),
      }),
    }),
  }),
} as const;
