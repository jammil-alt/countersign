// M61 (ARCHITECTURE v0.17 §10.14 "Automations, repeat and the agent's choice"; docs/plan.md §1.99):
// an `if` its agent decides among the paths its rules allow, and a repeat its agent says is done.
// The port is a fake here; packages/agents' runtime answers it in apps/api.
import type { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, WRITE_TOOL } from "./fakes.test-helper";
import type { ChoicePort, ChoiceRequest, JudgeRequest } from "./ports";

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const READ_TOOL = { ...WRITE_TOOL, id: "testkit.thing.get", sideEffect: "none" as const };
const CATALOG = { tools: { [WRITE_TOOL.id]: WRITE_TOOL, [READ_TOOL.id]: READ_TOOL } };

function proc(steps: unknown[]): processes.Process {
  return { schemaVersion: 4, triggers: [MANUAL], steps } as unknown as processes.Process;
}

const read = (id: string) => ({ id, kind: "read", name: id, tool: READ_TOOL.id, input: {} });
const ALL = { match: "all", rules: [] };

/** An if the agent decides: reorder (only under $2,000, by rule), quote, or ask the owner. */
function agentIf(over: Record<string, unknown> = {}) {
  return {
    id: "how",
    kind: "if",
    name: "How to buy",
    decide: "agent",
    paths: [
      {
        id: "reorder",
        name: "Reorder from the usual vendor",
        describe: "The item is on the usual vendor's list.",
        when: {
          match: "all",
          rules: [{ field: "{{trigger.total}}", op: "<", value: 2000 }],
        },
        steps: [read("r1")],
      },
      {
        id: "quote",
        name: "Get two quotes",
        describe: "The item is new, or the usual vendor doesn't carry it.",
        when: ALL,
        steps: [read("q1")],
      },
    ],
    otherwise: { id: "else", steps: [read("o1")] },
    ...over,
  };
}

function fakePort(answer: Partial<{ path: string | null; done: (boolean | null)[] }>) {
  const chose: ChoiceRequest[] = [];
  const judged: JudgeRequest[] = [];
  const done = [...(answer.done ?? [])];
  const port: ChoicePort = {
    async choose(req) {
      chose.push(req);
      return { path: answer.path ?? null, by: "Pia" };
    },
    async judge(req) {
      judged.push(req);
      const d = done.shift() ?? null;
      return { done: d, ...(d === false ? { feedback: `fix pass ${req.pass}` } : {}), by: "Pia" };
    },
  };
  return { port, chose, judged };
}

const ran = (h: Harness) => h.agentCalls.map((c) => c.nodeId);

describe("an if the agent decides", () => {
  it("asks the agent among the paths the rules allow, and takes its pick", async () => {
    const h = new Harness();
    const { port, chose } = fakePort({ path: "quote" });
    const runner = new FakeStepRunner();
    const result = await executeWorkflow(
      runner,
      h.context({ catalog: CATALOG, choice: port }),
      proc([agentIf()]),
      { total: 500, item: "Baltic birch" },
    );
    expect(result.status).toBe("succeeded");
    expect(chose).toHaveLength(1);
    expect(chose[0]?.paths.map((p) => [p.id, p.describe])).toEqual([
      ["reorder", "The item is on the usual vendor's list."],
      ["quote", "The item is new, or the usual vendor doesn't carry it."],
    ]);
    // What it reads is data: the trigger and the outputs in scope.
    expect(chose[0]?.data).toEqual({ trigger: { total: 500, item: "Baltic birch" }, steps: {} });
    expect(ran(h)).toEqual(["q1"]);
    expect(h.row("how")).toMatchObject({
      output: { pathId: "quote", pathName: "Get two quotes" },
      summary: "How to buy: Pia chose: Get two quotes",
    });
    expect(runner.names()).toContain("how:choose");
  });

  it("never asks when the rules leave one path, and never takes a path they refuse", async () => {
    const h = new Harness();
    const { port, chose } = fakePort({ path: "reorder" });
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG, choice: port }),
      proc([agentIf()]),
      { total: 5000 },
    );
    // Over $2,000: only "quote" is allowed, so it is taken without a call.
    expect(chose).toHaveLength(0);
    expect(ran(h)).toEqual(["q1"]);

    const h2 = new Harness();
    const refused = fakePort({ path: "reorder" });
    await executeWorkflow(
      new FakeStepRunner(),
      h2.context({ catalog: CATALOG, choice: refused.port }),
      proc([
        agentIf({
          paths: [
            ...agentIf().paths,
            {
              id: "owner",
              name: "Ask the owner",
              describe: "Anything unusual.",
              when: ALL,
              steps: [read("w1")],
            },
          ],
        }),
      ]),
      { total: 5000 },
    );
    // The agent named a path its rules refused: unsure, so otherwise.
    expect(refused.chose[0]?.paths.map((p) => p.id)).toEqual(["quote", "owner"]);
    expect(ran(h2)).toEqual(["o1"]);
    expect(h2.row("how")?.summary).toBe("How to buy: Pia wasn't sure: otherwise");
  });

  it("when unsure with ifUnsure ask, has a person pick among the allowed paths", async () => {
    const h = new Harness();
    const { port } = fakePort({ path: null });
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_n, type) => runner.deliver(type, { answer: "reorder", by: "u-1" });
    const result = await executeWorkflow(
      runner,
      h.context({ catalog: CATALOG, choice: port }),
      proc([agentIf({ ifUnsure: "ask" })]),
      { total: 500 },
    );
    expect(result.status).toBe("succeeded");
    const asked = [...h.items.values()].find((i) => i.item?.nodeId === "how:ask")?.item;
    expect(asked?.step.choices?.map((c) => c.value)).toEqual(["reorder", "quote"]);
    expect(ran(h)).toEqual(["r1"]);
    expect(h.row("how")?.summary).toBe(
      "How to buy: Pia wasn't sure, so it asked: Reorder from the usual vendor",
    );
  });

  it("without a port, is unsure and takes otherwise; a replay asks nothing again", async () => {
    const h = new Harness();
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG }),
      proc([agentIf()]),
      { total: 500 },
    );
    expect(ran(h)).toEqual(["o1"]);

    const h2 = new Harness();
    const { port, chose } = fakePort({ path: "quote" });
    const runner = new FakeStepRunner();
    const ctx = h2.context({ catalog: CATALOG, choice: port });
    await executeWorkflow(runner, ctx, proc([agentIf()]), { total: 500 });
    runner.replay();
    await executeWorkflow(runner, ctx, proc([agentIf()]), { total: 500 });
    expect(chose).toHaveLength(1);
  });
});

describe("a repeat the agent says is done", () => {
  const judgedRepeat = (over: Record<string, unknown> = {}) => ({
    id: "rep",
    kind: "repeat",
    name: "Draft the RFQ",
    steps: [
      {
        id: "draft",
        kind: "read",
        name: "Draft",
        tool: READ_TOOL.id,
        input: { pass: "{{loop.pass}}", fix: "{{loop.feedback}}" },
      },
    ],
    until: { agent: { goal: "The RFQ names every line, a quantity and a date." } },
    maxTimes: 3,
    ...over,
  });

  it("asks after each pass, passes its feedback on, and ends when it says done", async () => {
    const h = new Harness();
    h.handlers.draft = (req) => ({ kind: "done", output: { text: `draft ${String(req.input)}` } });
    const { port, judged } = fakePort({ done: [false, true] });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG, choice: port }),
      proc([judgedRepeat()]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(judged.map((j) => [j.pass, j.goal])).toEqual([
      [1, "The RFQ names every line, a quantity and a date."],
      [2, "The RFQ names every line, a quantity and a date."],
    ]);
    expect(h.agentCalls.map((c) => c.input)).toEqual([
      { pass: 1, fix: undefined },
      { pass: 2, fix: "fix pass 1" },
    ]);
    expect(h.row("rep")).toMatchObject({ output: { passes: 2, done: true } });
  });

  it("ends at its limit when no answer holds, never spending the passes left", async () => {
    const h = new Harness();
    const { port } = fakePort({ done: [null] });
    const result = await executeWorkflow(
      new FakeStepRunner(),
      h.context({ catalog: CATALOG, choice: port }),
      proc([judgedRepeat({ onLimit: "proceed" })]),
      {},
    );
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls).toHaveLength(1);
    expect(h.row("rep")).toMatchObject({ output: { passes: 1, done: false } });
  });
});
