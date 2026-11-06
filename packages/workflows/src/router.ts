// The trigger router (ARCHITECTURE §10.3; docs/plan.md §1.2 "Starting runs"): pure functions from
// a sense event, or a cron tick, plus the candidate agents with their live bundles, to the runs to
// start. apps/api loads the candidates (inside the client's scope) and calls
// `env.RUN_WORKFLOW.create({ id: runId, params })` for each request. Run ids for triggered runs are
// uuid v5, so a re-dispatched event or a repeated tick asks for the same instance twice and
// Cloudflare refuses the second.

import {
  type AgentBundle,
  evaluateRules,
  eventRunId,
  scheduleRunId,
  type TriggerOn,
  uuidv7,
} from "@countersign/core";
import { CronExpressionParser } from "cron-parser";

/** An agent row with its live bundle, as apps/api loads it. */
export interface RoutableAgent {
  id: string;
  tenantId: string | null;
  kind: "template" | "client";
  status: "active" | "disabled";
  /** Client agents: draft | testing | active | paused | retired. */
  runStatus: string | null;
  liveVersionId: string | null;
  /** The bundle of `liveVersionId`. */
  liveBundle: AgentBundle | null;
}

export interface RoutableEvent {
  id: string;
  tenantId: string;
  type: string;
  payload: unknown;
}

/** What `run.trigger` records about why a run started. */
export type RunTrigger =
  | {
      triggerId: string;
      type: "event";
      eventId: string;
      eventType: string;
      // v0.12 W1-A: an operator who started this live run on a past event (ARCHITECTURE §10.9).
      replayedBy?: string;
    }
  | { triggerId: string; type: "schedule"; cron: string; tz: string; scheduledAt: string }
  | {
      triggerId: string;
      type: "manual" | "command";
      // v0.12 W1-A: a client person who started it with Run now (ARCHITECTURE §11.5).
      startedBy?: { userId: string };
    };

export interface RunRequest {
  runId: string;
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  workflowSlug: string;
  mode: "live" | "test";
  trigger: RunTrigger;
  /** What the run's `{{trigger.…}}` templates read (executeWorkflow's `trigger`). */
  payload: unknown;
}

export interface RouteProblem {
  agentId: string;
  workflowSlug: string;
  message: string;
}

export interface RouteResult {
  runs: RunRequest[];
  /** Workflows that matched but couldn't be evaluated (validation should have caught them). */
  problems: RouteProblem[];
}

interface Live {
  agent: RoutableAgent & { tenantId: string; liveVersionId: string; liveBundle: AgentBundle };
}

/**
 * Only the live version of an active client agent runs (ARCHITECTURE §10.3): templates never run
 * except as tests, and paused, draft, testing or retired client agents start nothing.
 */
export function isRunnable(agent: RoutableAgent): agent is Live["agent"] {
  return (
    agent.kind === "client" &&
    agent.tenantId !== null &&
    agent.status === "active" &&
    agent.runStatus === "active" &&
    agent.liveVersionId !== null &&
    agent.liveBundle !== null
  );
}

function* triggersOf<T extends TriggerOn["type"]>(
  agent: Live["agent"],
  type: T,
): Generator<{ slug: string; triggerId: string; on: Extract<TriggerOn, { type: T }> }> {
  for (const wf of agent.liveBundle.workflows) {
    if (!wf.enabled) continue;
    const { trigger } = wf.workflow;
    if (trigger.on.type === type) {
      yield {
        slug: wf.slug,
        triggerId: trigger.id,
        on: trigger.on as Extract<TriggerOn, { type: T }>,
      };
    }
  }
}

/** Events that report on one agent's own run, with the agent's id in `payload.agentId`. */
export const OWN_RUN_EVENTS: ReadonlySet<string> = new Set(["run.failed"]);

// DECISION: the loop guard is in the router and covers every agent, rather than a filter each
// workflow must remember: a `run.failed` about agent X never starts X.
function aboutOwnRun(event: RoutableEvent, agentId: string): boolean {
  if (!OWN_RUN_EVENTS.has(event.type)) return false;
  const payload = event.payload as { agentId?: unknown } | null;
  return payload?.agentId === agentId;
}

/**
 * The runs an event starts: every enabled workflow, in the live version of each runnable agent of
 * the event's own client, whose trigger names the event type and whose filter matches.
 */
export async function routeEvent(
  event: RoutableEvent,
  agents: readonly RoutableAgent[],
): Promise<RouteResult> {
  const runs: RunRequest[] = [];
  const problems: RouteProblem[] = [];
  for (const agent of agents) {
    // A client's event starts only that client's agents, whatever the caller passed in.
    if (!isRunnable(agent) || agent.tenantId !== event.tenantId) continue;
    // An agent is never started by its own run's failure: one that watches failures (the
    // supervisor, docs/plan.md §1.28) and then fails itself can't loop.
    if (aboutOwnRun(event, agent.id)) continue;
    for (const { slug, triggerId, on } of triggersOf(agent, "event")) {
      if (on.event !== event.type) continue;
      if (on.filter) {
        try {
          if (!evaluateRules(on.filter, { trigger: event.payload, steps: {} })) continue;
        } catch (error) {
          problems.push({ agentId: agent.id, workflowSlug: slug, message: String(error) });
          continue;
        }
      }
      runs.push({
        runId: await eventRunId({ eventId: event.id, agentId: agent.id, workflowSlug: slug }),
        tenantId: agent.tenantId,
        agentId: agent.id,
        agentVersionId: agent.liveVersionId,
        workflowSlug: slug,
        mode: "live",
        trigger: { triggerId, type: "event", eventId: event.id, eventType: event.type },
        payload: event.payload,
      });
    }
  }
  return { runs, problems };
}

export interface DueSchedulesInput {
  agents: readonly RoutableAgent[];
  /** Each client's IANA timezone (`tenant.timezone`); a trigger's own `tz` wins. Default UTC. */
  timezones: Readonly<Record<string, string>>;
  /** Ticks strictly after `from`… */
  from: Date;
  /** …and at or before `to`: the cron passes (its previous run, now]. */
  to: Date;
  /** Most recent ticks kept per trigger in one window. Default 1. */
  maxPerTrigger?: number;
}

/**
 * Schedule triggers due in (from, to], each evaluated in the client's timezone. Run ids are
 * uuid v5 of (agent, workflow, tick), so overlapping windows ask for the same run twice and only
 * the first starts.
 */
export async function dueSchedules(input: DueSchedulesInput): Promise<RouteResult> {
  // DECISION: after a gap (the cron didn't run for a while) only the latest tick per trigger in
  // the window runs; missed ticks are not replayed one by one.
  const keep = input.maxPerTrigger ?? 1;
  const runs: RunRequest[] = [];
  const problems: RouteProblem[] = [];
  for (const agent of input.agents) {
    if (!isRunnable(agent)) continue;
    for (const { slug, triggerId, on } of triggersOf(agent, "schedule")) {
      const tz = on.tz ?? input.timezones[agent.tenantId] ?? "UTC";
      let ticks: Date[];
      try {
        ticks = ticksBetween(on.cron, tz, input.from, input.to);
      } catch (error) {
        problems.push({ agentId: agent.id, workflowSlug: slug, message: String(error) });
        continue;
      }
      for (const tick of ticks.slice(-keep)) {
        const scheduledAt = tick.toISOString();
        runs.push({
          runId: await scheduleRunId({ agentId: agent.id, workflowSlug: slug, scheduledAt }),
          tenantId: agent.tenantId,
          agentId: agent.id,
          agentVersionId: agent.liveVersionId,
          workflowSlug: slug,
          mode: "live",
          trigger: { triggerId, type: "schedule", cron: on.cron, tz, scheduledAt },
          payload: { scheduledAt },
        });
      }
    }
  }
  return { runs, problems };
}

// A guard against expressions like "* * * * * *" over a long window.
const MAX_TICKS = 10_000;

/** Every tick of `cron` in `tz` that falls in (from, to]. */
export function ticksBetween(cron: string, tz: string, from: Date, to: Date): Date[] {
  if (to.getTime() <= from.getTime()) return [];
  const expr = CronExpressionParser.parse(cron, { tz, currentDate: from, endDate: to });
  const out: Date[] = [];
  while (expr.hasNext() && out.length < MAX_TICKS) {
    const tick = expr.next().toDate();
    if (tick.getTime() <= from.getTime()) continue;
    if (tick.getTime() > to.getTime()) break;
    out.push(tick);
  }
  return out;
}

/**
 * A run started by a person or the API (manual, command, or a test run): a fresh uuid v7. The
 * version defaults to the live one; a test run may name any version of the agent (e.g. a draft).
 */
export function requestRun(input: {
  agent: RoutableAgent;
  workflowSlug: string;
  payload: unknown;
  mode?: "live" | "test";
  versionId?: string;
  bundle?: AgentBundle;
  now?: number;
}): RunRequest {
  const { agent } = input;
  const mode = input.mode ?? "live";
  if (agent.kind !== "client" || agent.tenantId === null) {
    throw new Error("only a client agent runs for a client");
  }
  if (mode === "live" && !isRunnable(agent)) {
    throw new Error(`agent ${agent.id} is not active with a live version`);
  }
  if (mode === "live" && input.versionId && input.versionId !== agent.liveVersionId) {
    throw new Error("a live run uses the live version");
  }
  const versionId = input.versionId ?? agent.liveVersionId;
  const bundle = input.bundle ?? agent.liveBundle;
  if (!versionId || !bundle) throw new Error(`agent ${agent.id} has no version to run`);
  const wf = bundle.workflows.find((w) => w.slug === input.workflowSlug);
  if (!wf) throw new Error(`no workflow ${input.workflowSlug}`);
  if (mode === "live" && !wf.enabled) throw new Error(`workflow ${input.workflowSlug} is off`);
  const type = wf.workflow.trigger.on.type;
  if (mode === "live" && type !== "manual" && type !== "command") {
    throw new Error(`workflow ${input.workflowSlug} starts on its ${type} trigger, not by hand`);
  }
  return {
    runId: uuidv7(input.now),
    tenantId: agent.tenantId,
    agentId: agent.id,
    agentVersionId: versionId,
    workflowSlug: wf.slug,
    mode,
    trigger: {
      triggerId: wf.workflow.trigger.id,
      type: type === "command" ? "command" : "manual",
    },
    payload: input.payload,
  };
}
