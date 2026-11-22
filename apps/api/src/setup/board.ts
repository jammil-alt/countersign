// The back office's Setup tab (docs/setup-plan.md §8; docs/plan.md §1.185, SU6): stream OPS.
import type { CallAnswerBody, OpsSetupBoard } from "@countersign/core";
import type { Tx } from "@countersign/db";
import { notBuilt } from "./not-built";

export async function setupBoard(
  _tx: Tx,
  _input: { tenantId: string; now: Date },
): Promise<OpsSetupBoard> {
  return notBuilt("OPS");
}

/** Owner: Nudge, an email from the lead listing what's left. */
export async function nudge(
  _tx: Tx,
  _input: { tenantId: string; userId: string; by: string },
): Promise<{ sent: boolean; reason: string | null }> {
  return notBuilt("OPS");
}

/** The lead's answers on a call, sourced `call`, for the client to confirm. */
export async function callAnswers(
  _tx: Tx,
  _input: { intakeId: string; body: CallAnswerBody; by: string },
): Promise<number> {
  return notBuilt("OPS");
}
