// Audit 3.2, 3.7 and follow-up 1: what the agent port's `resume` tells the step about a change the
// run read a yes for. One turned down after all (another signer's no) is the step's `declined`,
// never done. One an earlier try claimed (and may have left mid-write) is never sent again at once:
// the step waits durably for the claim's lease (its end read from the database), then executes it
// again, and fails with what it knows once it has waited enough.

import type { ExternalActionRecord, RuntimeDeps } from "@countersign/agents";
import type { RunInfo, StepOutcome } from "@countersign/workflows";
import { describe, expect, it } from "vitest";
import { MAX_LEASE_WAITS } from "./lease-wait";
import { agentPort } from "./ports";

const NOW = new Date("2026-11-17T10:00:00.000Z");
const LEASE_END = "2026-11-17T10:12:00.000Z";
const ACTION_ID = "0192f7a0-0000-7000-8000-00000000a001";

function portWith(status: ExternalActionRecord["status"]) {
  const action = {
    id: ACTION_ID,
    tenantId: "t1",
    connectionId: "c1",
    tool: "testkit.record.update",
    runId: "r1",
    stepRunId: "s1",
    agentVersionId: "v1",
    input: {},
    idempotencyKey: "r1:update:0",
    status,
    inboxItemId: "i1",
    approvedBy: null,
    result: null,
    error: null,
    before: null,
  } satisfies ExternalActionRecord;
  const deps = {
    now: () => NOW,
    ports: {
      actions: {
        get: async () => action,
        claim: async () => ({ action, claimed: false, leaseEndsAt: LEASE_END }),
      },
      store: { run: async () => ({ mode: "live", agentId: "ag1" }) },
    },
  } as unknown as RuntimeDeps;
  return agentPort(deps);
}

const RUN = { id: "r1", tenantId: "t1", agentVersionId: "v1", mode: "live" } as unknown as RunInfo;
const STEP = { id: "update", kind: "action" } as never;

const request = (approved: boolean) => ({
  run: RUN,
  step: STEP,
  nodeId: "update",
  stepRunId: "s1",
  pending: {
    inboxItemId: "i1",
    state: { actions: [{ actionId: ACTION_ID, inboxItemId: "i1" }] },
  },
  resolution: { approved, by: "u1" },
});

const waitOf = (o: StepOutcome | undefined) => {
  if (o?.kind !== "waiting") throw new Error(`not waiting: ${JSON.stringify(o)}`);
  return o.wait;
};

describe("agentPort.resume", () => {
  it("takes a change rejected after the run read a yes as the step declined, not done", async () => {
    expect(await portWith("rejected").resume?.(request(true))).toEqual({
      kind: "done",
      output: null,
      declined: true,
    });
  });

  it("waits for the claim of an earlier try to run out, never sending the change at once", async () => {
    const wait = waitOf(await portWith("executing").resume?.(request(true)));
    // Until the lease's end as the database said, and a little more.
    expect(wait).toMatchObject({ reason: "change", timeout: "725 seconds" });
    expect(wait.eventType).toBe(`lease-${ACTION_ID.replace(/-/g, "")}`);
    expect(wait.state).toMatchObject({ lease: { tries: 1, resume: { index: 0 } } });
  });

  it("fails with what it knows once it has waited enough for a claim that holds", async () => {
    const port = portWith("executing");
    let outcome: StepOutcome | undefined = await port.resume?.(request(true));
    for (let n = 0; n < MAX_LEASE_WAITS; n++) {
      outcome = await port.afterWait?.({
        run: RUN,
        step: STEP,
        nodeId: "update",
        stepRunId: "s1",
        wait: waitOf(outcome),
        timedOut: true,
      });
    }
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(outcome?.kind === "failed" && outcome.error).toMatch(/may have been made/);
    expect(outcome?.kind === "failed" && outcome.error).not.toMatch(/right now/);
  });

  it("leaves a person's no as it was", async () => {
    expect(await portWith("rejected").resume?.(request(false))).toEqual({
      kind: "done",
      output: null,
    });
  });
});
