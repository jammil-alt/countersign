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
import type { ToolOutcome } from "./call-tool";
import { asJsonObject, idempotencyKey, type RuntimeDeps, type StepContext } from "./context";

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
  for (const c of candidates) {
    if (c.tool !== toolId || (await hashJson(c.input)) !== hash) continue;
    const carry = carryDecision(c, now);
    if (carry === "propose") continue;
    // DECISION: a write the system approved (the automatic path, no signer) is carried only while
    // the gate would still run it without asking; a client who tightened its matrix since is asked
    // (docs/plan.md M17). A person's signature stands while the gate allows the write at all.
    if (carry === "execute" && c.approvedBy === null && decision !== "run") continue;
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
      default:
        return { status: "refused", reason: `the carried change is ${r.action.status}` };
    }
  }
  return null;
}
