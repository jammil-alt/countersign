// The undo window under the real Workflows engine (ARCHITECTURE §11.1, docs/plan.md M16): an
// approval inside its window is not taken by the check before waiting; once the window has passed
// the run is told (the cron's resume) and the change is written once; an undone approval is never
// written; and a delivery that came inside the window still writes nothing, because the change
// can't be claimed then. DeskProbeWorkflow (src/runtime-harness.ts) runs the real executor and the
// real executeAction over the testkit connector; the database's side is in src/desk.test.ts.

import { env, introspectWorkflowInstance } from "cloudflare:test";
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { Workflow as WorkflowDef } from "@countersign/core";
import { inboxEventType } from "@countersign/workflows";
import { describe, expect, it } from "vitest";
import { probeItemId } from "./runtime-harness";

const probe = (env as unknown as { DESK_PROBE_WORKFLOW: Workflow }).DESK_PROBE_WORKFLOW;

const workflow: WorkflowDef = {
  schemaVersion: 3,
  trigger: { id: "trg", on: { type: "manual", input: {} } },
  steps: [
    {
      id: "send",
      name: "Change the record",
      kind: "action",
      tool: TESTKIT_UPDATE_TOOL,
      input: { id: "R-1", amount: "12.0000" },
      approval: { required: "required", onReject: "stop" },
    },
  ],
};

const approved = {
  type: inboxEventType(probeItemId("send")),
  payload: { approved: true, by: "u" },
};

describe("the undo window under the Workflows engine", () => {
  it("is not taken inside the window, then writes once after it, and the run resumes", async () => {
    const id = crypto.randomUUID();
    const heldUntil = Date.now() + 1500;
    await using instance = await introspectWorkflowInstance(probe, id);
    await probe.create({ id, params: { workflow, heldUntil } });
    // The check before waiting ran inside the window: no resolution.
    expect(await instance.waitForStepResult({ name: "send:approval:1:check" })).toBeNull();
    // The cron delivers once the window has passed.
    await new Promise((r) => setTimeout(r, Math.max(0, heldUntil - Date.now()) + 100));
    await (await probe.get(id)).sendEvent(approved);
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ status: "succeeded" });
    expect(await instance.waitForStepResult({ name: "send:approval:1:resume" })).toMatchObject({
      kind: "done",
      output: { written: true },
    });
  });

  it("never writes an approval that was undone (the run is never told)", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(probe, id);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: "send:approval:1:wait" });
    });
    await probe.create({ id, params: { workflow, heldUntil: Date.now() + 60 * 60_000 } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ status: "cancelled" });
    expect(await instance.waitForStepResult({ name: "send:approval:1:resume" })).toMatchObject({
      output: { written: false },
    });
  });

  it("writes nothing when told inside the window: the change can't be claimed yet", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(probe, id);
    await instance.modify(async (m) => {
      await m.mockEvent(approved);
    });
    await probe.create({ id, params: { workflow, heldUntil: Date.now() + 60 * 60_000 } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({
      status: "failed",
      reason: "not written: awaiting_approval",
      nodeId: "send",
      errorKey: "testkit.record.update:failed",
    });
  });
});
