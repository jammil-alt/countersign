// v0.12 W1-E: carried approvals (ARCHITECTURE §10.10; docs/plan.md §1.40). A retry's write step
// looks for a write the same step proposed in the run retried with the same input (hash). One
// already done is never redone: its recorded result stands. One approved and not done, signed less
// than 72 hours ago, is executed under its original idempotency key without a new approval, the
// gate having just allowed the write again (matrix, grant, the go-live stage through W1-A's
// effectiveMode, release, as they are now). A write the system approved is carried only while that
// decision is still `run`: an agent in trial or signoff has every write signed.
// Otherwise the write is proposed again, for a new approval.

import { carryDecision, hashJson, isPlainObject, type WriteDecision } from "@countersign/core";
import { executeAction } from "./actions";
import { recordedChange, type ToolOutcome } from "./call-tool";
import {
  asJsonObject,
  idempotencyKey,
  nextIdempotencyKey,
  type RuntimeDeps,
  type StepContext,
} from "./context";

/** Said of a carried write that failed after it may have reached the provider. */
export const MAY_HAVE_HAPPENED = " (the change may have happened: check before trying again)";

/** Whether a failed action's error says nothing was written (`notWritten`, `executeAction`). */
function notWritten(error: unknown): boolean {
  return isPlainObject(error) && error.notWritten === true;
}

/** A carried write's outcome, or null to propose it as any other. Live retries only. */
export async function carryApproval(
  deps: RuntimeDeps,
  step: StepContext,
  toolId: string,
  input: unknown,
  /** The gate's decision for this write now. */
  decision: WriteDecision,
): Promise<ToolOutcome | null> {
  const port = deps.ports.carried;
  const retryOf = step.retryOf;
  if (!port || !retryOf || step.mode !== "live") return null;
  const candidates = await port.candidates(step.tenantId, { retryOf, nodeId: step.stepId });
  if (candidates.length === 0) return null;
  const hash = await hashJson(asJsonObject(input));
  const now = deps.now?.() ?? new Date();
  // Follow-up 3: this call's own position in the step (`<run>:<step>:<index>`, before it is taken).
  const position = nextIdempotencyKey(step).slice(`${step.runId}:`.length);
  for (const c of candidates) {
    if (c.tool !== toolId || (await hashJson(c.input)) !== hash) continue;
    const carry = carryDecision(c, now);
    if (carry === "propose") continue;
    // DECISION: a write the system approved (the automatic path, no signer) is carried only while
    // the gate would still run it without asking; a client who tightened its matrix since is asked
    // (docs/plan.md M17). A person's signature stands while the gate allows the write at all.
    // Follow-up 3: nor after a call of this try that didn't match the step's change.
    const unsignedOk = decision === "run" && step.signAllWrites !== true;
    if (carry === "execute" && c.approvedBy === null && !unsignedOk) continue;
    const carried = { retryOf };
    if (carry === "done") {
      // The key this write would have taken, so later writes of the step keep their own (a
      // Workflow retry of the step finds them by key again).
      idempotencyKey(step);
      return { status: "done", output: c.result, actionId: c.id, carried };
    }
    if (!(await port.reopen(step.tenantId, c.id))) return null;
    idempotencyKey(step);
    const r = await executeAction(deps, {
      tenantId: step.tenantId,
      actionId: c.id,
      runId: step.runId,
    });
    switch (r.status) {
      case "done":
        return { status: "done", output: r.output, summary: r.summary, actionId: c.id, carried };
      case "failed":
        // DECISION (wave 5 re-review): the carried write runs on the run retried's action (its
        // run id and key); a failure not known to have written nothing says the write may have
        // happened, and the executor never goes on past it (`onError: continue`,
        // `writeMayHaveHappened`): a person checks it.
        // DECISION (wave 5, fix 3): and the failure names the carried action, so this run's tool
        // call logs it and `stepWrites` finds it however the step then ends (a model-mode skill's
        // own failure or request for help carries another error than this one).
        return {
          status: "failed",
          error: notWritten(r.action.error) ? r.error : `${r.error}${MAY_HAVE_HAPPENED}`,
          actionId: c.id,
        };
      case "busy":
        // Audit 3.2: an earlier try claimed it: never sent twice; the step waits for that claim's
        // lease and runs again (follow-up 1).
        return { status: "busy", actionId: c.id, leaseEndsAt: r.leaseEndsAt };
      default:
        return { status: "refused", reason: `the carried change is ${r.action.status}` };
    }
  }
  // DECISION (follow-up 3, the lead's): a change the run retried made at this call's position with
  // another input is not proposed again blindly: the model is told it (as data) and the key moves
  // on, as a retried step is (call-tool's `resumeProposed`). Writes after it wait for a person.
  const made = candidates.find(
    (c) => c.tool === toolId && c.status === "done" && c.idempotencyKey.endsWith(`:${position}`),
  );
  if (made) {
    idempotencyKey(step);
    step.signAllWrites = true;
    return {
      status: "recorded",
      actionId: made.id,
      change: recordedChange(made),
    };
  }
  return null;
}
