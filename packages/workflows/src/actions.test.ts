// Skill model (2026-11-10), Wave B item 9: action write steps. The executor resolves an action to
// its tool once, durably (`<step>:action`), then runs it exactly as a write step calling that tool:
// its input mapped to the tool's, the gate's approval on by default.
import { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness } from "./fakes.test-helper";
import type { ResolveActionRequest, ResolvedAction } from "./ports";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

const bill = (over: Record<string, unknown> = {}) => ({
  id: "bill",
  kind: "write",
  name: "Create bill",
  action: "create_bill",
  input: {
    vendorId: "{{trigger.vendorId}}",
    invoiceNumber: "INV-7",
    date: "2026-11-10",
    dueDate: "2026-12-10",
    currency: "USD",
    total: "{{trigger.total}}",
    lines: [{ description: "Flour", amount: "{{trigger.total}}", account: "7" }],
  },
  ...over,
});

/** A harness whose agent port resolves actions to `answer`, counting the calls. */
function resolving(h: Harness, answer: (req: ResolveActionRequest) => ResolvedAction) {
  const asked: ResolveActionRequest[] = [];
  h.agent.resolveAction = async (req) => {
    asked.push(req);
    return answer(req);
  };
  return asked;
}

const TRIGGER = { vendorId: "56", total: "12.5000" };

describe("action write steps", () => {
  it("resolves to the agent's tool, maps the input and runs it as a write with approval on", async () => {
    const h = new Harness();
    const asked = resolving(h, () => ({ tool: "qbo.bill.create", connector: "qbo" }));
    h.handlers.bill = (req) => ({ kind: "done", output: { billId: "9", input: req.input } });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(runner, h.context(), proc([bill()]), TRIGGER);
    expect(result.status).toBe("succeeded");
    expect(asked).toEqual([{ run: h.run, nodeId: "bill", action: "create_bill" }]);
    const call = h.agentCalls[0];
    expect(call?.step).toMatchObject({
      kind: "action",
      tool: "qbo.bill.create",
      name: "Create bill · in QuickBooks",
    });
    expect(call?.approval.required).toBe("required");
    expect(call?.input).toEqual({
      vendorId: "56",
      docNumber: "INV-7",
      txnDate: "2026-11-10",
      dueDate: "2026-12-10",
      currency: "USD",
      expectedTotal: "12.5000",
      lines: [{ description: "Flour", amount: "12.5000", accountId: "7" }],
    });
    // The row is the write's, with the tool's input; the run view's line names where it went.
    expect(h.row("bill")).toMatchObject({ nodeType: "write", status: "succeeded" });
    expect(h.row("bill")?.summary).toBe("Create bill · in QuickBooks: done");
    expect(runner.names()).toEqual(["bill:action", "bill"]);
  });

  it("runs the same tool for BILL, with BILL's input", async () => {
    const h = new Harness();
    resolving(h, () => ({ tool: "billcom.bill.create", connector: "billcom" }));
    await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      proc([bill({ via: "billcom" })]),
      TRIGGER,
    );
    expect(h.agentCalls[0]?.step).toMatchObject({ tool: "billcom.bill.create" });
    expect(h.agentCalls[0]?.input).toMatchObject({
      invoiceNumber: "INV-7",
      invoiceDate: "2026-11-10",
    });
  });

  it("passes via, and resolves once: a replay resolves the same way without asking again", async () => {
    const h = new Harness();
    let next: ResolvedAction = { tool: "qbo.bill.create", connector: "qbo" };
    const asked = resolving(h, () => next);
    const item = h.approvalItem({ approved: true, by: "ann" });
    h.handlers.bill = () => ({
      kind: "approval",
      pending: { actionId: "a1", inboxItemId: item },
    });
    h.resumeHandler = () => ({ kind: "done", output: { billId: "9" } });
    const runner = new FakeStepRunner();
    const ctx = h.context();
    const process = proc([bill({ via: "qbo" })]);
    const once = await executeWorkflow(runner, ctx, process, TRIGGER);
    expect(once.status).toBe("succeeded");
    expect(asked.map((a) => a.via)).toEqual(["qbo"]);
    expect(h.resumeCalls[0]?.step).toMatchObject({ tool: "qbo.bill.create" });
    // The bindings change before the replay: the stored resolution stands.
    next = { tool: "billcom.bill.create", connector: "billcom" };
    runner.replay();
    const again = await executeWorkflow(runner, ctx, process, TRIGGER);
    expect(again).toEqual(once);
    expect(asked).toHaveLength(1);
    expect(h.agentCalls).toHaveLength(1);
    expect(runner.calls.every((c) => c.kind !== "do" || c.cached)).toBe(true);
  });

  it("an action that doesn't resolve fails the step before anything is proposed", async () => {
    const h = new Harness();
    resolving(h, () => ({ refused: "Create bill needs an accounting connection" }));
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      proc([bill()]),
      TRIGGER,
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("refused: Create bill needs an accounting connection");
    expect(h.agentCalls).toHaveLength(0);
  });

  it("refuses a resolution to a tool the action doesn't run with, and a port that can't resolve", async () => {
    const h = new Harness();
    resolving(h, () => ({ tool: "gmail.send", connector: "qbo" }));
    const bad = await executeWorkflow(new FakeStepRunner(), h.context(), proc([bill()]), TRIGGER);
    expect(bad.reason).toMatch(/doesn't run with gmail.send/);
    const none = new Harness();
    const r = await executeWorkflow(new FakeStepRunner(), none.context(), proc([bill()]), TRIGGER);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/nothing resolves it/);
    expect(none.agentCalls).toHaveLength(0);
  });

  it("an input the tool can't take is refused on the step's row, nothing sent", async () => {
    const h = new Harness();
    resolving(h, () => ({ tool: "billcom.bill.create", connector: "billcom" }));
    const noDue = bill();
    delete (noDue.input as Record<string, unknown>).dueDate;
    const result = await executeWorkflow(new FakeStepRunner(), h.context(), proc([noDue]), TRIGGER);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("refused: Create bill: BILL needs a due date");
    expect(h.agentCalls).toHaveLength(0);
    expect(h.row("bill")).toMatchObject({ status: "failed" });
  });

  it("sends an email on the channel the port resolves, inside a loop once per item", async () => {
    const h = new Harness();
    const asked = resolving(h, () => ({ tool: "email.send", connector: "resend" }));
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([
        {
          id: "each",
          kind: "for_each",
          name: "Each",
          over: "{{trigger.people}}",
          steps: [
            {
              id: "mail",
              kind: "write",
              name: "Send email",
              action: "send_email",
              input: { to: "{{item}}", subject: "Hello", body: "Your order shipped" },
            },
          ],
        },
      ]),
      { people: ["a@b.co", "c@d.co"] },
    );
    expect(result.status).toBe("succeeded");
    expect(asked.map((a) => a.nodeId)).toEqual(["each:0:mail", "each:1:mail"]);
    expect(
      h.agentCalls.map((c) => [c.step.kind, (c.step as { tool: string }).tool, c.input]),
    ).toEqual([
      ["action", "email.send", { to: "a@b.co", subject: "Hello", text: "Your order shipped" }],
      ["action", "email.send", { to: "c@d.co", subject: "Hello", text: "Your order shipped" }],
    ]);
    expect(h.row("each:0:mail")?.summary).toBe("Send email · through our sending: done");
  });

  it("a tool write step runs as before: no resolution", async () => {
    const h = new Harness();
    const asked = resolving(h, () => ({ refused: "no" }));
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context(),
      proc([{ id: "w", kind: "write", name: "W", tool: "testkit.thing.update", input: {} }]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(asked).toHaveLength(0);
    expect(runner.names()).toEqual(["w"]);
    expect(processes.WRITE_ACTIONS).toContain("create_bill");
  });
});
