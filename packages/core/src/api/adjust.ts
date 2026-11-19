// Client adjustments and feedback (docs/builder-plan.md §7, B5). The portal's agent Settings lists
// the settings we let the client adjust, with their bounds and value now; the client admin changes
// one there (applied at once by code when within the bounds or tighter, else a request to us). On
// the Manual tab anyone of the client's team can say "This is wrong because…" about a line, which
// files a request linked to it. No answer carries the agent's bundle, instructions, prompts or
// cost, nor which skill, parameter or step a setting sets (invariant 11).

import { z } from "zod";
import { isUuid } from "../ids";
import { AdjustRowView } from "../setup/adjust";
import { SetupItemId } from "../setup/item";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const CLIENT = ["client_admin", "client_user"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

export const AdjustBody = z.strictObject({
  /** The new value, as typed: "2", "5000", one of the options, a schedule's cron. */
  value: z.string().trim().min(1).max(2000),
  /** Why, in the person's words: kept with a request to us. */
  note: z.string().trim().max(2000).optional(),
});
export type AdjustBody = z.infer<typeof AdjustBody>;

/** What a change did: applied as a new version, or sent to us as a request. */
export const AdjustResult = z.object({
  outcome: z.enum(["applied", "requested", "unchanged"]),
  /** Plain words for the person: what happened and what comes next. */
  message: z.string(),
  /** The request it filed (beyond the bounds), by its number. */
  request: z.object({ id: z.string(), number: z.number().int() }).nullable(),
  settings: z.array(AdjustRowView),
});
export type AdjustResult = z.infer<typeof AdjustResult>;

/** The manual's sections a line can be in. */
export const MANUAL_LINE_SECTIONS = [
  "what",
  "how",
  "decision",
  "point",
  "risk",
  "setup",
  "learned",
] as const;
export const ManualLineSection = z.enum(MANUAL_LINE_SECTIONS);
export type ManualLineSection = z.infer<typeof ManualLineSection>;

export const ManualFeedbackBody = z.strictObject({
  section: ManualLineSection,
  /** The line's id where it has one (a decision's, a step's, a risk's). */
  lineId: z.string().trim().min(1).max(100).optional(),
  /** The line as the person read it, quoted in the request. */
  line: z.string().trim().min(1).max(1000),
  /** "This is wrong because…": the person's words. */
  because: z.string().trim().min(1).max(2000),
});
export type ManualFeedbackBody = z.infer<typeof ManualFeedbackBody>;

const RequestRef = z.object({ id: z.string(), number: z.number().int() });

export const adjustRoutes = {
  portalAgentAdjustable: defineRoute({
    method: "GET",
    path: "/api/services/:id/adjustable",
    auth: "session",
    roles: CLIENT,
    summary:
      "The settings of an agent the client admin may adjust, each with its bounds, its value now and who changed it last",
    params: z.object({ id: Id }),
    response: z.object({ settings: z.array(AdjustRowView) }),
  }),
  portalAgentAdjust: defineRoute({
    method: "POST",
    path: "/api/services/:id/adjustable/:settingId",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "The client admin changes one adjustable setting: within its bounds or tighter it is applied at once as a new version made by code and written in the manual; beyond them it files a request to us",
    params: z.object({ id: Id, settingId: SetupItemId }),
    body: AdjustBody,
    response: AdjustResult,
  }),
  portalManualFeedback: defineRoute({
    method: "POST",
    path: "/api/services/:id/manual/feedback",
    auth: "session",
    roles: CLIENT,
    summary:
      '"This is wrong because…" on a line of an agent\'s manual: files a request to us linked to the line (a decision by its id)',
    params: z.object({ id: Id }),
    body: ManualFeedbackBody,
    response: z.object({ request: RequestRef }),
  }),
} as const;
