// Hand off (owner, 2026-11-11; docs/plan.md §1.96): a hand-off step starts another client agent's
// run at one of its steps. The router decides (`handoffRunRequest`: same client, started, never
// the same agent, at most three handoffs deep); this writes the run row in the client's scope and
// starts its instance, as a dispatched run starts. And the other way: what a handed-off run's
// pages say about where it came from.

import { AgentsError } from "@countersign/agents";
import {
  type AnyBundleWorkflow,
  type HandoffRunPayload,
  isPlainObject,
  MAX_HANDOFF_DEPTH,
  processes,
  type RunHandoffView,
} from "@countersign/core";
import { agent, agentVersion, type Db, type Tx, withTenant } from "@countersign/db";
import {
  type HandoffNames,
  type HandoffPort,
  type HandoffRefusal,
  type HandoffRequest,
  handoffRunRequest,
  type RunRequest,
  selfHandoffRunRequest,
} from "@countersign/workflows";
import { and, eq } from "drizzle-orm";
import { createRunRow } from "./dispatch";
import type { RunInstances, RunParams } from "./instances";

/** The target as the router takes it, with its name and its live version's workflows. */
async function targetOf(tx: Tx, tenantId: string, slug: string) {
  const [row] = await tx
    .select({ a: agent, bundle: agentVersion.bundle })
    .from(agent)
    .leftJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
    )
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.slug, slug)));
  if (!row) return null;
  const { a, bundle } = row;
  return {
    name: a.serviceName ?? a.name,
    routable: {
      id: a.id,
      slug: a.slug,
      tenantId: a.tenantId,
      kind: a.kind,
      status: a.status,
      runStatus: a.runStatus,
      liveVersionId: a.liveVersionId,
      liveBundle: bundle ?? null,
    },
  };
}

/**
 * Ways in, ways out (2026-11-23): the sending agent as a self hand-off's router takes it, with the
 * sending run's own version (not its live one), and its name.
 */
async function selfOf(tx: Tx, run: HandoffRequest["run"]) {
  const [row] = await tx
    .select({ a: agent, bundle: agentVersion.bundle })
    .from(agent)
    .leftJoin(
      agentVersion,
      and(
        eq(agentVersion.id, run.agentVersionId),
        eq(agentVersion.tenantId, agent.tenantId),
        eq(agentVersion.agentId, agent.id),
      ),
    )
    .where(and(eq(agent.tenantId, run.tenantId), eq(agent.id, run.agentId)));
  if (!row) return null;
  const { a, bundle } = row;
  return {
    name: a.serviceName ?? a.name,
    bundle: bundle ?? null,
    routable: {
      id: a.id,
      slug: a.slug,
      tenantId: a.tenantId,
      kind: a.kind,
      status: a.status,
      runStatus: a.runStatus,
      liveVersionId: a.liveVersionId,
      liveBundle: null,
    },
  };
}

/** A self hand-off's names: the workflow it starts and its step there. */
function selfNames(
  self: Awaited<ReturnType<typeof selfOf>>,
  request: HandoffRequest,
): HandoffNames & { agentName: string } {
  const wf = self?.bundle?.workflows.find((w) => w.slug === request.to.workflow);
  return {
    agentName: self?.name ?? "",
    name: wf?.name ?? request.to.workflow ?? "",
    at: wf ? processes.handoffStepLabel(wf.workflow.steps, request.to.step) : request.to.step,
  };
}

/** "5 · Itemize the invoice": the step's place among the workflow's top-level steps. */
function atLabel(workflows: readonly AnyBundleWorkflow[] | undefined, step: string): string {
  const wf = workflows?.find((w) => w.enabled);
  return wf ? processes.handoffStepLabel(wf.workflow.steps, step) : step;
}

function refusalWords(refused: HandoffRefusal, name: string, step: string): string {
  switch (refused) {
    case "not_started":
      return `${name} isn't started, so the hand-off didn't run`;
    case "same_agent":
      return "a hand-off goes to another agent";
    case "too_deep":
      return `hand-offs go at most ${MAX_HANDOFF_DEPTH} deep, so this one didn't run`;
    case "unknown_agent":
      return `no agent "${name}" in this client`;
    case "unknown_step":
      return `${name}'s live version has no step "${step}"`;
    // Ways in, ways out (2026-11-23): `name` is the workflow's.
    case "same_workflow":
      return "a hand-off goes to another of this agent's workflows, not back into its own";
    case "unknown_workflow":
      return `this agent has no workflow "${name}"`;
    case "workflow_off":
      return `"${name}" is turned off, so the hand-off didn't run`;
  }
}

/** A self hand-off's refusal in plain words (the step's own workflow named where it helps). */
function selfRefusalWords(
  refused: HandoffRefusal,
  names: HandoffNames & { agentName: string },
  step: string,
): string {
  switch (refused) {
    case "not_started":
      return refusalWords(refused, names.agentName, step);
    case "unknown_step":
      return `"${names.name}" has no step "${step}" at its top level`;
    default:
      return refusalWords(refused, names.name, step);
  }
}

/** The port the executor hands off through, for one run. */
export function handoffPort(
  deps: { db: Db; instances?: RunInstances | undefined },
  params: Pick<RunParams, "trigger">,
): HandoffPort {
  const { db } = deps;
  const depth = params.trigger.type === "handoff" ? params.trigger.depth : 0;
  const namesOf = (
    target: Awaited<ReturnType<typeof targetOf>>,
    request: HandoffRequest,
  ): HandoffNames => ({
    name: target?.name ?? request.to.agent,
    at: atLabel(target?.routable.liveBundle?.workflows, request.to.step),
  });
  type Refused = Partial<HandoffNames> & { refused: string; notStarted?: boolean };
  type Decided = Refused | (HandoffNames & { request: RunRequest });
  /** Ways in, ways out (2026-11-23): a new run of this agent's version, in another workflow. */
  const decideSelf = (request: HandoffRequest): Promise<Decided> =>
    withTenant(db, request.run.tenantId, async (tx): Promise<Decided> => {
      const { run } = request;
      const self = await selfOf(tx, run);
      const named = selfNames(self, request);
      const r = await selfRequest(request, self, depth);
      if ("refused" in r) {
        // A paused agent is named as itself; anything else names the workflow.
        const notStarted = r.refused === "not_started";
        return {
          refused: selfRefusalWords(r.refused, named, request.to.step),
          name: notStarted ? named.agentName : named.name,
          at: named.at,
          ...(notStarted ? { notStarted: true } : {}),
        };
      }
      try {
        await createRunRow(tx, r.run);
      } catch (error) {
        if (error instanceof AgentsError && error.code === "invalid_state") {
          return {
            refused: refusalWords("not_started", named.agentName, ""),
            name: named.agentName,
            notStarted: true,
          };
        }
        throw error;
      }
      return { request: r.run, name: named.name, at: named.at };
    });
  return {
    names: (request) =>
      withTenant(db, request.run.tenantId, async (tx) => {
        if (request.to.agent === processes.SELF_AGENT) {
          const { agentName: _, ...names } = selfNames(await selfOf(tx, request.run), request);
          return names;
        }
        return namesOf(await targetOf(tx, request.run.tenantId, request.to.agent), request);
      }),
    async start(request) {
      const { run } = request;
      const instances = deps.instances;
      if (!instances) return { refused: "hand-offs can't start runs here" };
      const decided =
        request.to.agent === processes.SELF_AGENT
          ? await decideSelf(request)
          : await withTenant(db, run.tenantId, async (tx): Promise<Decided> => {
              const [self] = await tx
                .select({ slug: agent.slug })
                .from(agent)
                .where(and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)));
              const target = await targetOf(tx, run.tenantId, request.to.agent);
              const named = namesOf(target, request);
              const r = await handoffRunRequest(
                {
                  tenantId: run.tenantId,
                  from: {
                    runId: run.id,
                    agentId: run.agentId,
                    agentSlug: self?.slug ?? "",
                    workflowSlug: run.workflowSlug,
                    nodeId: request.nodeId,
                    depth,
                  },
                  to: request.to,
                  input: request.input,
                },
                target?.routable ?? null,
              );
              if ("refused" in r) {
                return {
                  refused: refusalWords(r.refused, named.name, request.to.step),
                  ...named,
                  ...(r.refused === "not_started" ? { notStarted: true } : {}),
                };
              }
              try {
                await createRunRow(tx, r.run);
              } catch (error) {
                // Paused between the check and the row: not started.
                if (error instanceof AgentsError && error.code === "invalid_state") {
                  return { refused: refusalWords("not_started", named.name, ""), notStarted: true };
                }
                throw error;
              }
              return { request: r.run, ...named };
            });
      if (!("request" in decided)) return decided;
      const { request: started, ...named } = decided;
      // After the row commits, as a dispatched run starts; the id is fixed, so a repeat is `exists`.
      await instances.start(started);
      return { runId: started.runId, ...named };
    },
  };
}

/** The router's self hand-off request for one step, from this run. */
async function selfRequest(
  request: HandoffRequest,
  self: Awaited<ReturnType<typeof selfOf>>,
  depth: number,
) {
  const { run } = request;
  return selfHandoffRunRequest(
    {
      tenantId: run.tenantId,
      from: {
        runId: run.id,
        agentId: run.agentId,
        agentSlug: self?.routable.slug ?? "",
        workflowSlug: run.workflowSlug,
        nodeId: request.nodeId,
        depth,
        agentVersionId: run.agentVersionId,
        mode: run.mode,
      },
      to: request.to,
      input: request.input,
    },
    self?.routable ?? null,
    self?.bundle ?? null,
  );
}

/**
 * A handed-off run's start (`ExecutorContext.start`): the step it starts at and that step's input,
 * as the hand-off step mapped it. Empty for any other run.
 */
export function handoffStart(params: Pick<RunParams, "trigger" | "payload">): {
  start?: { at: string; input: unknown };
} {
  if (params.trigger.type !== "handoff" || !params.trigger.at) return {};
  const payload = params.payload as Partial<HandoffRunPayload> | null;
  return { start: { at: params.trigger.at, input: payload?.input ?? {} } };
}

/**
 * Where a handed-off run came from, for its pages: the sending agent as the client knows it, its
 * run, and the step this one started at. Undefined for runs nothing handed off.
 */
export async function handedOffFrom(
  tx: Tx,
  tenantId: string,
  trigger: unknown,
  workflow: { steps: readonly { id: string; name: string }[] } | null | undefined,
): Promise<RunHandoffView | undefined> {
  if (!isPlainObject(trigger) || trigger.type !== "handoff") return undefined;
  const fromRunId = typeof trigger.fromRunId === "string" ? trigger.fromRunId : null;
  if (!fromRunId) return undefined;
  const payload = isPlainObject(trigger.payload) ? trigger.payload : {};
  const from = isPlainObject(payload.from) ? payload.from : {};
  const agentId = typeof from.agentId === "string" ? from.agentId : null;
  const [row] = agentId
    ? await tx
        .select({ name: agent.name, serviceName: agent.serviceName })
        .from(agent)
        .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)))
    : [];
  const at = typeof trigger.at === "string" ? trigger.at : null;
  // Ways in, ways out (2026-11-23): a run this agent's other workflow handed off names that
  // workflow, as it was called when it handed off.
  const workflowName = typeof from.workflowName === "string" ? from.workflowName : null;
  return {
    fromRunId,
    fromAgent:
      workflowName ??
      row?.serviceName ??
      row?.name ??
      (typeof from.agentSlug === "string" ? from.agentSlug : ""),
    at: at && workflow ? processes.handoffStepLabel(workflow.steps, at) : at,
  };
}
