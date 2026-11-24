// Triggers and outputs (owner, 2026-11-23; docs/plan.md §1.238–§1.241, the mock-up "Ways in,
// ways out"): what each of an agent's workflows is to the others, for the builder's tabs and
// chart. The main workflow is the first enabled one (§1.240). An output is a workflow the main one
// hands off to (`to.agent: "@self"`); a trigger is a workflow that hands into the main one. Each
// trigger and output is a workflow of its own, opened by its tab as any workflow is.
//
// DECISION: worked out from the hand-offs, never stored. A role field could disagree with the
// steps that make it true, and every role here already has its step (§1.239's self hand-off).
// DECISION: an output wins over a trigger when a workflow is both (the main workflow hands off to
// it and it hands back in): it is reached from the main workflow, so it reads as where work goes.

import { selfHandoffSteps } from "./handoff";
import type { Process } from "./schema";

/** What a workflow is to the agent's others. `other`: none of these (or turned off, or v3). */
export type WorkflowRole = "main" | "trigger" | "output" | "other";

export interface WorkflowRoleInfo {
  role: WorkflowRole;
  /** The main workflow's slug (null when the agent has no enabled v4 workflow). */
  main: string | null;
  /**
   * A trigger: the main workflow's step it hands in at. An output: the main workflow's hand-off
   * step that starts it. Null otherwise.
   */
  at: string | null;
}

interface Entry {
  slug: string;
  enabled?: boolean | undefined;
  workflow: { schemaVersion: number };
}

const isProcess = (w: Entry["workflow"]): w is Process & { schemaVersion: 4 } =>
  w.schemaVersion === 4;

/** Every workflow's role, by slug, in the bundle's order. */
export function workflowRoles(workflows: readonly Entry[]): Map<string, WorkflowRoleInfo> {
  const roles = new Map<string, WorkflowRoleInfo>();
  const enabled = workflows.filter((w) => w.enabled !== false && isProcess(w.workflow));
  const main = enabled[0]?.slug ?? null;
  const other = (): WorkflowRoleInfo => ({ role: "other", main, at: null });
  for (const w of workflows) roles.set(w.slug, other());
  if (!main) return roles;
  roles.set(main, { role: "main", main, at: null });

  const live = new Set(enabled.map((w) => w.slug));
  const mainEntry = enabled[0] as Entry & { workflow: Process };
  // Outputs: what the main workflow hands off to, the first hand-off naming each.
  for (const step of selfHandoffSteps(mainEntry.workflow)) {
    const to = step.to.workflow;
    if (!to || to === main || !live.has(to) || roles.get(to)?.role === "output") continue;
    roles.set(to, { role: "output", main, at: step.id });
  }
  // Triggers: the others that hand into the main workflow.
  for (const w of enabled) {
    if (w.slug === main || roles.get(w.slug)?.role !== "other") continue;
    const into = selfHandoffSteps(w.workflow as Process).find((s) => s.to.workflow === main);
    if (into) roles.set(w.slug, { role: "trigger", main, at: into.to.step || null });
  }
  return roles;
}

/** Slugs of a role, in the bundle's order. */
export function workflowsOfRole(
  roles: ReadonlyMap<string, WorkflowRoleInfo>,
  role: WorkflowRole,
): string[] {
  return [...roles].filter(([, r]) => r.role === role).map(([slug]) => slug);
}
