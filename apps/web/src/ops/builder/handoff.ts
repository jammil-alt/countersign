// Hand off (owner, 2026-11-11; docs/plan.md §1.96): a client agent's builder gets its client's
// agents with their live versions' top-level steps, for the hand-off step's pickers, its input
// fields and the validator (the server checks against the same list).
import { processes } from "@countersign/core";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { BuilderData } from "./catalog";

/** The client's agents as hand-off targets, for a client agent; undefined for a template. */
export function useHandoffAgents(agent: {
  kind: string;
  slug: string;
  tenantId?: string | null | undefined;
}): BuilderData["handoff"] {
  const state = useApi(
    apiRoutes.opsClientHandoffAgents,
    agent.kind === "client" && agent.tenantId ? { params: { id: agent.tenantId } } : null,
  );
  return state.data ? { self: agent.slug, agents: state.data.agents } : undefined;
}

/** The agents a hand-off step can pick: every other agent of the client. */
export function handoffChoices(
  data: Pick<BuilderData, "handoff">,
): NonNullable<BuilderData["handoff"]>["agents"] {
  const handoff = data.handoff;
  return handoff ? handoff.agents.filter((a) => a.slug !== handoff.self) : [];
}

/**
 * A hand-off step's name after a pick: "Hand off to Price checker at 5 · Itemize the invoice",
 * while it is still the name the builder gave; a name the operator wrote stays.
 */
// DECISION: the canvas row shows a step's name, so the builder names the step for its target
// (the same words the row's second line uses) rather than the row special-casing hand-offs.
export function handoffName(
  data: Pick<BuilderData, "handoff">,
  name: string,
  to: { agent: string; step: string },
): string {
  if (name !== "Hand off" && !name.startsWith("Hand off to ")) return name;
  const named = handoffNames(data, to);
  if (!named) return "Hand off";
  return to.step ? `Hand off to ${named.name} at ${named.at}` : `Hand off to ${named.name}`;
}

/** "Price checker" and "5 · Itemize the invoice", for the canvas row; undefined when unknown. */
export function handoffNames(
  data: Pick<BuilderData, "handoff">,
  to: { agent: string; step: string },
): { name: string; at: string } | undefined {
  const agent = data.handoff?.agents.find((a) => a.slug === to.agent);
  if (!agent) return undefined;
  return { name: agent.name, at: processes.handoffStepLabel(agent.steps, to.step) };
}
