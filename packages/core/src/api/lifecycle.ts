import { z } from "zod";
import { isUuid } from "../ids";
import { MAX_PAUSE_REASON, PauseBody, PauseSide } from "../lifecycle/pause";
import {
  AgentStage,
  MAX_TRIAL_MIN_DAYS,
  MAX_TRIAL_MIN_RUNS,
  SignoffSummary,
  StageRejection,
  StageSkip,
} from "../lifecycle/stage";
import { JsonSchema, Slug } from "../schemas/common";
import { SetupView } from "../setup/view";
import { defineRoute } from "./contract";

// Go-live stages (ARCHITECTURE §10.9), client controls (§11.5) and running a client agent live on a
// past event (docs/plan.md §1.36, W1-A). The stage routes are the operator's; the client admin
// pauses and resumes; Run now is for the client admin and signing client users.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;
// v0.12 W1-D: a role can't say whether a client user signs (`membership.can_sign`), so Run now
// lets both client roles in and its handler refuses a viewer (403 `cannot_sign`, like the Desk).
const SIGNERS = ["client_admin", "client_user"] as const;

/** Why the operator moved an agent: required to move forward past a stage, optional back. */
export const StageReason = z.string().trim().min(1).max(500);

/** Where a client agent is on its way live, for the back office's agent page. */
export const GoLive = z.object({
  stage: AgentStage.nullable(),
  /**
   * Whether its live version (the latest while none is live) writes to a client's tool (no
   * writes: bench goes straight to live).
   */
  writes: z.boolean(),
  // UI cleanup (design pass): with no live version, `writes` is read from the latest version, and
  // this says so ("No live version yet"); optional so older answers still parse.
  /** Whether it has a live version. */
  liveVersion: z.boolean().optional(),
  trial: z
    .object({
      startedAt: z.string(),
      minDays: z.number().int(),
      minRuns: z.number().int(),
      days: z.number().int(),
      runs: z.number().int(),
      daysMetAt: z.string(),
      ready: z.boolean(),
    })
    .nullable(),
  /** The client admin's go-live item, while one is asked. */
  signoff: z
    .object({
      inboxItemId: z.string(),
      askedAt: z.string(),
      status: z.string().nullable(),
      summary: SignoffSummary.nullable(),
    })
    .nullable(),
  skipped: z.array(StageSkip),
  rejections: z.array(StageRejection),
  /**
   * docs/builder-plan.md §6: the setup checklist with this client's progress, when the version
   * shown carries one; optional so older answers still parse.
   */
  setup: SetupView.optional(),
  /** Who paused it and why (the operator sees the client's reason). */
  pause: z
    .object({
      side: PauseSide,
      reason: z.string(),
      at: z.string(),
      until: z.string().nullable(),
      all: z.boolean(),
    })
    .nullable(),
});
export type GoLive = z.infer<typeof GoLive>;

/** One service as the client's controls show it. */
export const ServiceControl = z.object({
  id: z.string(),
  name: z.string(),
  /** active | paused | …: the agent's run status. */
  status: z.string(),
  stage: AgentStage.nullable(),
  pause: z
    .object({
      side: PauseSide,
      reason: z.string(),
      at: z.string(),
      until: z.string().nullable(),
      /** Whether the client may resume it (only a pause made by the client side). */
      canResume: z.boolean(),
    })
    .nullable(),
  /** Pause all leaves the account agent on, so it can help. */
  accountAgent: z.boolean(),
});
export type ServiceControl = z.infer<typeof ServiceControl>;

/**
 * What came in during an agent's last pause that it would have started on, and hasn't (audit
 * 4.2): only how many and the pause's start and end, never the events themselves.
 */
export const MissedWhilePaused = z.object({
  count: z.number().int(),
  from: z.string(),
  to: z.string(),
  /** More events came in than were read: the count may be low. */
  more: z.boolean(),
});
export type MissedWhilePaused = z.infer<typeof MissedWhilePaused>;

/** A workflow the client may start by hand, with the form its trigger asks for. */
export const RunForm = z.object({
  workflow: Slug,
  label: z.string(),
  input: JsonSchema,
});
export type RunForm = z.infer<typeof RunForm>;

export const PauseAllBody = PauseBody;
export { MAX_PAUSE_REASON };

// ── Turn on in one button (docs/builder-plan.md §11.4 S4, §12.4; docs/plan.md §1.170) ──────────

/**
 * What a Turn on lists: the try (`tried`) and the validator's errors (`invalid`) are ours and hold
 * the button; what the client still owes (`connect`, `allow`, `who`, `setup`) never does; a build's
 * high-risk decisions (`decision`) come first and hold nothing (owner, 2026-11-21).
 */
export const TURN_ON_ITEM_KINDS = [
  "tried",
  "invalid",
  "connect",
  "allow",
  "who",
  "setup",
  "decision",
] as const;
export const TurnOnItemKind = z.enum(TURN_ON_ITEM_KINDS);
export type TurnOnItemKind = z.infer<typeof TurnOnItemKind>;

export const TurnOnItem = z.object({
  /** Stable across answers: `tried`, `invalid:<n>`, `connect:<connector>`, `decision:<id>`, … */
  key: z.string().min(1).max(300),
  kind: TurnOnItemKind,
  title: z.string(),
  detail: z.string().optional(),
  /** Whose move it is: ours, or the client's (it goes to their setup list). */
  owner: z.enum(["operator", "client"]),
  /** It keeps the button from starting the trial. Only ours ever do. */
  holds: z.boolean(),
  /** The step it is about, when it is about one. */
  stepId: z.string().optional(),
  /** Already so (shown with a check): tried, connected, allowed. */
  done: z.boolean().optional(),
  /**
   * A client item the trial's start waits on (the activation check refuses without it: a tool
   * not connected, a required role with nobody, a setup item that guards the trial). It doesn't
   * hold the button: Turn on does the rest, and the trial starts when it is pressed again.
   */
  waits: z.boolean().optional(),
});
export type TurnOnItem = z.infer<typeof TurnOnItem>;

/** Turn on's answer, the preview's and the button's alike. */
export const TurnOnAnswer = z.object({
  /** The client's agent that runs: the agent itself, or a template's copy at the client (null in a preview before the copy is made). */
  agentId: Id.nullable(),
  clientId: Id,
  clientName: z.string().optional(),
  /** The version turned on (the agent's own); after a start, the copy's live version. */
  versionId: Id,
  /** Its number, for "it publishes v3". */
  version: z.number().int().optional(),
  /** The trial (or live, for an agent that writes nothing) has started. */
  started: z.boolean(),
  stage: AgentStage,
  /** High-risk decisions first, then ours, then the client's. */
  items: z.array(TurnOnItem),
  /** Why the trial didn't start this time, as the activation check says it. */
  refused: z.array(z.string()).optional(),
});
export type TurnOnAnswer = z.infer<typeof TurnOnAnswer>;

export const TurnOnBody = z.strictObject({
  /** Required for a template: the client it is turned on for. */
  clientId: Id.optional(),
  /** The version to turn on; the latest when left out. */
  versionId: Id.optional(),
});
export type TurnOnBody = z.infer<typeof TurnOnBody>;

export const lifecycleRoutes = {
  opsAgentGoLive: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/go-live",
    auth: "session",
    roles: OPS,
    summary:
      "A client agent's go-live stage: the trial's days and runs, the client's sign-off, skips, rejections and pause",
    params: IdParams,
    response: z.object({ goLive: GoLive }),
  }),
  opsAgentStage: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/stage",
    auth: "session",
    roles: OPS,
    summary:
      "Move a client agent to another stage: forward past a stage with a reason (logged), or back at any time",
    params: IdParams,
    body: z.strictObject({ to: AgentStage, reason: StageReason.optional() }),
    response: z.object({ goLive: GoLive }),
  }),
  opsAgentTurnOnPreview: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/turn-on",
    auth: "session",
    roles: OPS,
    summary:
      "What Turn on would do for a template (at `?client=`) or a client agent, and what holds it: never tried, the validator's errors; what the client owes is listed and holds nothing. Changes nothing",
    params: IdParams,
    query: z.object({ client: Id.optional() }),
    response: TurnOnAnswer,
  }),
  opsAgentTurnOn: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/turn-on",
    auth: "session",
    roles: OPS,
    summary:
      "Turn on in one button: publish the version, copy a template to the client (or update its copy), bind the client's connections, activate and start the trial (every write signed); 409 with the items when something of ours holds it",
    params: IdParams,
    body: TurnOnBody,
    response: TurnOnAnswer,
  }),
  opsAgentTrial: defineRoute({
    method: "PUT",
    path: "/api/ops/agents/:id/trial",
    auth: "session",
    roles: OPS,
    summary: "Change a trial's minimum days and finished live runs (logged)",
    params: IdParams,
    body: z
      .strictObject({
        minDays: z.number().int().min(0).max(MAX_TRIAL_MIN_DAYS).optional(),
        minRuns: z.number().int().min(0).max(MAX_TRIAL_MIN_RUNS).optional(),
      })
      .refine((b) => b.minDays !== undefined || b.minRuns !== undefined, "nothing to change"),
    response: z.object({ goLive: GoLive }),
  }),
  opsRunOnEvent: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/run-event",
    auth: "session",
    roles: OPS,
    summary:
      "Start live runs of a client agent in trial, signoff or live on one of its client's past events (never a test run's); the router decides which workflows; 409 if it already ran",
    params: IdParams,
    body: z.strictObject({ eventId: Id }),
    response: z.object({
      runs: z.array(z.object({ runId: z.string(), workflow: z.string() })),
    }),
  }),
  // Audit 4.2: what came in while the agent was paused, and running it by hand.
  opsMissedEvents: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/missed-events",
    auth: "session",
    roles: OPS,
    summary:
      "The events of a client agent's last pause (within 30 days) that its live version would have started on and hasn't: how many, and the pause's start and end",
    params: IdParams,
    response: z.object({ missed: MissedWhilePaused.nullable() }),
  }),
  opsRunMissedEvents: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/missed-events/run",
    auth: "session",
    roles: OPS,
    summary:
      "Start live runs of a client agent on the events its last pause held back, oldest first, up to 50 a call; each runs once per event, as a past event does",
    params: IdParams,
    response: z.object({
      runs: z.array(z.object({ runId: z.string(), workflow: z.string() })),
      left: z.number().int(),
    }),
  }),
  portalServiceControls: defineRoute({
    method: "GET",
    path: "/api/controls",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Your services with who paused them, why and until when",
    response: z.object({ services: z.array(ServiceControl) }),
  }),
  portalPauseService: defineRoute({
    method: "POST",
    path: "/api/services/:id/pause",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Pause one service with a reason (and an end, if you want one): no new runs start",
    params: IdParams,
    body: PauseBody,
    response: z.object({ service: ServiceControl }),
  }),
  portalResumeService: defineRoute({
    method: "POST",
    path: "/api/services/:id/resume",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Resume a service you paused (a pause we made is ours to lift); `missedEvents` counts what came in while it was paused that it would have started on (none start by themselves), and `missed` adds the pause's start and end",
    params: IdParams,
    response: z.object({
      service: ServiceControl,
      missedEvents: z.number().int(),
      /** As the back office's go-live panel shows it (H7); null when it had no pause to count. */
      missed: MissedWhilePaused.nullable(),
    }),
  }),
  portalPauseAll: defineRoute({
    method: "POST",
    path: "/api/services/pause-all",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Pause every running service with a reason; the account agent stays on to help",
    body: PauseAllBody,
    response: z.object({ services: z.array(ServiceControl) }),
  }),
  portalResumeAll: defineRoute({
    method: "POST",
    path: "/api/services/resume-all",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Resume every service you paused; `missedEvents` counts what came in while they were paused that they would have started on (none start by themselves)",
    response: z.object({ services: z.array(ServiceControl), missedEvents: z.number().int() }),
  }),
  portalRunForms: defineRoute({
    method: "GET",
    path: "/api/services/:id/run-forms",
    auth: "session",
    roles: SIGNERS,
    summary: "The workflows of a service you may start yourself, with their forms",
    params: IdParams,
    response: z.object({ forms: z.array(RunForm) }),
  }),
  portalRunNow: defineRoute({
    method: "POST",
    path: "/api/services/:id/workflows/:slug/run",
    auth: "session",
    roles: SIGNERS,
    summary:
      "Start a workflow of a service with your form; checked against its form; viewers 403 cannot_sign",
    params: z.object({ id: Id, slug: Slug }),
    body: z.strictObject({ input: z.unknown().optional() }),
    response: z.object({ runId: z.string() }),
  }),
} as const;
