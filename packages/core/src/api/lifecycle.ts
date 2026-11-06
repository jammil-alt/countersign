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
import { defineRoute } from "./contract";

// Go-live stages (ARCHITECTURE §10.9), client controls (§11.5) and running a client agent live on a
// past event (docs/plan.md §1.36, W1-A). The stage routes are the operator's; the client admin
// pauses and resumes; Run now is for the client admin and signing client users.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;
// TODO(W1-D): signing client users only, once `membership.can_sign` exists (viewers get 403).
const SIGNERS = ["client_admin", "client_user"] as const;

/** Why the operator moved an agent: required to move forward past a stage, optional back. */
export const StageReason = z.string().trim().min(1).max(500);

/** Where a client agent is on its way live, for the back office's agent page. */
export const GoLive = z.object({
  stage: AgentStage.nullable(),
  /** Whether its live version writes to a client's tool (no writes: bench goes straight to live). */
  writes: z.boolean(),
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

/** A workflow the client may start by hand, with the form its trigger asks for. */
export const RunForm = z.object({
  workflow: Slug,
  label: z.string(),
  input: JsonSchema,
});
export type RunForm = z.infer<typeof RunForm>;

export const PauseAllBody = PauseBody;
export { MAX_PAUSE_REASON };

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
    summary: "Resume a service you paused (a pause we made is ours to lift)",
    params: IdParams,
    response: z.object({ service: ServiceControl }),
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
    summary: "Resume every service you paused",
    response: z.object({ services: z.array(ServiceControl) }),
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
    summary: "Start a workflow of a service with your form; checked against its form",
    params: z.object({ id: Id, slug: Slug }),
    body: z.strictObject({ input: z.unknown().optional() }),
    response: z.object({ runId: z.string() }),
  }),
} as const;
