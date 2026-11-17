// Autopilot and the back office's email (docs/plan.md §1.123.4; docs/cases-plan.md A1, W1): what
// Reggie does in each stage and how far it goes on its own, a deal's email to its person, a reminder
// for what waits on a client, and Reggie's read of an issue on demand. Operator only.

import { z } from "zod";
import { isUuid } from "../ids";
import { PlayFlow, PlayLevel } from "../work/autopilot";
import { defineRoute } from "./contract";
import { DealDetail } from "./deals";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

export const PlayTrackView = z.object({
  drafted: z.number().int(),
  sent: z.number().int(),
  edited: z.number().int(),
  done: z.number().int(),
  lastFive: z.number().int(),
  lastFiveUnchanged: z.number().int(),
});

export const PlayView = z.object({
  flow: PlayFlow,
  stage: z.string(),
  key: z.string(),
  name: z.string(),
  when: z.string(),
  does: z.string(),
  internal: z.boolean(),
  locked: z.string().nullable(),
  level: PlayLevel,
  /** False for a locked play that reaches someone outside: Send is refused (409 always_yours). */
  maySend: z.boolean(),
  track: PlayTrackView,
  trackLine: z.string(),
  /** "Ready to send on its own?" */
  ready: z.boolean(),
});
export type PlayView = z.infer<typeof PlayView>;

export const AutopilotView = z.object({
  flows: z.array(
    z.object({
      flow: PlayFlow,
      name: z.string(),
      stages: z.array(z.object({ stage: z.string(), name: z.string(), plays: z.array(PlayView) })),
    }),
  ),
  alwaysYours: z.array(z.string()),
  secrets: z.string(),
  targets: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type AutopilotView = z.infer<typeof AutopilotView>;

export const autopilotRoutes = {
  opsAutopilot: defineRoute({
    method: "GET",
    path: "/api/ops/autopilot",
    auth: "session",
    roles: OPS,
    summary:
      "Autopilot: each flow's stages and plays, how far each goes on its own, its record this month, and what is always yours",
    response: AutopilotView,
  }),
  opsSetPlay: defineRoute({
    method: "PUT",
    path: "/api/ops/autopilot/:flow/:stage/:play",
    auth: "session",
    roles: OPS,
    summary:
      "Set how far a play goes: off, a draft for you, or send and tell you (refused for a play that is always yours)",
    params: z.object({
      flow: PlayFlow,
      stage: z.string().min(1).max(40),
      play: z.string().min(1).max(60),
    }),
    body: z.strictObject({ level: PlayLevel }),
    response: PlayView,
  }),
  opsDealEmail: defineRoute({
    method: "POST",
    path: "/api/ops/deals/:id/email",
    auth: "session",
    roles: OPS,
    summary:
      "Email the deal's primary person, from you via Mezonas, with replies threaded back to the deal",
    params: z.object({ id: Id }),
    body: z.strictObject({
      subject: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(10_000),
    }),
    response: DealDetail,
  }),
  opsTodoRemind: defineRoute({
    method: "POST",
    path: "/api/ops/todos/:id/remind",
    auth: "session",
    roles: OPS,
    summary:
      "Remind the client of a to-do or Desk item that waits on them: a message from their lead, or an email when it came by email",
    params: z.object({ id: Id }),
    response: z.object({
      ok: z.literal(true),
      channel: z.enum(["portal", "email"]),
    }),
  }),
  opsIssueRead: defineRoute({
    method: "POST",
    path: "/api/ops/issues/:id/read",
    auth: "session",
    roles: OPS,
    summary:
      "Ask Reggie to read an issue again now: what it is, how urgent, what it found and a draft for you",
    params: z.object({ id: Id }),
    response: z.object({ read: z.boolean() }),
  }),
} as const;
