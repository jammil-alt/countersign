// Getting started's Go live (docs/setup-plan.md §7; docs/plan.md §1.185): stream LIVE. The scope
// in the client's words, and its signature.
import type { ScopeView, SetupLeft } from "@countersign/core";
import type { Tx } from "@countersign/db";
import { notBuilt } from "./not-built";

export interface ScopeInput {
  tenantId: string;
  agentId: string;
  userId: string;
  name: string | null;
  isAdmin: boolean;
}

export async function scopeView(_tx: Tx, _input: ScopeInput): Promise<ScopeView> {
  return notBuilt("LIVE");
}

export async function signScope(_tx: Tx, _input: ScopeInput): Promise<void> {
  notBuilt("LIVE");
}

/** What Go live still holds per agent (agent id → lines), and how far it is. */
export async function liveProgress(
  _tx: Tx,
  input: { tenantId: string; agentIds: readonly string[] },
): Promise<{ left: Map<string, SetupLeft[]>; done: number; total: number }> {
  return { left: new Map(), done: 0, total: input.agentIds.length };
}
