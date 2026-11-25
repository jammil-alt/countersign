// Hand off (owner, 2026-11-11; docs/plan.md §1.96): the client's agents a hand-off step can start,
// with their live versions' top-level steps (names, kinds, input schemas, what each reads). The
// server validates hand-off steps with it at publish, and the builder gets the same list, so both
// say the same thing (invariant 4: one validator).

import {
  type AgentBundle,
  collectRefs,
  processes,
  steps,
  type ToolSpec,
  toProcessBundle,
} from "@countersign/core";
import { agent, agentVersion, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { RegistryContext } from "./agents";
import { convertLookup, skillContext } from "./skills";

/**
 * Whether a bundle has a hand-off step to another agent (only those versions need the client's
 * agents; a hand-off to this agent's own workflow is checked against the bundle alone).
 */
export function holdsHandoff(bundle: AgentBundle): boolean {
  return bundle.workflows.some(
    (w) =>
      w.workflow.schemaVersion === 4 &&
      processes
        .allSteps(w.workflow)
        .some((l) => l.step.kind === "handoff" && !processes.isSelfHandoff(l.step)),
  );
}

/**
 * A client's client agents as hand-off targets: each with the first enabled process of its live
 * version (the one a hand-off starts, as the router picks it) and that process's top-level steps.
 * Retired agents are left out; an agent without a live version is listed with no steps.
 */
// DECISION: the first enabled workflow of the live version is the one a hand-off starts (an agent
// owns one process; a stored v3 agent may hold more), here and in the router alike.
export async function handoffAgents(
  tx: Tx,
  tenantId: string,
  ctx: Pick<RegistryContext, "tools" | "catalog">,
): Promise<processes.HandoffAgent[]> {
  const rows = await tx
    .select({ a: agent, bundle: agentVersion.bundle })
    .from(agent)
    .leftJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
    )
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.testCopy, false)))
    .orderBy(agent.name);
  const lookup = convertLookup(ctx.catalog, ctx.tools);
  const out: processes.HandoffAgent[] = [];
  for (const { a, bundle } of rows) {
    if (a.runStatus === "retired") continue;
    const name = a.serviceName ?? a.name;
    const wf = bundle ? (bundle.workflows.find((w) => w.enabled) ?? null) : null;
    if (!bundle || !wf) {
      out.push({ slug: a.slug, name, workflow: null, steps: [] });
      continue;
    }
    if (wf.workflow.schemaVersion === 5) {
      out.push({
        slug: a.slug,
        name,
        workflow: wf.slug,
        steps: stepModelTargets(wf.workflow, ctx.tools.specs(a.bindings)),
      });
      continue;
    }
    const { skills } = await skillContext(tx, { tenantId, bundle, catalog: ctx.catalog });
    const process = toProcessBundle({ ...bundle, workflows: [wf] }, lookup).workflows[0]?.workflow;
    out.push({
      slug: a.slug,
      name,
      workflow: wf.slug,
      steps: process
        ? processes.handoffTargetSteps(process, { skills, tools: ctx.tools.specs(a.bindings) })
        : [],
    });
  }
  return out;
}

/**
 * The step model: a v5 workflow's top-level steps as hand-off targets, each named by the engine
 * that runs it (`steps.ENGINE_OUTCOMES`: a Do on a Get action is a `read`), so the hand-off
 * picker offers the same work steps as for a v4 process. Their input schemas come with the
 * builder's forms (stream B); until then none is given.
 */
function stepModelTargets(
  workflow: steps.Workflow,
  tools: Readonly<Record<string, ToolSpec>>,
): processes.HandoffTargetStep[] {
  const kindOf = (action: string): steps.ActionKind | undefined => {
    const own = tools[action];
    if (own) return steps.actionKind(own);
    const first = Object.values(steps.mergedAction(action)?.tools ?? {})
      .map((t) => tools[t])
      .find((t) => t !== undefined);
    return first ? steps.actionKind(first) : undefined;
  };
  const kindOfStep = (step: steps.Step): processes.HandoffTargetStep["kind"] => {
    switch (step.kind) {
      case "do":
        try {
          return steps.ENGINE_OUTCOMES[steps.doEngine(step, kindOf).engine] as never;
        } catch {
          return "missing";
        }
      case "loop":
        return "skill";
      case "fork":
        return "if";
      case "end":
        return "stop";
      default:
        return step.kind;
    }
  };
  return workflow.steps.map((step) => {
    const reads = new Set<string>();
    for (const ref of collectRefs(step).refs) {
      if (ref.path[0] === "steps" && typeof ref.path[1] === "string") reads.add(ref.path[1]);
    }
    const ids: string[] = [];
    steps.eachStep([step], ({ step: s }) => ids.push(s.id));
    return { id: step.id, name: step.name, kind: kindOfStep(step), reads: [...reads], ids };
  });
}
