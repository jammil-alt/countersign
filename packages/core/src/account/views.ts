// What Sloan's account tools return (docs/plan.md §1.47 "Tools"): built from the portal's own
// response schemas, so Sloan reads exactly what the portal shows its client and nothing more: no
// bundle, instruction, prompt, cost, operator note or vault (invariant 11). A test walks every
// result with the contract's forbidden-field check.

import { z } from "zod";
import { ServiceControl } from "../api/lifecycle";
import { PortalInboxItem, PortalRunSummary, portalRoutes } from "../api/routes";
import { RunStatusSchema } from "../api/runs-filter";
import { WhyCode } from "../permissions/explain";

/** A service as Sloan sees it: the client's controls' view, its description and what it does now. */
export const AccountService = ServiceControl.extend({
  description: z.string().nullable(),
  /** The run it is on now (running or waiting), if any. */
  current: PortalRunSummary.nullable(),
});
export type AccountService = z.infer<typeof AccountService>;

export const AccountRunsQuery = z.object({
  serviceId: z.string().optional(),
  status: RunStatusSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type AccountRunsQuery = z.infer<typeof AccountRunsQuery>;

/** `GET /api/runs/:id`, exactly. */
export const AccountRunView = portalRoutes.portalRun.response;
export type AccountRunView = z.infer<typeof AccountRunView>;

export { PortalInboxItem as AccountWaitingItem, PortalRunSummary as AccountRunSummary };
export type AccountWaitingItem = z.infer<typeof PortalInboxItem>;
export type AccountRunSummary = z.infer<typeof PortalRunSummary>;

/** Why one item waits: the Desk's reasons, each in the client's words. */
export const AccountWaitExplanation = z.object({
  item: z.object({ id: z.string(), title: z.string(), status: z.string() }),
  /** Empty when the item is not a change that waits for a signature (a question, a review). */
  reasons: z.array(z.object({ code: WhyCode, words: z.string() })),
  stage: z.enum(["trial", "signoff"]).nullable(),
  /** Whether the client's approver rules chose who signs it. */
  byRule: z.object({ ruleId: z.string().nullable(), words: z.string() }).nullable(),
});
export type AccountWaitExplanation = z.infer<typeof AccountWaitExplanation>;
