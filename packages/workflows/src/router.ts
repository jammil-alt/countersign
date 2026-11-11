// The trigger router (ARCHITECTURE §10.3; docs/plan.md §1.2 "Starting runs"): pure functions from
// a sense event, or a cron tick, plus the candidate agents with their live bundles, to the runs to
// start. apps/api loads the candidates (inside the client's scope) and calls
// `env.RUN_WORKFLOW.create({ id: runId, params })` for each request. Run ids for triggered runs are
// uuid v5, so a re-dispatched event or a repeated tick asks for the same instance twice and
// Cloudflare refuses the second.

import {
  type AccountRequestPassedPayload,
  type AnyAgentBundle,
  type AnyBundleWorkflow,
  allTriggers,
  evaluateRules,
  eventRunId,
  type HandoffRunPayload,
  handoffRunId,
  type InboundMessagePayload,
  isDayOff,
  MAX_HANDOFF_DEPTH,
  type MessageChannel,
  type MessageRunPayload,
  matchesPeople,
  type Rules,
  type RunSucceededPayload,
  rateWindowSeconds,
  renderTemplate,
  type SenderFacts,
  scheduleRunId,
  type ThreadMessagePostedPayload,
  type Trigger,
  type TriggerOn,
  uuidv7,
  webhookRunId,
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
  /** R3: its workflows may be v3 workflows or v4 processes. */
  liveBundle: AnyAgentBundle | null;
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
    }
  // v0.12 W2-E: the new kinds, each with the event that fired it (docs/plan.md §1.48).
  | {
      triggerId: string;
      type: "webhook";
      eventId: string;
      eventType: string;
      hookId: string;
      /** The evaluated `dedupeKey`, when the trigger has one. */
      dedupeKey?: string;
    }
  | {
      triggerId: string;
      type: "message";
      eventId: string;
      eventType: string;
      channel: MessageChannel;
    }
  | {
      triggerId: string;
      type: "handoff";
      /** A handoff trigger's `run.succeeded`; absent when a hand-off step started the run. */
      eventId?: string;
      eventType?: string;
      fromRunId: string;
      depth: number;
      // Hand off (owner, 2026-11-11): a hand-off step's run.
      /** The top-level step the run starts at (the steps before it are skipped). */
      at?: string;
      /** The sending agent (its id) and its hand-off step. */
      fromAgentId?: string;
      fromStep?: string;
    };

// v0.12 W2-E
/** A guard the dispatcher checks before it creates the run (it needs the database). */
export interface RunLimit {
  /** Runs of this trigger in the window are counted against `max`. */
  triggerId: string;
  max: number;
  windowSeconds: number;
  /** Where a limited delivery is counted (`connection.sync_cursor.hooks[hookId].limited`). */
  hookId: string;
  connectionId: string;
}

/** Who sent a message, from the client's own records; apps/api reads it inside the client's scope. */
export type SenderLookup = (ref: {
  contactId: string | null;
  userId: string | null;
}) => Promise<SenderFacts>;

export interface RouteOptions {
  /** Without it, every message trigger sees a stranger and starts nothing. */
  sender?: SenderLookup;
}

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
  // v0.12 W2-E: a webhook trigger's rate limit, checked by the dispatcher.
  limit?: RunLimit;
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
  agent: RoutableAgent & { tenantId: string; liveVersionId: string; liveBundle: AnyAgentBundle };
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
    // v0.12 W2-E: every trigger of the workflow, `moreTriggers` too.
    for (const trigger of triggersOfWorkflow(wf.workflow)) {
      if (trigger.on.type === type) {
        yield {
          slug: wf.slug,
          triggerId: trigger.id,
          on: trigger.on as Extract<TriggerOn, { type: T }>,
        };
      }
    }
  }
}

/** Events that report on one agent's own run, with the agent's id in `payload.agentId`. */
// v0.12 W2-E: `run.succeeded` too, so an agent watching successes never starts on its own.
export const OWN_RUN_EVENTS: ReadonlySet<string> = new Set(["run.failed", "run.succeeded"]);

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
  // v0.12 W2-E
  options: RouteOptions = {},
): Promise<RouteResult> {
  const runs: RunRequest[] = [];
  const problems: RouteProblem[] = [];
  for (const agent of agents) {
    // A client's event starts only that client's agents, whatever the caller passed in.
    if (!isRunnable(agent) || agent.tenantId !== event.tenantId) continue;
    // An agent is never started by its own run's failure: one that watches failures (the
    // supervisor, docs/plan.md §1.28) and then fails itself can't loop.
    if (aboutOwnRun(event, agent.id)) continue;
    // v0.12 W2-E: webhook, message and handoff triggers (docs/plan.md §1.48).
    const more = await routeW2E(event, agent, options, problems);
    for (const r of more) if (!runs.some((x) => x.runId === r.runId)) runs.push(r);
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
      const runId = await eventRunId({ eventId: event.id, agentId: agent.id, workflowSlug: slug });
      // v0.12 W2-E: two triggers of one workflow on the same event start it once.
      if (runs.some((r) => r.runId === runId)) continue;
      runs.push({
        runId,
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

// ── v0.12 W2-E: webhook, message and handoff triggers (docs/plan.md §1.48) ──────────────────────

const WEBHOOK_RECEIVED = "webhook.received";

function passes(
  filter: Rules | undefined,
  payload: unknown,
  agentId: string,
  slug: string,
  problems: RouteProblem[],
): boolean {
  if (!filter) return true;
  try {
    return evaluateRules(filter, { trigger: payload, steps: {} });
  } catch (error) {
    problems.push({ agentId, workflowSlug: slug, message: String(error) });
    return false;
  }
}

/** The message a message trigger answers, in one shape for every channel. */
function messageOf(event: RoutableEvent, agentId: string): MessageRunPayload | null {
  if (event.type === "inbound.message") {
    const p = event.payload as InboundMessagePayload;
    if (p?.agentId !== agentId) return null;
    return {
      channel: p.channel,
      contactId: p.contactId,
      userId: p.userId,
      rawRecordId: p.rawRecordId,
      threadId: null,
      messageId: null,
      documents: p.documents ?? [],
    };
  }
  if (event.type === "thread.message_posted") {
    const p = event.payload as ThreadMessagePostedPayload;
    // An agent command posted by a person; an operator's `/skill` on an agent thread is not one.
    if (p?.command?.agentId !== agentId || p.command.skill || p.senderType !== "user") return null;
    return {
      channel: "command",
      contactId: null,
      userId: p.senderId,
      rawRecordId: null,
      threadId: p.threadId,
      messageId: p.messageId,
      documents: [],
    };
  }
  if (event.type === "account.request_passed") {
    const p = event.payload as AccountRequestPassedPayload;
    if (p?.agentId !== agentId) return null;
    return {
      channel: "sloan",
      contactId: null,
      userId: p.userId,
      rawRecordId: null,
      threadId: p.threadId,
      messageId: p.messageId,
      documents: [],
    };
  }
  return null;
}

async function routeW2E(
  event: RoutableEvent,
  agent: Live["agent"],
  options: RouteOptions,
  problems: RouteProblem[],
): Promise<RunRequest[]> {
  const out: RunRequest[] = [];
  const base = {
    tenantId: agent.tenantId,
    agentId: agent.id,
    agentVersionId: agent.liveVersionId,
    mode: "live" as const,
  };
  const add = (r: RunRequest) => {
    if (!out.some((x) => x.runId === r.runId)) out.push(r);
  };

  if (event.type === WEBHOOK_RECEIVED) {
    const p = event.payload as { hookId?: unknown; connectionId?: unknown } | null;
    for (const { slug, triggerId, on } of triggersOf(agent, "webhook")) {
      if (p?.hookId !== on.hookId) continue;
      if (!passes(on.filter, event.payload, agent.id, slug, problems)) continue;
      let key = "";
      if (on.dedupeKey !== undefined) {
        try {
          key = renderTemplate(on.dedupeKey, { trigger: event.payload, steps: {} }).trim();
        } catch (error) {
          problems.push({ agentId: agent.id, workflowSlug: slug, message: String(error) });
          continue;
        }
      }
      // DECISION: a dedupe key that renders empty doesn't dedupe: the delivery gets its own run.
      const runId = key
        ? await webhookRunId({ agentId: agent.id, workflowSlug: slug, key: key.slice(0, 500) })
        : await eventRunId({ eventId: event.id, agentId: agent.id, workflowSlug: slug });
      add({
        ...base,
        runId,
        workflowSlug: slug,
        trigger: {
          triggerId,
          type: "webhook",
          eventId: event.id,
          eventType: event.type,
          hookId: on.hookId,
          ...(key ? { dedupeKey: key.slice(0, 500) } : {}),
        },
        payload: event.payload,
        ...(on.rateLimit
          ? {
              limit: {
                triggerId,
                max: on.rateLimit.max,
                windowSeconds: rateWindowSeconds(on.rateLimit),
                hookId: on.hookId,
                connectionId: typeof p?.connectionId === "string" ? p.connectionId : "",
              },
            }
          : {}),
      });
    }
  }

  const message = messageOf(event, agent.id);
  if (message) {
    const triggers = [...triggersOf(agent, "message")].filter((t) =>
      t.on.channels.includes(message.channel),
    );
    if (triggers.length > 0) {
      const sender: SenderFacts = options.sender
        ? await options.sender({ contactId: message.contactId, userId: message.userId })
        : { kind: "stranger" };
      for (const { slug, triggerId, on } of triggers) {
        // Only senders the trigger's People filter takes (ARCHITECTURE §10.8).
        if (!matchesPeople(on.from, sender)) continue;
        add({
          ...base,
          runId: await eventRunId({ eventId: event.id, agentId: agent.id, workflowSlug: slug }),
          workflowSlug: slug,
          trigger: {
            triggerId,
            type: "message",
            eventId: event.id,
            eventType: event.type,
            channel: message.channel,
          },
          payload: message,
        });
      }
    }
  }

  if (event.type === "run.succeeded") {
    const p = event.payload as RunSucceededPayload;
    // Never the same agent, and at most three handoffs deep (ARCHITECTURE §10.8).
    if (p && p.agentId !== agent.id && p.depth <= MAX_HANDOFF_DEPTH) {
      const payload: HandoffRunPayload = {
        from: {
          agentId: p.agentId,
          agentSlug: p.agentSlug,
          workflowSlug: p.workflowSlug,
          runId: p.runId,
        },
        output: p.output ?? null,
        sources: p.sources ?? [],
        depth: p.depth,
      };
      for (const { slug, triggerId, on } of triggersOf(agent, "handoff")) {
        if (on.from.agent !== p.agentSlug) continue;
        if (on.from.workflow !== undefined && on.from.workflow !== p.workflowSlug) continue;
        if (!passes(on.filter, payload, agent.id, slug, problems)) continue;
        add({
          ...base,
          runId: await eventRunId({ eventId: event.id, agentId: agent.id, workflowSlug: slug }),
          workflowSlug: slug,
          trigger: {
            triggerId,
            type: "handoff",
            eventId: event.id,
            eventType: event.type,
            fromRunId: p.runId,
            depth: p.depth,
          },
          payload,
        });
      }
    }
  }
  return out;
}

// ── Hand off (owner, 2026-11-11; docs/plan.md §1.95) ────────────────────────────────────────────

/** Why a hand-off step started nothing. */
export type HandoffRefusal =
  | "same_agent"
  | "too_deep"
  | "unknown_agent"
  | "not_started"
  | "unknown_step";

/** What a hand-off step asks for, from the run it is in. */
export interface HandoffAsk {
  tenantId: string;
  from: {
    runId: string;
    agentId: string;
    agentSlug: string;
    workflowSlug: string;
    /** The hand-off step's durable name. */
    nodeId: string;
    /** The sending run's own handoff depth (0 unless a handoff started it). */
    depth: number;
  };
  to: { agent: string; step: string };
  input: unknown;
}

/**
 * The run a hand-off step starts: the live version of the target (another client agent of the same
 * client, started), its enabled process whose top-level steps hold `to.step`, starting there with
 * the mapped input. The rules of handoff triggers hold: never the same agent, at most three
 * handoffs deep (ARCHITECTURE §10.8). The run id derives from the sending run and step, so asking
 * twice starts one run.
 */
export async function handoffRunRequest(
  ask: HandoffAsk,
  target: (RoutableAgent & { slug: string }) | null,
): Promise<{ run: RunRequest } | { refused: HandoffRefusal }> {
  if (ask.to.agent === ask.from.agentSlug || target?.id === ask.from.agentId) {
    return { refused: "same_agent" };
  }
  const depth = ask.from.depth + 1;
  if (depth > MAX_HANDOFF_DEPTH) return { refused: "too_deep" };
  if (target?.kind !== "client" || target.tenantId !== ask.tenantId) {
    return { refused: "unknown_agent" };
  }
  if (!isRunnable(target)) return { refused: "not_started" };
  // DECISION: a hand-off starts the live version's first enabled workflow (an agent owns one
  // process; a stored v3 agent may hold more), as packages/agents' `handoffAgents` lists it.
  const wf = target.liveBundle.workflows.find((w) => w.enabled);
  if (!wf?.workflow.steps.some((s) => s.id === ask.to.step)) {
    return { refused: "unknown_step" };
  }
  const payload: HandoffRunPayload = {
    from: {
      agentId: ask.from.agentId,
      agentSlug: ask.from.agentSlug,
      workflowSlug: ask.from.workflowSlug,
      runId: ask.from.runId,
    },
    output: null,
    sources: [],
    depth,
    at: ask.to.step,
    input: ask.input,
  };
  return {
    run: {
      runId: await handoffRunId({ fromRunId: ask.from.runId, nodeId: ask.from.nodeId }),
      tenantId: target.tenantId,
      agentId: target.id,
      agentVersionId: target.liveVersionId,
      workflowSlug: wf.slug,
      mode: "live",
      trigger: {
        triggerId: ask.from.nodeId,
        type: "handoff",
        fromRunId: ask.from.runId,
        depth,
        at: ask.to.step,
        fromAgentId: ask.from.agentId,
        fromStep: ask.from.nodeId,
      },
      payload,
    },
  };
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
  // v0.12 W2-E
  /** Each client's own days off (`tenant.settings.holidays`), for `skipHolidays`. */
  holidays?: Readonly<Record<string, readonly string[]>>;
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
      // v0.12 W2-E: a tick on a holiday, in the zone it is scheduled in, is skipped.
      if (on.skipHolidays) {
        const own = input.holidays?.[agent.tenantId] ?? [];
        ticks = ticks.filter((t) => !isDayOff(t, tz, own));
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
  bundle?: AnyAgentBundle;
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
  // v0.12 W2-E: a manual or command trigger among `moreTriggers` lets it start by hand too.
  const byHand =
    triggersOfWorkflow(wf.workflow).find(
      (t) => t.on.type === "manual" || t.on.type === "command",
    ) ?? firstTrigger(wf.workflow);
  const type = byHand.on.type;
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
      triggerId: byHand.id,
      type: type === "command" ? "command" : "manual",
    },
    payload: input.payload,
  };
}

// ── R3: v4 processes (docs/plan.md §1.86, §9) ───────────────────────────────────────────────────

/** Every trigger of a workflow: a v3 workflow's `trigger` and `moreTriggers`, a process's list (core). */
export function triggersOfWorkflow(workflow: AnyBundleWorkflow["workflow"]): Trigger[] {
  return allTriggers(workflow);
}

/** The workflow's first trigger (a process has at least one). */
function firstTrigger(workflow: AnyBundleWorkflow["workflow"]): Trigger {
  const first = workflow.schemaVersion === 4 ? workflow.triggers[0] : workflow.trigger;
  if (!first) throw new Error("a process needs a trigger");
  return first;
}
