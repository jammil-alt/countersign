// STATE lens: the executor under retries and answers that arrive together. Driven with the
// workflows package's own in-memory ports (Harness) and FakeStepRunner, which keeps Cloudflare's
// replay and retry semantics (a durable `do` that throws is tried again up to its retry limit).
import type { processes } from "@countersign/core";
import { executeWorkflow } from "@countersign/workflows";
import { describe, expect, it } from "vitest";
import { FakeStepRunner } from "../../../../packages/workflows/src/fake-runner";
import { Harness, WRITE_TOOL } from "../../../../packages/workflows/src/fakes.test-helper";
import type { AskApproverRequest } from "../../../../packages/workflows/src/ports";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const proc = (steps: unknown[]) =>
  ({ schemaVersion: 4, triggers: [MANUAL], steps }) as unknown as processes.Process;

describe("STATE: approval groups", () => {
  it("STATE-2: `any` mode takes the first answer in time, so an earlier reject is not overridden by a later yes read in the same round", async () => {
    const h = new Harness();
    const asked: AskApproverRequest[] = [];
    h.agent.askApprover = async (req) => {
      asked.push(req);
      return { inboxItemId: h.approvalItem() };
    };
    const amy = h.approvalItem();
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: amy } });
    const runner = new FakeStepRunner({ onWait: "block" });
    let done = false;
    runner.onWaitStarted = (name, type) => {
      if (!name.includes(":a1") || done) return;
      done = true;
      const ben = [...h.items.keys()].at(-1) as string;
      // Ben (approver 2) says no first, and his answer's event wakes the run ...
      const benEntry = h.items.get(ben);
      if (benEntry) benEntry.resolution = { approved: false, by: "ben" };
      // ... and before the run's round reads the inbox, Amy (approver 1) says yes.
      const amyEntry = h.items.get(amy);
      if (amyEntry) amyEntry.resolution = { approved: true, by: "amy" };
      runner.deliver(type, { approved: false, by: "ben" });
    };
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        {
          id: "write",
          kind: "write",
          name: "Update the record",
          tool: WRITE_TOOL.id,
          input: { name: "x" },
          checks: {
            approval: {
              mode: "any",
              approvers: [
                { who: "amy", deadline: { after: "1 day" } },
                { who: "ben", deadline: { after: "1 day" } },
              ],
            },
          },
        },
      ]),
      {},
    );
    expect(asked.map((a) => a.who)).toEqual(["ben"]);
    // Ben's no came first: the write is not made and the run stops as rejected.
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: false, by: "ben" });
    expect(result).toMatchObject({ status: "cancelled", reason: "rejected" });
  });
});

describe("STATE: platform retries of a notice", () => {
  it("STATE-3: a notify step retried after its send went out (a later write in the same durable step failed) does not send the notice again", async () => {
    const h = new Harness();
    const notices: unknown[] = [];
    const notify = {
      ...h.notify,
      notify: async (n: unknown) => {
        notices.push(n);
        return { ackItemId: null };
      },
    };
    // The step's row update after the send fails once (a dropped database connection).
    const update = h.log.update;
    let failed = false;
    const log = {
      ...h.log,
      update: async (id: string, u: Parameters<typeof update>[1]) => {
        if (!failed && u.status === "succeeded") {
          failed = true;
          throw new Error("connection terminated unexpectedly");
        }
        return update(id, u);
      },
    };
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ notify, log }),
      proc([
        { id: "n", kind: "notify", name: "Tell", notify: { to: ["lead"], message: "Bill paid" } },
      ]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(failed).toBe(true);
    // One notice to the lead, not one per try.
    expect(notices).toHaveLength(1);
  });
});
