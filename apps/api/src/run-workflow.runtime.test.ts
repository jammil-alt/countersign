// The StepRunner adapter against the real Workflows engine (docs/plan.md §1.2 "Waiting on inbox
// items"): a person step waits for its inbox event, resumes when it is sent, and takes the timeout
// path when it never comes. ProbeWorkflow (src/runtime-harness.ts) runs the real executor with
// in-memory ports; RunWorkflow's database side is covered by the Node tests.

import { env, introspectWorkflowInstance } from "cloudflare:test";
import type { Workflow as WorkflowDef } from "@countersign/core";
import { inboxEventType } from "@countersign/workflows";
import { describe, expect, it } from "vitest";
import { probeItemId } from "./runtime-harness";

const probe = (env as unknown as { PROBE_WORKFLOW: Workflow }).PROBE_WORKFLOW;

const workflow: WorkflowDef = {
  schemaVersion: 3,
  trigger: { id: "trg", on: { type: "manual", input: {} } },
  steps: [
    {
      id: "ask",
      name: "Ask the admin",
      kind: "person",
      mode: "approve",
      assignee: "client_admin",
      title: "Go ahead?",
      payload: {},
      timeout: "1 hour",
      channel: "inbox",
      onReject: "stop",
      onTimeout: "stop",
    },
    { id: "after", name: "Notify", kind: "notify", channel: "thread", message: "done" },
  ],
};

describe("RunWorkflow's StepRunner adapter under the Workflows engine", () => {
  it("waits on the inbox event and resumes when it is sent", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(probe, id);
    await probe.create({ id, params: { workflow } });
    // The item exists once the person step's first durable step has run.
    await instance.waitForStepResult({ name: "ask" });
    const handle = await probe.get(id);
    await handle.sendEvent({
      type: inboxEventType(probeItemId("ask")),
      payload: { approved: true, by: "user-1" },
    });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ status: "succeeded" });
  });

  it("ends the run when nobody answers before the timeout", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(probe, id);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: "ask:wait" });
    });
    await probe.create({ id, params: { workflow } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({
      status: "failed",
      reason: "timeout",
      nodeId: "ask",
      // v0.12 W1-E: what failed runs are grouped by.
      errorKey: "person:timeout",
    });
  });

  it("follows a rejection", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(probe, id);
    await instance.modify(async (m) => {
      await m.mockEvent({
        type: inboxEventType(probeItemId("ask")),
        payload: { approved: false, by: "user-1" },
      });
    });
    await probe.create({ id, params: { workflow } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({
      status: "cancelled",
      reason: "rejected",
      nodeId: "ask",
    });
  });
});
