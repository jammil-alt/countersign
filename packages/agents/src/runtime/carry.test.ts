// v0.12 W1-E: what a retry carries, against the gate's decision as it is now (ARCHITECTURE §10.10).
// The decision already holds the go-live stage (W1-A's effectiveMode): in trial and signoff every
// write needs a signature, so a write the system approved is never carried there.

import { describe, expect, it } from "vitest";
import { carryApproval } from "./carry";
import type { RuntimeDeps, StepContext } from "./context";
import type { CarryCandidate } from "./ports";

const RETRY_OF = "0192f7a0-0000-7000-8000-00000000a001";
const NOW = new Date("2026-11-06T12:00:00Z");

function setup(candidate: Partial<CarryCandidate>) {
  const reopened: string[] = [];
  const c: CarryCandidate = {
    id: "action-1",
    tool: "testkit.record.update",
    connectionId: "conn-1",
    input: { id: "r1", amount: "12.00" },
    idempotencyKey: `${RETRY_OF}:update:0`,
    status: "failed",
    approvedAt: new Date(NOW.getTime() - 3_600_000),
    approvedBy: "user-1",
    result: null,
    error: { message: "HTTP 401" },
    ...candidate,
  };
  const deps = {
    now: () => NOW,
    ports: {
      carried: {
        candidates: async () => [c],
        reopen: async (_t: string, id: string) => {
          reopened.push(id);
          return false; // stop before executing: these tests are about the choice only
        },
      },
    },
  } as unknown as RuntimeDeps;
  const step = {
    tenantId: "tenant-1",
    runId: "run-2",
    stepId: "update",
    mode: "live",
    retryOf: RETRY_OF,
    externalIndex: { next: 0 },
  } as unknown as StepContext;
  return { deps, step, reopened };
}

describe("carried approvals and the gate", () => {
  it("never carries a system approval while the gate asks for a signature (a trial agent)", async () => {
    const { deps, step, reopened } = setup({ approvedBy: null });
    const r = await carryApproval(
      deps,
      step,
      "testkit.record.update",
      { id: "r1", amount: "12.00" },
      "approval",
    );
    expect(r).toBeNull();
    expect(reopened).toEqual([]);
    expect(step.externalIndex.next).toBe(0);
  });

  it("carries a system approval while the gate would still run the write without asking", async () => {
    const { deps, step, reopened } = setup({ approvedBy: null });
    await carryApproval(deps, step, "testkit.record.update", { amount: "12.00", id: "r1" }, "run");
    expect(reopened).toEqual(["action-1"]);
  });

  it("carries a person's signature whatever the gate now asks, but not a different input", async () => {
    const signed = setup({});
    await carryApproval(
      signed.deps,
      signed.step,
      "testkit.record.update",
      { id: "r1", amount: "12.00" },
      "approval",
    );
    expect(signed.reopened).toEqual(["action-1"]);
    const other = setup({});
    const r = await carryApproval(
      other.deps,
      other.step,
      "testkit.record.update",
      { id: "r1", amount: "13.00" },
      "approval",
    );
    expect(r).toBeNull();
    expect(other.reopened).toEqual([]);
  });

  it("never carries a signed write that failed and its run went on past (onError: continue)", async () => {
    const { deps, step, reopened } = setup({ carriedOn: true });
    const r = await carryApproval(
      deps,
      step,
      "testkit.record.update",
      { id: "r1", amount: "12.00" },
      "approval",
    );
    // Proposed again for a new signature: no reopen, nothing executed.
    expect(r).toBeNull();
    expect(reopened).toEqual([]);
  });

  it("returns a done write's result without running it", async () => {
    const { deps, step, reopened } = setup({ status: "done", result: { id: "r1" } });
    const r = await carryApproval(
      deps,
      step,
      "testkit.record.update",
      { id: "r1", amount: "12.00" },
      "approval",
    );
    expect(r).toEqual({
      status: "done",
      output: { id: "r1" },
      actionId: "action-1",
      carried: { retryOf: RETRY_OF },
    });
    expect(reopened).toEqual([]);
  });
});
