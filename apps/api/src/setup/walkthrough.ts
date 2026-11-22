// Getting started's See it work (docs/setup-plan.md §6; docs/plan.md §1.185, SU4 and SU5): stream
// SEE. The walkthrough's marks and the tries started from the portal.
import type { SetupLeft, WalkMarkBody, WalkthroughView } from "@countersign/core";
import type { Tx } from "@countersign/db";
import { notBuilt } from "./not-built";

export interface SeeInput {
  tenantId: string;
  agentId: string;
  userId: string;
  name: string | null;
  /** Whether this person may try the agent (a signer; a viewer only reads). */
  canSign: boolean;
}

export async function walkthrough(_tx: Tx, _input: SeeInput): Promise<WalkthroughView> {
  return notBuilt("SEE");
}

export async function markStep(
  _tx: Tx,
  _input: SeeInput & { stepId: string; body: WalkMarkBody },
): Promise<void> {
  notBuilt("SEE");
}

/** What See it work still holds per agent (agent id → lines), and how far it is. */
export async function seeProgress(
  _tx: Tx,
  input: { tenantId: string; agentIds: readonly string[] },
): Promise<{ left: Map<string, SetupLeft[]>; done: number; total: number }> {
  return { left: new Map(), done: 0, total: input.agentIds.length };
}
