// Hand off (owner, 2026-11-11; docs/plan.md §1.96): the client's agents a hand-off step can start,
// with their live versions' top-level steps (names, kinds, input schemas, what each reads). The
// server validates hand-off steps with it at publish, and the builder gets the same list, so both
// say the same thing (invariant 4: one validator).

import { type AnyAgentBundle, processes, toProcessBundle } from "@countersign/core";
import { agent, agentVersion, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { RegistryContext } from "./agents";
import { convertLookup, skillContext } from "./skills";

/** Whether a bundle has a hand-off step (only those versions need the client's agents). */
export function holdsHandoff(bundle: AnyAgentBundle): boolean {
  return bundle.workflows.some(
    (w) =>
      w.workflow.schemaVersion === 4 &&
      processes.allSteps(w.workflow).some((l) => l.step.kind === "handoff"),
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
