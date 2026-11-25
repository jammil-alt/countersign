// The step model (docs/step-model-plan.md §4, §8, §9; wave 1, stream A): a v5 workflow runs on the
// executor's engines. A Do runs on the engine its done by and uses pick, its outcome in that
// engine's words; Fork, For each, Wait and Hand off as today's; a Loop on the runtime's loop with
// reads only; a Match through its port; an End delivers the outputs it selects, each through the
// path today's steps take, a write's approval on by default (invariant 8).
import { type SkillDefinition, steps, type ToolSpec } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeMatchPort } from "./fake-match";
import { FakeStepRunner } from "./fake-runner";
import { Harness } from "./fakes.test-helper";
import type { ResolveActionRequest, ResolveMergedRequest, SkillStepRequest } from "./ports";
import { LOOP_SKILL, loadStepModel } from "./step-model";

const tool = (
  id: string,
  sideEffect: ToolSpec["sideEffect"],
  connector: string,
  over: Partial<ToolSpec> = {},
): ToolSpec => ({
  id,
  description: id,
  input: { type: "object" },
  output: { type: "object" },
  sideEffect,
  verb: sideEffect === "none" ? "read" : "update",
  source: connector,
  connector,
  ...over,
});
const TOOLS: Record<string, ToolSpec> = Object.fromEntries(
  [
    tool("testkit.thing.read", "none", "testkit"),
    tool("testkit.thing.update", "external", "testkit"),
    tool("testkit.note.save", "internal", "testkit"),
    tool("sheets.rows.append", "external", "gsheets"),
    tool("excel.rows.append", "external", "excel"),
    tool("qbo.bill.create", "external", "qbo"),
  ].map((t) => [t.id, t]),
);
const READ_DOCUMENT: SkillDefinition = {
  schemaVersion: 1,
  id: "docs.read-document",
  name: "Read document",
  description: "",
  category: "docs",
  mode: "task",
  instructions: "Read it.",
  model: { id: "m" },
  tools: [],
  input: {},
  output: {},
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};
const CATALOG = { tools: TOOLS, skills: { [READ_DOCUMENT.id]: READ_DOCUMENT } };

const MANUAL = { id: "t", on: { type: "manual", input: {} } };
const DONE = { id: "o_done", name: "Done", kind: "nothing" };

const wf = (stepList: unknown[], outputs: unknown[] = [DONE]) =>
  steps.Workflow.parse({ schemaVersion: 5, triggers: [MANUAL], outputs, steps: stepList });

const read = {
  id: "s_read",
  kind: "do",
  name: "Read the thing",
  doneBy: "rules",
  uses: { type: "action", action: "testkit.thing.read" },
  input: { id: "{{trigger.id}}" },
};
const end = (outputs: string[] = ["o_done"], over: Record<string, unknown> = {}) => ({
  id: "s_end",
  kind: "end",
  name: "Finished",
  outputs,
  ...over,
});

async function run(
  h: Harness,
  workflow: steps.Workflow,
  trigger: unknown = { id: "7" },
  extra = {},
) {
  const runner = new FakeStepRunner();
  const result = await executeWorkflow(
    runner,
    h.context({ catalog: CATALOG, ...extra }),
    workflow,
    trigger,
  );
  return { result, runner };
}

describe("a v5 workflow's Do steps", () => {
  it("runs a Get action as a read, its row a read's, and ends on its End", async () => {
    const h = new Harness();
    h.handlers.s_read = () => ({ kind: "done", output: { name: "Bolt" } });
    const { result, runner } = await run(h, wf([read, end()]));
    expect(result).toEqual({ status: "succeeded", reason: "stop", nodeId: "s_end" });
    expect(h.agentCalls[0]?.step).toMatchObject({ kind: "action", tool: "testkit.thing.read" });
    expect(h.agentCalls[0]?.input).toEqual({ id: "7" });
    expect(h.row("s_read")).toMatchObject({ nodeType: "read", status: "succeeded" });
    expect(h.row("s_end")).toMatchObject({ nodeType: "stop", output: { status: "succeeded" } });
    expect(runner.names()).toEqual(["s_read", "s_end"]);
  });

  it("asks for approval on a Change by default (invariant 8)", async () => {
    const h = new Harness();
    const change = {
      id: "s_change",
      kind: "do",
      name: "Update the thing",
      doneBy: "rules",
      uses: { type: "action", action: "testkit.thing.update" },
      input: { id: "{{trigger.id}}" },
    };
    await run(h, wf([change, end()]));
    const call = h.agentCalls[0];
    expect(call?.step).toMatchObject({ kind: "action", tool: "testkit.thing.update" });
    expect(call?.approval.required).toBe("required");
    expect(h.row("s_change")?.nodeType).toBe("write");
  });

  it("resolves a merged write action that is today's write action as one (Email › Send)", async () => {
    const h = new Harness();
    const asked: ResolveActionRequest[] = [];
    h.agent.resolveAction = async (req) => {
      asked.push(req);
      return { tool: "gmail.send", connector: "gmail", connectionId: "c1" };
    };
    const send = {
      id: "s_send",
      kind: "do",
      name: "Email the vendor",
      doneBy: "rules",
      uses: { type: "action", action: "email.send" },
      input: { to: "a@b.co", subject: "Hi", body: "Hello" },
    };
    const { runner } = await run(h, wf([send, end()]));
    expect(asked).toEqual([{ run: h.run, nodeId: "s_send", action: "send_email" }]);
    expect(h.agentCalls[0]?.step).toMatchObject({ kind: "action", tool: "gmail.send" });
    expect(h.agentCalls[0]?.approval.required).toBe("required");
    expect(runner.names()).toContain("s_send:action");
  });

  it("resolves any other merged action against the agent's connectors before the gate", async () => {
    const h = new Harness();
    const asked: ResolveMergedRequest[] = [];
    h.agent.resolveMerged = async (req) => {
      asked.push(req);
      return { tool: "excel.rows.append", connector: "excel" };
    };
    const append = {
      id: "s_rows",
      kind: "do",
      name: "Add the rows",
      doneBy: "rules",
      uses: { type: "action", action: "spreadsheet.rows.append" },
      input: { rows: [] },
    };
    const { result, runner } = await run(h, wf([append, end()]));
    expect(result.status).toBe("succeeded");
    expect(asked).toEqual([{ run: h.run, nodeId: "s_rows", action: "spreadsheet.rows.append" }]);
    expect(h.agentCalls[0]?.step).toMatchObject({ kind: "action", tool: "excel.rows.append" });
    expect(h.agentCalls[0]?.approval.required).toBe("required");
    expect(runner.names()).toEqual(["s_rows:action", "s_rows", "s_end"]);
  });

  it("refuses a merged action that resolves to a tool outside the merge", async () => {
    const h = new Harness();
    h.agent.resolveMerged = async () => ({ tool: "testkit.thing.update", connector: "testkit" });
    const append = {
      id: "s_rows",
      kind: "do",
      name: "Add the rows",
      doneBy: "rules",
      uses: { type: "action", action: "spreadsheet.rows.append" },
    };
    const { result } = await run(h, wf([append, end()]));
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("doesn't run with testkit.thing.update");
    expect(h.agentCalls).toEqual([]);
  });

  it("runs an AI skill as a skill step, its instructions and model as the skill's customization", async () => {
    const h = new Harness();
    h.agent.appliesCustomization = true;
    const ai = {
      id: "s_ai",
      kind: "do",
      name: "Read the invoice",
      doneBy: "ai",
      uses: { type: "skill", skill: "docs.read-document" },
      input: { documentId: "{{trigger.id}}" },
      ai: { text: "Only the header.", values: { strict: true } },
    };
    await run(h, wf([ai, end()]));
    const call = h.agentCalls[0] as SkillStepRequest;
    expect(call.step).toMatchObject({
      kind: "skill",
      skill: "docs.read-document",
      settings: { strict: true },
    });
    expect(call.customize).toEqual({ addInstructions: "Only the header." });
    expect(h.row("s_ai")?.nodeType).toBe("skill");
  });

  it("refuses rules or AI written in the step, which can't run yet", async () => {
    const h = new Harness();
    const written = {
      id: "s_rules",
      kind: "do",
      name: "Work it out",
      doneBy: "ai",
      ai: { text: "Decide." },
    };
    const { result } = await run(h, wf([written, end()]));
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("written in the step");
    expect(h.agentCalls).toEqual([]);
  });

  it("tells the client's team (a Tell) and asks a person", async () => {
    const h = new Harness();
    const tell = {
      id: "s_tell",
      kind: "do",
      name: "Tell AP",
      doneBy: "rules",
      uses: { type: "tell" },
      tell: { to: ["client_admin"], message: "Read {{trigger.id}}" },
    };
    const ask = {
      id: "s_ask",
      kind: "do",
      name: "Check it",
      doneBy: "person",
      person: {
        mode: "approve",
        who: "client_admin",
        question: "Is {{trigger.id}} right?",
        deadline: { after: "1 day" },
      },
    };
    const runner = new FakeStepRunner({ onWait: "timeout" });
    const result = await executeWorkflow(
      runner,
      h.context({ catalog: CATALOG }),
      wf([tell, ask, end()]),
      { id: "7" },
    );
    expect(h.sent[0]).toMatchObject({ text: expect.stringContaining("Read 7") });
    expect([...h.items.values()][0]?.item).toMatchObject({ nodeId: "s_ask", kind: "approval" });
    // Nobody answered in time: the deadline's `stop`.
    expect(result.status).toBe("failed");
  });
});

describe("a v5 Fork, For each and outcomes", () => {
  it("records each Do's outcome in its engine's words, and a Fork routes on it", async () => {
    const h = new Harness();
    h.handlers.s_read = () => ({ kind: "done", output: { rows: [] } });
    const fork = {
      id: "s_fork",
      kind: "fork",
      name: "Found anything?",
      paths: [
        {
          id: "p_empty",
          name: "Nothing",
          when: {
            match: "all",
            rules: [{ field: "{{steps.s_read.outcome}}", op: "=", value: "empty" }],
          },
          steps: [end(["o_done"], { id: "s_end_empty", name: "Nothing found" })],
        },
      ],
      otherwise: { id: "p_else", steps: [] },
    };
    const { result } = await run(h, wf([read, fork, end()]));
    expect(result).toMatchObject({ status: "succeeded", nodeId: "s_end_empty" });
    expect(steps.ENGINE_OUTCOMES.read).toBe("read");
  });

  it("runs a For each's Do steps once per item, named by the loop", async () => {
    const h = new Harness();
    const each = {
      id: "s_each",
      kind: "for_each",
      name: "Each line",
      over: "{{trigger.lines}}",
      concurrency: 1,
      steps: [{ ...read, input: { id: "{{item.id}}" } }],
    };
    const { result } = await run(h, wf([each, end()]), { lines: [{ id: "a" }, { id: "b" }] });
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls.map((c) => c.input)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(h.row("s_each:0:s_read")?.nodeType).toBe("read");
  });
});

describe("a v5 End delivers the workflow's outputs", () => {
  const exceptions = {
    id: "o_report",
    name: "Exceptions to AP",
    kind: "report",
    report: { to: ["client_admin"], message: "{{trigger.count}} exceptions" },
    when: { match: "all", rules: [{ field: "{{trigger.count}}", op: ">", value: 0 }] },
  };
  const write = {
    id: "o_write",
    name: "Thing updated",
    kind: "write",
    action: { action: "testkit.thing.update", input: { id: "{{trigger.id}}" } },
  };
  const save = {
    id: "o_save",
    name: "Note saved",
    kind: "save",
    action: { action: "testkit.note.save", input: { text: "x" } },
  };

  it("sends a report only when its rules hold", async () => {
    const h = new Harness();
    await run(h, wf([end(["o_report"])], [exceptions]), { count: 2 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ text: expect.stringContaining("2 exceptions") });

    const quiet = new Harness();
    const { result } = await run(quiet, wf([end(["o_report"])], [exceptions]), { count: 0 });
    expect(result.status).toBe("succeeded");
    expect(quiet.sent).toEqual([]);
  });

  it("writes through the gate, approval on by default, under the End's name", async () => {
    const h = new Harness();
    const { result, runner } = await run(h, wf([end(["o_write", "o_save"])], [write, save]));
    expect(result.status).toBe("succeeded");
    const [w, s] = h.agentCalls;
    expect(w?.step).toMatchObject({ kind: "action", tool: "testkit.thing.update" });
    expect(w?.approval.required).toBe("required");
    expect(w?.input).toEqual({ id: "7" });
    expect(w?.nodeId).toBe("s_end:out:o_write");
    expect(s?.step).toMatchObject({ kind: "action", tool: "testkit.note.save" });
    expect(runner.names()).toEqual(["s_end:out:o_write", "s_end:out:o_save", "s_end"]);
  });

  it("keeps a write's approval off only where the operator set it off", async () => {
    const h = new Harness();
    const off = { ...write, checks: { approval: { required: "not_required" } } };
    await run(h, wf([end(["o_write"])], [off]));
    expect(h.agentCalls[0]?.approval.required).toBe("not_required");
  });

  it("passes on what the run hands to other agents", async () => {
    const h = new Harness();
    h.handlers.s_read = () => ({ kind: "done", output: { name: "Bolt", id: "r1" } });
    const passOn = {
      id: "o_pass",
      name: "Passed on",
      kind: "pass_on",
      passOn: { output: { name: "{{steps.s_read.output.name}}" }, sources: ["r1"] },
    };
    const { result } = await run(h, wf([read, end(["o_pass"])], [passOn]));
    expect(result.passedOn).toEqual({ output: { name: "Bolt" }, sources: ["r1"] });
  });

  it("ends the run failed on a failed End, as today's Stop", async () => {
    const h = new Harness();
    const failed = {
      id: "s_end",
      kind: "end",
      name: "Give up",
      status: "failed",
      nothingToDo: "x",
    };
    const { result } = await run(h, wf([failed], [DONE]));
    expect(result).toMatchObject({ status: "failed", reason: "stop", nodeId: "s_end" });
  });
});

describe("a v5 Match and Loop", () => {
  const match = {
    id: "s_match",
    kind: "do",
    name: "Match the lines",
    doneBy: "rules",
    uses: { type: "match", match: { to: "vendor-items", type: "exact" } },
    input: { items: "{{trigger.lines}}" },
  };

  it("matches through the port and records the result", async () => {
    const h = new Harness();
    const port = new FakeMatchPort({ "SKU-1": "vi-1" });
    const { result } = await run(
      h,
      wf([match, end()]),
      { lines: [{ sku: "SKU-1" }, { sku: "SKU-9" }] },
      { match: port },
    );
    expect(result.status).toBe("succeeded");
    expect(port.asked[0]?.match).toMatchObject({ to: "vendor-items", type: "exact" });
    expect(h.row("s_match")).toMatchObject({
      nodeType: "skill",
      status: "succeeded",
      output: { matched: 1 },
    });
  });

  it("fails without a Match port, matching nothing", async () => {
    const h = new Harness();
    const { result } = await run(h, wf([match, end()]), { lines: [] });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("matches records");
  });

  it("runs a Loop on the runtime's loop with its Get actions only", async () => {
    const h = new Harness();
    const loop = {
      id: "s_loop",
      kind: "loop",
      name: "Look into the leftovers",
      goal: "Find why the lines don't match",
      reads: ["testkit.thing.read", "testkit.thing.update"],
      maxTurns: 4,
      atLimit: "hand_back",
      output: [{ name: "why", type: "text", required: true }],
    };
    await run(h, wf([loop, end()]));
    const call = h.agentCalls[0] as SkillStepRequest;
    expect(call.step).toMatchObject({ kind: "skill", skill: LOOP_SKILL });
    expect(call.loop).toEqual({
      goal: "Find why the lines don't match",
      instructions: "",
      reads: ["testkit.thing.read"],
      maxTurns: 4,
      atLimit: "hand_back",
      output: {
        type: "object",
        properties: { why: { type: "string" } },
        required: ["why"],
      },
    });
  });
});

describe("loading a v5 workflow", () => {
  it("refuses one that doesn't parse, before anything runs", async () => {
    const h = new Harness();
    const { result } = await run(h, { schemaVersion: 5, triggers: [MANUAL] } as never);
    expect(result.status).toBe("failed");
    expect(h.rows.size).toBe(0);
  });

  it("keeps every id, so durable names and hand-offs are a v4 step's", () => {
    const loaded = loadStepModel(wf([read, end()]), () => "get");
    expect(loaded.process.steps.map((s) => [s.id, s.kind])).toEqual([
      ["s_read", "read"],
      ["s_end", "stop"],
    ]);
  });
});
