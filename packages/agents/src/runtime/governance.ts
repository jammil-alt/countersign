// B6 (docs/builder-plan.md §8): what a model step reads of governance before anything else. The
// step's profile comes from what it can do (its tools, whether it browses or talks to people) and
// its areas; core's `composeGovernance` puts the Mezonas guardrails first, then the client's
// confirmed charter, then the policies whose tags match. The documents read (ids and versions) go
// on each model call's record, so a replay knows what the step saw.

import {
  type ClientGovernance,
  type ComposedGovernance,
  composeGovernance,
  OwnerArea,
  processArea,
  SHARED_AREA,
  type StepGovernanceProfile,
} from "@countersign/core";
import type { RuntimeDeps } from "./context";
import type { PinnedAgent } from "./ports";

/** The step's profile from the tools it is offered and what else it does. */
export function stepProfile(
  deps: Pick<RuntimeDeps, "tools">,
  agent: PinnedAgent,
  input: {
    tools: Iterable<string>;
    /** It browses a client's sites (v0.16). */
    browses?: boolean;
    /** It writes to people (a reach-out, a conversation). */
    contacts?: boolean;
    /** A task (AI) skill: the guardrails only. */
    lean?: boolean;
  },
): StepGovernanceProfile {
  const specs = [...input.tools].flatMap((id) => {
    const t = deps.tools.get(id);
    return t ? [t.spec] : [];
  });
  const writes = specs.filter((s) => s.sideEffect === "external");
  const areas = new Set<string>([
    processArea({ set: agent.area, declared: agent.bundle.definition.area }),
  ]);
  // A tool's own area counts when it is a business area (not the shared records).
  for (const s of specs) {
    if (s.area && s.area !== SHARED_AREA && OwnerArea.safeParse(s.area).success) areas.add(s.area);
  }
  return {
    writes: writes.length > 0,
    money: writes.some((s) => s.amount !== undefined),
    contacts: input.contacts === true || specs.some((s) => s.recipient !== undefined),
    connected: input.browses === true || specs.some((s) => s.connector !== undefined),
    areas: [...areas].sort(),
    ...(input.lean ? { lean: true } : {}),
  };
}

/**
 * The governance text and what it holds, for one model step of one client. The client's part is
 * read fresh (a charter confirmed a moment ago counts for the next step); a lean step reads none.
 */
export async function readGovernance(
  deps: Pick<RuntimeDeps, "ports">,
  tenantId: string,
  profile: StepGovernanceProfile,
): Promise<ComposedGovernance> {
  // A store that reads none (some tests, the skill bench) leaves the client's part out.
  const store = deps.ports?.store;
  const client: ClientGovernance | null =
    profile.lean || !store?.governance ? null : await store.governance(tenantId);
  return composeGovernance(profile, client);
}
