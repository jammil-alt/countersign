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
