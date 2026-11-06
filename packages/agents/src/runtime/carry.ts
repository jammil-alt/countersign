// v0.12 W1-E: carried approvals (ARCHITECTURE §10.10; docs/plan.md §1.40). A retry's write step
// looks for a write the same step proposed in the run retried with the same input (hash). One
// already done is never redone: its recorded result stands. One approved and not done, signed less
// than 72 hours ago, is executed under its original idempotency key without a new approval, the
// gate having just allowed the write again (matrix, grant, stage, release as they are now).
// Otherwise the write is proposed again, for a new approval.

import { carryDecision, hashJson, type WriteDecision } from "@countersign/core";
import { executeAction } from "./actions";
import type { ToolOutcome } from "./call-tool";
import { asJsonObject, idempotencyKey, type RuntimeDeps, type StepContext } from "./context";

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
    // The key this write would have taken, so later writes of the step keep their own (a
    // Workflow retry of the step finds them by key again).
    idempotencyKey(step);
    const carried = { retryOf };
    if (carry === "done") {
      return { status: "done", output: c.result, actionId: c.id, carried };
    }
    if (!(await port.reopen(step.tenantId, c.id))) return null;
    const r = await executeAction(deps, {
      tenantId: step.tenantId,
      actionId: c.id,
      runId: step.runId,
    });
    switch (r.status) {
      case "done":
        return { status: "done", output: r.output, summary: r.summary, actionId: c.id, carried };
      case "failed":
        return { status: "failed", error: r.error };
      default:
        return { status: "refused", reason: `the carried change is ${r.action.status}` };
    }
  }
  return null;
}
