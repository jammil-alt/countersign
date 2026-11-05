import { describe, expect, it } from "vitest";
import { executeWorkflow, pool } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, RUN, SKILL, WRITE_TOOL, wf } from "./fakes.test-helper";
import { inboxEventType } from "./runner";

/** Lets other pending work run (no timers: this package has no Node or DOM types). */
async function later(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const person = (over: Record<string, unknown> = {}) => ({
  id: "ok",
  kind: "person",
  name: "Approve the order",
  mode: "approve",
  assignee: "client_admin",
  title: "Approve {{trigger.what}}",
  payload: { amount: "{{trigger.amount}}" },
  timeout: "2 days",
  onTimeout: "stop",
  ...over,
});

const action = (over: Record<string, unknown> = {}) => ({
  id: "write",
  kind: "action",
  name: "Update the record",
  tool: WRITE_TOOL.id,
  input: { name: "{{trigger.what}}" },
  ...over,
});

describe("skill and action steps", () => {
  it("resolves inputs, passes outputs on, writes step_runs with summaries", async () => {
    const h = new Harness();
    h.handlers.read = () => ({
      kind: "done",
      output: { lines: 3, vendor: "Acme" },
      costUsd: "0.0100",
    });
    h.handlers.write = (req) => ({ kind: "done", output: req.input });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({
        catalog: { skills: { [SKILL.id]: SKILL }, tools: { [WRITE_TOOL.id]: WRITE_TOOL } },
      }),
      wf([
        {
          id: "read",
          kind: "skill",
          name: "Read",
          skill: SKILL.id,
          input: { doc: "{{trigger.doc}}" },
        },
        action({
          input: { name: "{{steps.read.output.vendor}}", n: "{{steps.read.output.lines}}" },
        }),
      ]),
      { doc: "d-1", what: "x" },
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(h.agentCalls.map((c) => [c.nodeId, c.input])).toEqual([
      ["read", { doc: "d-1" }],
      ["write", { name: "Acme", n: 3 }],
    ]);
    // Steps without an approval setting still pass the default: required.
    expect(h.agentCalls[0]?.approval.required).toBe("required");
    expect(h.agentCalls[1]?.approval.required).toBe("required");
    expect(h.row("read")).toMatchObject({
      nodeType: "skill",
      skillRef: SKILL.id,
      status: "succeeded",
      summary: "Read 3 lines from Acme",
      costUsd: "0.0100",
    });
    expect(h.row("write")?.summary).toBe("Updated Acme");
    expect(runner.names()).toEqual(["read", "write"]);
  });

  it("falls back to the client label when there is no summary template", async () => {
    const h = new Harness();
    await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        {
          id: "s",
          kind: "skill",
          name: "Check",
          skill: "x.y",
          client: { visible: true, label: "Checked prices" },
        },
      ]),
      {},
    );
    expect(h.row("s")?.summary).toBe("Checked prices: done");
  });

  it("waits for an approval, then resumes the agent with the resolution", async () => {
    const h = new Harness();
    const item = h.approvalItem();
    h.handlers.write = () => ({
      kind: "approval",
      pending: { inboxItemId: item, state: { ea: 1 } },
    });
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => {
      expect(h.row("write")?.status).toBe("waiting");
      runner.deliver(type, { approved: true, by: "u-1" });
    };
    const result = await executeWorkflow(
      runner,
      h.context(),
      wf([
        action(),
        {
          id: "after",
          kind: "skill",
          name: "After",
          skill: "x.y",
          input: { w: "{{steps.write.output.written}}" },
        },
      ]),
      { what: "x" },
    );
    expect(result.status).toBe("succeeded");
    expect(runner.calls.find((c) => c.kind === "wait")).toMatchObject({
      name: "write:approval:1:wait",
      type: inboxEventType(item),
      timeout: "7 days",
    });
    expect(h.resumeCalls[0]).toMatchObject({
      nodeId: "write",
      pending: { inboxItemId: item, state: { ea: 1 } },
      resolution: { approved: true, by: "u-1" },
    });
    expect(h.row("write")?.status).toBe("succeeded");
    expect(h.agentCalls.at(-1)?.input).toEqual({ w: true });
    // The run records that it took the resolution, so nothing re-sends its event.
    expect(h.items.get(item)?.received).toBe(1);
    expect(runner.names()).toContain("write:approval:1:received");
  });

  it("checks the item before waiting, so an early resolution isn't missed", async () => {
    const h = new Harness();
    const item = h.approvalItem({ approved: true, by: "u-2" });
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: item } });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(runner, h.context(), wf([action()]), { what: "x" });
    expect(result.status).toBe("succeeded");
    expect(runner.names("wait")).toEqual([]);
    expect(runner.names()).toContain("write:approval:1:check");
    expect(h.resumeCalls[0]?.resolution).toMatchObject({ approved: true, by: "u-2" });
    expect(h.items.get(item)?.received).toBe(1);
  });

  it("stops the run on a rejected write unless the step continues", async () => {
    for (const onReject of ["stop", "continue"] as const) {
      const h = new Harness();
      const item = h.approvalItem({ approved: false, by: "u-3" });
      h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: item } });
      const result = await executeWorkflow(
        new FakeStepRunner(),
        h.context(),
        wf([
          action({ approval: { onReject } }),
          { id: "next", kind: "notify", name: "N", channel: "thread", message: "hi" },
        ]),
        { what: "x" },
      );
      expect(h.row("write")).toMatchObject({
        status: "skipped",
        summary: "Update the record: not approved",
      });
      if (onReject === "stop") {
        expect(result).toEqual({ status: "cancelled", reason: "rejected", nodeId: "write" });
        expect(h.sent).toHaveLength(0);
      } else {
        expect(result.status).toBe("succeeded");
        expect(h.sent).toHaveLength(1);
      }
    }
  });

  it("treats an approval that times out as not approved and expires the item", async () => {
    const h = new Harness();
    const item = h.approvalItem();
    h.handlers.write = () => ({ kind: "approval", pending: { inboxItemId: item } });
    const runner = new FakeStepRunner({ onWait: "timeout" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      wf([action({ approval: { timeout: "1 hour" } })]),
      { what: "x" },
    );
    expect(result).toMatchObject({ status: "cancelled", reason: "rejected" });
    expect(runner.calls.find((c) => c.kind === "wait")).toMatchObject({ timeout: "1 hour" });
    expect(h.items.get(item)?.expired).toBe(true);
    expect(h.items.get(item)?.received).toBe(0);
    expect(h.resumeCalls[0]?.resolution.approved).toBe(false);
  });

  it("keeps asking while an agent-mode skill proposes more writes", async () => {
    const h = new Harness();
    const first = h.approvalItem({ approved: true, by: null });
    const second = h.approvalItem({ approved: true, by: null });
    h.handlers.s = () => ({ kind: "approval", pending: { inboxItemId: first } });
    h.resumeHandler = (req) =>
      req.pending.inboxItemId === first
        ? { kind: "approval", pending: { inboxItemId: second } }
        : { kind: "done", output: { writes: 2 } };
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context(),
      wf([{ id: "s", kind: "skill", name: "S", skill: "x.y" }]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(runner.names().filter((n) => n.endsWith(":resume"))).toEqual([
      "s:approval:1:resume",
      "s:approval:2:resume",
    ]);
    expect(h.row("s")?.output).toEqual({ writes: 2 });
  });

  it("in a test run never waits on a write: it records what would have happened", async () => {
    const h = new Harness({ ...RUN, mode: "test" });
    const item = h.approvalItem();
    h.handlers.write = (req) => {
      expect(req.run.mode).toBe("test");
      return { kind: "approval", pending: { inboxItemId: item }, output: { wouldUpdate: "x" } };
    };
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(runner, h.context(), wf([action()]), { what: "x" });
    expect(result.status).toBe("succeeded");
    expect(runner.names("wait")).toEqual([]);
    expect(h.resumeCalls).toHaveLength(0);
    expect(h.row("write")).toMatchObject({ status: "succeeded", output: { wouldUpdate: "x" } });
  });

  it("fails the run on escalation, failure or a thrown error, and records why", async () => {
    const cases = [
      [() => ({ kind: "escalated", reason: "budget" }) as const, "escalated: budget"],
      [() => ({ kind: "failed", error: "bad input" }) as const, "bad input"],
      [
        () => {
          throw new Error("boom");
        },
        "boom",
      ],
    ] as const;
    for (const [handler, reason] of cases) {
      const h = new Harness();
      h.handlers.s = handler;
      const result = await executeWorkflow(
        new FakeStepRunner(),
        h.context(),
        wf([
          { id: "s", kind: "skill", name: "S", skill: "x.y" },
          { id: "never", kind: "skill", name: "N", skill: "x.y" },
        ]),
        {},
      );
      expect(result).toEqual({ status: "failed", reason, nodeId: "s" });
      expect(h.row("s")?.status).toBe("failed");
      expect(h.row("never")).toBeUndefined();
    }
  });

  it("retries a step per its config", async () => {
    const h = new Harness();
    let tries = 0;
    h.handlers.s = () => {
      tries++;
      if (tries < 3) throw new Error("flaky");
      return { kind: "done", output: {} };
    };
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ stepConfig: { retries: { limit: 2, delay: "1 second" } } }),
      wf([{ id: "s", kind: "skill", name: "S", skill: "x.y" }]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(tries).toBe(3);
  });
});

describe("person steps", () => {
  it("creates an inbox item, waits for it, and exposes the answer to a later fork", async () => {
    const h = new Harness();
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (name, type) => {
      expect(name).toBe("ok:wait");
      const id = h.itemFor("ok");
      expect(type).toBe(inboxEventType(id));
      expect(h.items.get(id)?.item).toMatchObject({
        kind: "approval",
        title: "Approve sheet goods",
        payload: { amount: "120.5000" },
      });
      runner.deliver(type, { approved: true, by: "u-9" });
    };
    const result = await executeWorkflow(
      runner,
      h.context(),
      wf([
        person(),
        {
          id: "f",
          kind: "fork",
          name: "Approved?",
          paths: [
            {
              id: "p-yes",
              name: "Yes",
              when: { rules: [{ field: "{{steps.ok.output.approved}}", op: "is", value: true }] },
              steps: [],
            },
          ],
          otherwise: { id: "o", steps: [] },
        },
      ]),
      { what: "sheet goods", amount: "120.5000" },
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("ok")).toMatchObject({
      status: "succeeded",
      output: { approved: true, answer: null, by: "u-9" },
      summary: "Approve the order: approved",
    });
    expect(h.row("f")?.output).toEqual({ pathId: "p-yes", pathName: "Yes" });
    expect(h.items.get(h.itemFor("ok"))?.received).toBe(1);
  });

  it("skips the wait when the item was already resolved", async () => {
    const h = new Harness();
    const runner = new FakeStepRunner();
    // Resolve the item as soon as it exists, before the executor checks.
    const create = h.inbox.createForPerson;
    h.inbox.createForPerson = async (item) => {
      const made = await create(item);
      const entry = h.items.get(made.id);
      if (entry) entry.resolution = { approved: true, by: "u-1" };
      return made;
    };
    const result = await executeWorkflow(runner, h.context(), wf([person()]), { what: "x" });
    expect(result.status).toBe("succeeded");
    expect(runner.names("wait")).toEqual([]);
  });

  it("handles a rejection per onReject", async () => {
    for (const onReject of ["stop", "continue"] as const) {
      const h = new Harness();
      const runner = new FakeStepRunner({ onWait: "block" });
      runner.onWaitStarted = (_n, type) => runner.deliver(type, { approved: false, by: "u-1" });
      const result = await executeWorkflow(runner, h.context(), wf([person({ onReject })]), {
        what: "x",
      });
      expect(h.row("ok")?.summary).toBe("Approve the order: not approved");
      expect(result.status).toBe(onReject === "stop" ? "cancelled" : "succeeded");
    }
  });

  it("handles a timeout per onTimeout", async () => {
    for (const onTimeout of ["stop", "continue", "notify_operator"] as const) {
      const h = new Harness();
      const runner = new FakeStepRunner({ onWait: "timeout" });
      const result = await executeWorkflow(
        runner,
        h.context(),
        wf([
          person({ onTimeout }),
          {
            id: "n",
            kind: "notify",
            name: "N",
            channel: "thread",
            message: "approved={{steps.ok.output.approved}}",
          },
        ]),
        { what: "x" },
      );
      expect(h.items.get(h.itemFor("ok"))?.expired).toBe(true);
      expect(h.row("ok")?.summary).toBe("Approve the order: no answer in time");
      if (onTimeout === "continue") {
        expect(result.status).toBe("succeeded");
        expect(h.sent[0]?.text).toBe("approved=false");
      } else {
        expect(result).toEqual({ status: "failed", reason: "timeout", nodeId: "ok" });
        expect(h.sent).toHaveLength(0);
      }
      expect(h.operatorNotices).toHaveLength(onTimeout === "notify_operator" ? 1 : 0);
    }
  });

  it("asks a question and returns the answer", async () => {
    const h = new Harness();
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_n, type) => runner.deliver(type, { answer: "use the oak", by: "u-2" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      wf([person({ mode: "ask", title: "Which?" })]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.items.get(h.itemFor("ok"))?.item?.kind).toBe("request");
    expect(h.row("ok")?.output).toEqual({ approved: true, answer: "use the oak", by: "u-2" });
  });
});

describe("forks", () => {
  const fork = {
    id: "f",
    kind: "fork",
    name: "By size",
    paths: [
      {
        id: "big",
        name: "Big",
        when: { rules: [{ field: "{{trigger.total}}", op: ">", value: 1000 }] },
        steps: [{ id: "a", kind: "skill", name: "A", skill: "x.y" }],
      },
      {
        id: "mid",
        name: "Mid",
        when: { rules: [{ field: "{{trigger.total}}", op: ">", value: 100 }] },
        steps: [{ id: "b", kind: "skill", name: "B", skill: "x.y" }],
      },
    ],
    otherwise: { id: "rest", steps: [{ id: "c", kind: "skill", name: "C", skill: "x.y" }] },
  };
  const after = {
    id: "z",
    kind: "skill",
    name: "Z",
    skill: "x.y",
    input: { path: "{{steps.f.output.pathId}}", inner: "{{steps.a.output}}" },
  };

  it("runs the first matching path, then joins", async () => {
    const h = new Harness();
    const result = await executeWorkflow(new FakeStepRunner(), h.context(), wf([fork, after]), {
      total: 5000,
    });
    expect(result.status).toBe("succeeded");
    // 5000 matches both paths; only the first runs.
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["a", "z"]);
    // Inside-path outputs are not visible after the join; the fork's own output is.
    expect(h.agentCalls[1]?.input).toEqual({ path: "big", inner: undefined });
  });

  it("takes the next path, or otherwise", async () => {
    let h = new Harness();
    await executeWorkflow(new FakeStepRunner(), h.context(), wf([fork]), { total: 500 });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["b"]);
    h = new Harness();
    await executeWorkflow(new FakeStepRunner(), h.context(), wf([fork]), { total: 5 });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["c"]);
    expect(h.row("f")?.output).toEqual({ pathId: "rest", pathName: "Otherwise" });
  });
});

describe("for_each", () => {
  it("runs each item with bounded concurrency under stepId:index:childId names", async () => {
    const h = new Harness();
    let running = 0;
    let peak = 0;
    h.handlers.line = async (req) => {
      running++;
      peak = Math.max(peak, running);
      await later();
      running--;
      return { kind: "done", output: { seen: req.input } };
    };
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context(),
      wf([
        {
          id: "each",
          kind: "for_each",
          name: "Each line",
          over: "{{trigger.lines}}",
          concurrency: 2,
          steps: [
            {
              id: "line",
              kind: "skill",
              name: "Line",
              skill: "x.y",
              input: { sku: "{{item.sku}}", i: "{{index}}" },
            },
          ],
        },
        {
          id: "after",
          kind: "skill",
          name: "After",
          skill: "x.y",
          input: { n: "{{steps.each.output.count}}" },
        },
      ]),
      { lines: [{ sku: "a" }, { sku: "b" }, { sku: "c" }, { sku: "d" }, { sku: "e" }] },
    );
    expect(result.status).toBe("succeeded");
    expect(peak).toBe(2);
    const names = h.agentCalls.map((c) => c.nodeId);
    expect(names.slice(0, 5).sort()).toEqual([
      "each:0:line",
      "each:1:line",
      "each:2:line",
      "each:3:line",
      "each:4:line",
    ]);
    expect(h.agentCalls.find((c) => c.nodeId === "each:3:line")?.input).toEqual({ sku: "d", i: 3 });
    expect(h.agentCalls.at(-1)?.input).toEqual({ n: 5 });
    expect(h.row("each")).toMatchObject({
      status: "succeeded",
      output: { count: 5 },
      summary: "Each line: 5 items",
    });
  });

  it("names nested loops by chaining, and forks inside keep the item's prefix", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        {
          id: "outer",
          kind: "for_each",
          name: "O",
          over: "{{trigger.rows}}",
          steps: [
            {
              id: "inner",
              kind: "for_each",
              name: "I",
              over: "{{item}}",
              steps: [
                {
                  id: "f",
                  kind: "fork",
                  name: "F",
                  paths: [
                    {
                      id: "p",
                      name: "P",
                      when: { rules: [{ field: "{{item}}", op: ">", value: 1 }] },
                      steps: [{ id: "s", kind: "skill", name: "S", skill: "x.y" }],
                    },
                  ],
                  otherwise: { id: "o", steps: [] },
                },
              ],
            },
          ],
        },
      ]),
      { rows: [[1, 2], [3]] },
    );
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls.map((c) => c.nodeId).sort()).toEqual([
      "outer:0:inner:1:s",
      "outer:1:inner:0:s",
    ]);
  });

  it("stops starting items after one ends the run", async () => {
    const h = new Harness();
    h.handlers.line = (req) =>
      (req.input as { i: number }).i === 1
        ? { kind: "failed", error: "bad line" }
        : { kind: "done", output: {} };
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        {
          id: "each",
          kind: "for_each",
          name: "E",
          over: "{{trigger.lines}}",
          concurrency: 1,
          steps: [
            { id: "line", kind: "skill", name: "L", skill: "x.y", input: { i: "{{index}}" } },
          ],
        },
      ]),
      { lines: [0, 1, 2, 3] },
    );
    expect(result).toEqual({ status: "failed", reason: "bad line", nodeId: "each:1:line" });
    expect(h.agentCalls).toHaveLength(2);
    expect(h.row("each")?.status).toBe("failed");
  });

  it("fails when `over` is not a list", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        {
          id: "each",
          kind: "for_each",
          name: "E",
          over: "{{trigger.nope}}",
          steps: [{ id: "x", kind: "stop", name: "S", status: "succeeded" }],
        },
      ]),
      {},
    );
    expect(result).toMatchObject({ status: "failed", nodeId: "each" });
    expect(h.row("each")?.status).toBe("failed");
  });
});

describe("wait, notify and stop", () => {
  it("sleeps for the step's duration", async () => {
    const h = new Harness();
    const runner = new FakeStepRunner();
    await executeWorkflow(
      runner,
      h.context(),
      wf([{ id: "w", kind: "wait", name: "Wait", for: "3 days" }]),
      {},
    );
    expect(runner.calls).toContainEqual({ kind: "sleep", name: "w:sleep", duration: "3 days" });
    expect(h.row("w")?.status).toBe("succeeded");
  });

  it("renders and sends a notification", async () => {
    const h = new Harness();
    await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        {
          id: "n",
          kind: "notify",
          name: "Tell",
          channel: "email",
          to: "{{trigger.who}}",
          message: "Total {{trigger.total}}",
        },
      ]),
      { who: "ap@example.com", total: "12.00" },
    );
    expect(h.sent[0]).toMatchObject({
      channel: "email",
      to: "ap@example.com",
      text: "Total 12.00",
      run: RUN,
      sources: [],
    });
  });

  it("cites its sources: ids and lists of ids, flattened, without blanks or repeats", async () => {
    const h = new Harness();
    await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        {
          id: "n",
          kind: "notify",
          name: "Tell",
          channel: "thread",
          message: "Done",
          sources: ["{{trigger.doc}}", "{{trigger.more}}", "{{trigger.missing}}", "fixed-id"],
        },
      ]),
      { doc: "d1", more: ["t1", "d1", "", 7, "t2"] },
    );
    expect(h.sent[0]?.sources).toEqual(["d1", "t1", "t2", "fixed-id"]);
    expect(h.row("n")?.input).toMatchObject({ sources: ["d1", "t1", "t2", "fixed-id"] });
  });

  it("ends the run with the stop step's status", async () => {
    const h = new Harness();
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        { id: "s", kind: "stop", name: "Done early", status: "cancelled" },
        { id: "x", kind: "skill", name: "X", skill: "x.y" },
      ]),
      {},
    );
    expect(result).toEqual({ status: "cancelled", reason: "stop", nodeId: "s" });
    expect(h.agentCalls).toHaveLength(0);
  });
});

describe("replay", () => {
  it("a restarted run repeats no side effect and reaches the same end", async () => {
    const h = new Harness();
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_n, type) => runner.deliver(type, { approved: true, by: "u" });
    const workflow = wf([
      { id: "s", kind: "skill", name: "S", skill: "x.y", input: { v: "{{trigger.v}}" } },
      person(),
      {
        id: "each",
        kind: "for_each",
        name: "E",
        over: "{{trigger.list}}",
        steps: [{ id: "c", kind: "skill", name: "C", skill: "x.y" }],
      },
      {
        id: "n",
        kind: "notify",
        name: "N",
        channel: "thread",
        message: "{{steps.s.output.echo.v}}",
      },
    ]);
    const trigger = { v: 1, what: "x", amount: "1", list: [1, 2] };
    const first = await executeWorkflow(runner, h.context(), workflow, trigger);
    const calls = h.agentCalls.length;
    const items = h.items.size;
    runner.replay();
    const second = await executeWorkflow(runner, h.context(), workflow, trigger);
    expect(second).toEqual(first);
    expect(h.agentCalls).toHaveLength(calls);
    expect(h.items.size).toBe(items);
    expect(h.sent).toHaveLength(1);
    expect(runner.calls.every((c) => c.kind !== "do" || c.cached)).toBe(true);
  });
});

describe("pool", () => {
  it("never runs more than the limit at once and covers every index", async () => {
    const seen: number[] = [];
    let running = 0;
    let peak = 0;
    await pool(7, 3, async (i) => {
      running++;
      peak = Math.max(peak, running);
      await later();
      seen.push(i);
      running--;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    await pool(0, 3, async () => {
      throw new Error("never");
    });
  });
});
