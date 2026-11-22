// Getting started's Try it on a real one (docs/setup-plan.md §6.2; docs/plan.md §1.185, SU5):
// stream SEE. A test run of the agent's latest version on one of the client's documents: it writes
// nothing and asks nobody (invariant 8: test runs never write).
import type { TryVerdictBody, TryView } from "@countersign/core";
import type { Tx } from "@countersign/db";
import { notBuilt } from "./not-built";
import type { SeeInput } from "./walkthrough";

/** Starts a try. The run itself is started by the caller after the commit (`started`). */
export async function startTry(
  _tx: Tx,
  _input: SeeInput & { documentId: string },
): Promise<{ view: TryView; runId: string }> {
  return notBuilt("SEE");
}

export async function tryView(_tx: Tx, _input: SeeInput & { runId: string }): Promise<TryView> {
  return notBuilt("SEE");
}

export async function tryVerdict(
  _tx: Tx,
  _input: SeeInput & { runId: string; stepId: string; body: TryVerdictBody },
): Promise<TryView> {
  return notBuilt("SEE");
}
