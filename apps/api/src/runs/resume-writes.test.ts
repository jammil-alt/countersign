// Audit 3.2, 3.7: what the agent port's `resume` tells the step about a change the run read a yes
// for: one turned down after all (another signer's no) is the step's `declined`, never done, and
// one another try is making now fails the step without being sent again.

import type { ExternalActionRecord, RuntimeDeps } from "@countersign/agents";
import type { RunInfo } from "@countersign/workflows";
import { describe, expect, it } from "vitest";
import { agentPort } from "./ports";

function portWith(status: ExternalActionRecord["status"]) {
  const action = {
    id: "a1",
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
    ports: {
      actions: {
        get: async () => action,
        claim: async () => ({ action, claimed: false }),
      },
      store: { run: async () => ({ mode: "live", agentId: "ag1" }) },
    },
  } as unknown as RuntimeDeps;
  return agentPort(deps);
}

const request = (approved: boolean) => ({
  run: { id: "r1", tenantId: "t1", agentVersionId: "v1", mode: "live" } as unknown as RunInfo,
  step: { id: "update", kind: "action" } as never,
  nodeId: "update",
  stepRunId: "s1",
  pending: {
    inboxItemId: "i1",
    state: { actions: [{ actionId: "a1", inboxItemId: "i1" }] },
  },
  resolution: { approved, by: "u1" },
});

describe("agentPort.resume", () => {
  it("takes a change rejected after the run read a yes as the step declined, not done", async () => {
    expect(await portWith("rejected").resume?.(request(true))).toEqual({
      kind: "done",
      output: null,
      declined: true,
    });
  });

  it("fails the step on a change another try is making, without sending it", async () => {
    const out = await portWith("executing").resume?.(request(true));
    expect(out).toMatchObject({ kind: "failed" });
    expect(out?.kind === "failed" && out.error).toMatch(/being made right now/);
  });

  it("leaves a person's no as it was", async () => {
    expect(await portWith("rejected").resume?.(request(false))).toEqual({
      kind: "done",
      output: null,
    });
  });
});
