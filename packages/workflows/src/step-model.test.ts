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
import { Harness, RUN } from "./fakes.test-helper";
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

  it("maps a merged action's input to its tool's words, and the output back", async () => {
    const h = new Harness();
    h.agent.resolveMerged = async () => ({ tool: "excel.rows.append", connector: "excel" });
    h.agent.mergedInput = (_a, connector, input) => ({ ...(input as object), to: connector });
    h.agent.mergedOutput = (_a, _c, output) => ({ mapped: output });
    h.handlers.s_rows = () => ({ kind: "done", output: { workbookId: "w1" } });
    const append = {
      id: "s_rows",
      kind: "do",
      name: "Add the rows",
      doneBy: "rules",
      uses: { type: "action", action: "spreadsheet.rows.append" },
      input: { spreadsheetId: "w1" },
    };
    const after = {
      id: "s_tell",
      kind: "do",
      name: "Tell",
      doneBy: "rules",
      uses: { type: "tell" },
      tell: { to: ["client_admin"], message: "Added to {{steps.s_rows.output.mapped.workbookId}}" },
    };
    await run(h, wf([append, after, end()]));
    expect(h.agentCalls[0]?.input).toEqual({ spreadsheetId: "w1", to: "excel" });
    expect(h.sent[0]).toMatchObject({ text: expect.stringContaining("Added to w1") });
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

  it("runs AI written in the step on the step skill its version pins, on the step's model", async () => {
    const h = new Harness();
    const written = {
      id: "s_ai",
      kind: "do",
      name: "Work it out",
      doneBy: "ai",
      ai: { text: "Decide.", model: { id: "claude-haiku-5-5" } },
    };
    const pinned = "custom:step-agent-1-s-ai@3";
    const asked: string[] = [];
    const { result } = await run(
      h,
      wf([written, end()]),
      { id: "7" },
      {
        stepSkill: (id: string) => {
          asked.push(id);
          return id === "s_ai" ? pinned : undefined;
        },
      },
    );
    expect(result.status).toBe("succeeded");
    expect(asked).toEqual(["s_ai"]);
    expect(h.agentCalls[0]?.step).toMatchObject({
      kind: "skill",
      skill: pinned,
      model: { id: "claude-haiku-5-5" },
    });
    // The text is the pinned skill's: nothing of the step's is layered on it.
    expect((h.agentCalls[0] as SkillStepRequest).customize).toBeUndefined();
  });

  it("runs rules written in the step as their pinned skill", async () => {
    const h = new Harness();
    const written = {
      id: "s_rules",
      kind: "do",
      name: "Sort it",
      doneBy: "rules",
      rules: { rows: [{ id: "r1", when: { match: "all", rules: [] }, set: { ok: true } }] },
    };
    await run(h, wf([written, end()]), { id: "7" }, { stepSkill: () => "custom:step-a-s-rules@1" });
    expect(h.agentCalls[0]?.step).toMatchObject({
      kind: "skill",
      skill: "custom:step-a-s-rules@1",
    });
  });

  it("fails a step written in the step with no pinned version, in plain words", async () => {
    const h = new Harness();
    const written = {
      id: "s_ai",
      kind: "do",
      name: "Work it out",
      doneBy: "ai",
      ai: { text: "Decide." },
    };
    const { result } = await run(h, wf([written, end()]));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe(
      `the step "Work it out" has no saved version of what is written in it: save the workflow and publish it again`,
    );
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

describe("a v5 Do step's incoming side (stream G)", () => {
  const needs = [
    { name: "vendorName", type: "text" as const, required: true },
    { name: "total", type: "money" as const, required: true },
  ];
  const source = {
    ref: "steps.s_read.output",
    label: "Read the thing",
    fields: [
      {
        name: "header",
        type: "group" as const,
        required: true,
        of: [
          { name: "supplier", type: "text" as const, required: true },
          { name: "total", type: "money" as const, required: true },
        ],
      },
    ],
  };
  const translated = () => {
    const w = steps.workOutTranslation({ needs, sources: [source] });
    return {
      id: "s_change",
      kind: "do",
      name: "Update the thing",
      doneBy: "rules",
      uses: { type: "action", action: "testkit.thing.update" },
      input: w.input,
      translation: w.translation,
    };
  };

  it("translates the resolved input in code before the engine runs, sources dropped", async () => {
    const h = new Harness();
    h.handlers.s_read = () => ({
      kind: "done",
      output: { header: { supplier: "Acme", total: "12.50" } },
    });
    const { result, runner } = await run(h, wf([read, translated(), end()]));
    expect(result.status).toBe("succeeded");
    // A field that fits is wired straight; a translated one is worked out from the source key.
    expect(h.agentCalls[1]?.input).toEqual({ vendorName: "Acme", total: "12.50" });
    expect(runner.names()[0]).toBe("run:today");
  });

  it("fails the step in plain words when a field can't be filled", async () => {
    const h = new Harness();
    h.handlers.s_read = () => ({ kind: "done", output: { header: {} } });
    const { result } = await run(h, wf([read, translated(), end()]));
    expect(result.status).toBe("failed");
    expect(result.nodeId).toBe("s_change");
    expect(result.reason).toContain(`what comes into "Update the thing" can't be translated`);
    expect(h.agentCalls).toHaveLength(1);
  });

  it("never hands a source key to an engine, with or without a translation", async () => {
    const h = new Harness();
    const plain = { ...read, id: "s_two", input: { id: "1", _s_read: "{{trigger}}" } };
    await run(h, wf([plain, end()]));
    expect(h.agentCalls[0]?.input).toEqual({ id: "1" });
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

  // Owner, 2026-11-27: the employee asked inside a path, the answer read by the coding after it.
  it("hands on what the path's last step gave, and nothing else from inside it", async () => {
    const h = new Harness();
    h.handlers.s_read = () => ({ kind: "done", output: { needs: true } });
    h.handlers.s_first = () => ({ kind: "done", output: { secret: "inner" } });
    h.handlers.s_ask = () => ({ kind: "done", output: { answers: "Hall job, company card" } });
    h.handlers.s_use = () => ({ kind: "done", output: {} });
    const inPath = (id: string) => ({ ...read, id, name: id, input: { id: "x" } });
    const fork = {
      id: "s_fork",
      kind: "fork",
      name: "Ask?",
      paths: [
        {
          id: "p_ask",
          name: "Ask",
          when: {
            match: "all",
            rules: [{ field: "{{steps.s_read.output.needs}}", op: "=", value: true }],
          },
          steps: [inPath("s_first"), inPath("s_ask")],
        },
      ],
      otherwise: { id: "p_else", steps: [] },
    };
    const use = {
      ...read,
      id: "s_use",
      name: "Use the answers",
      input: {
        id: "{{steps.s_fork.output.answers}}",
        path: "{{steps.s_fork.output.pathName}}",
        inner: "{{steps.s_fork.output.secret}}",
      },
    };
    const { result } = await run(h, wf([read, fork, use, end()]));
    expect(result.status).toBe("succeeded");
    expect(h.agentCalls.find((c) => c.step.id === "s_use")?.input).toEqual({
      id: "Hall job, company card",
      path: "Ask",
    });

    // The other way: nothing asked, so nothing handed on but the path.
    const h2 = new Harness();
    h2.handlers.s_read = () => ({ kind: "done", output: { needs: false } });
    h2.handlers.s_use = () => ({ kind: "done", output: {} });
    await run(h2, wf([read, fork, use, end()]));
    expect(h2.agentCalls.find((c) => c.step.id === "s_use")?.input).toEqual({
      path: "Otherwise",
    });
  });

  // Staging, 2026-11-27: "Read each receipt" handed on only its count, so the step after it
  // never saw what was read.
  it("hands on each item's last result, in order, and keeps them on its row", async () => {
    const h = new Harness();
    h.handlers.s_read = (req) => ({
      kind: "done",
      output: { total: (req.input as { id: string }).id === "a" ? "93.00" : "54.52" },
    });
    h.handlers.s_use = () => ({ kind: "done", output: {} });
    const each = {
      id: "s_each",
      kind: "for_each",
      name: "Each receipt",
      over: "{{trigger.lines}}",
      concurrency: 2,
      steps: [{ ...read, input: { id: "{{item.id}}" } }],
    };
    const use = {
      ...read,
      id: "s_use",
      name: "Use",
      input: { id: "{{steps.s_each.output.items}}" },
    };
    const { result } = await run(h, wf([each, use, end()]), { lines: [{ id: "a" }, { id: "b" }] });
    expect(result.status).toBe("succeeded");
    const items = [{ total: "93.00" }, { total: "54.52" }];
    expect(h.agentCalls.find((c) => c.step.id === "s_use")?.input).toEqual({ id: items });
    expect(h.row("s_each")?.output).toEqual({ count: 2, items });
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
      outputs: ["o_done"],
    };
    const { result } = await run(h, wf([failed], [DONE]));
    expect(result).toMatchObject({ status: "failed", reason: "stop", nodeId: "s_end" });
  });
});

describe("a v5 workflow that names seats", () => {
  const SEATS = {
    "bill-approver": { userIds: ["luis"], backupUserIds: [], contactIds: [] },
  };
  const append = {
    id: "s_rows",
    kind: "do",
    name: "Add the rows",
    doneBy: "rules",
    uses: { type: "action", action: "spreadsheet.rows.append" },
    input: { rows: [] },
    checks: { approval: { approvers: [{ who: "seat:bill-approver" }] } },
  };
  const report = {
    id: "o_report",
    name: "Rows added",
    kind: "report",
    report: { to: ["seat:bill-approver"], message: "Rows added" },
  };

  it("keeps each step's v5 meaning once its seats are filled: merged actions and End outputs", async () => {
    const h = new Harness();
    const asked: ResolveMergedRequest[] = [];
    h.agent.resolveMerged = async (req) => {
      asked.push(req);
      return { tool: "excel.rows.append", connector: "excel" };
    };
    const { result, runner } = await run(h, wf([append, end(["o_report"])], [report]), undefined, {
      seats: SEATS,
    });
    expect(result.status).toBe("succeeded");
    // The merged action resolved for the agent before the gate.
    expect(asked).toHaveLength(1);
    expect(h.agentCalls[0]?.step).toMatchObject({ kind: "action", tool: "excel.rows.append" });
    // The End delivered its report (to the seat's person), then ended the run.
    expect(runner.names()).toEqual([
      "s_rows:action",
      "s_rows",
      "s_end:out:o_report",
      "s_end:out:o_report:logged",
      "s_end",
    ]);
    expect(h.sent).toHaveLength(1);
    expect(JSON.stringify(h.sent[0])).toContain("luis");
    expect(JSON.stringify(h.sent[0])).not.toContain("seat:");
  });

  it("words a delivered output's line with its name quoted, in a live and a test run", async () => {
    const named = { ...report, name: "The bill, itemized" };
    const wfn = wf([append, end(["o_report"])], [named]);
    const live = new Harness();
    live.agent.resolveMerged = async () => ({ tool: "excel.rows.append", connector: "excel" });
    await run(live, wfn, undefined, { seats: SEATS });
    expect(live.row("s_end:out:o_report")?.summary).toBe("Sent “The bill, itemized”");
    const test = new Harness({ ...RUN, mode: "test" });
    test.agent.resolveMerged = async () => ({ tool: "excel.rows.append", connector: "excel" });
    await run(test, wfn, undefined, { seats: SEATS });
    expect(test.row("s_end:out:o_report")?.summary).toBe(
      "Would send “The bill, itemized” (test run, not sent)",
    );
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

  it("records the records its matches rest on as the step's sources (invariant 10)", async () => {
    const h = new Harness();
    const port = new FakeMatchPort({ "SKU-1": "vi-1" });
    await run(h, wf([match, end()]), { lines: [{ sku: "SKU-1" }] }, { match: port });
    expect(h.row("s_match")?.output).toMatchObject({ sources: ["raw-SKU-1", "vi-1"] });
  });

  const unsure = () =>
    new FakeMatchPort({ "SKU-1": "vi-1" }, undefined, {
      "SKU-7": { "vi-7": "Bolt 6mm", "vi-8": "Bolt 8mm" },
    });
  const answering = (answer: unknown, mode: "live" | "test" = "live") => {
    const h = new Harness({ ...RUN, mode });
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_n, type) => runner.deliver(type, { answer, by: "u-5" });
    return { h, runner };
  };

  it("asks a person about an unsure item, and learns their answer", async () => {
    const port = unsure();
    const { h, runner } = answering("vi-8");
    const result = await executeWorkflow(
      runner,
      h.context({ catalog: CATALOG, match: port }),
      wf([match, end()]),
      { lines: [{ sku: "SKU-1" }, { sku: "SKU-7" }] },
    );
    expect(result.status).toBe("succeeded");
    const asked = [...h.items.values()][0]?.item;
    expect(asked).toMatchObject({
      nodeId: "s_match:ask:1",
      kind: "request",
      title: 'Vendor items: which one is "SKU-7"?',
    });
    expect(h.row("s_match")).toMatchObject({
      status: "succeeded",
      output: { matched: 2, unsure: 0, anyUnsure: false },
    });
    const output = h.row("s_match")?.output as
      | { items: { matched: string; how: string }[] }
      | undefined;
    const items = output?.items ?? [];
    expect(items[1]).toMatchObject({ matched: "vi-8", how: "person" });
    expect(port.learned).toEqual([
      {
        run: h.run,
        nodeId: "s_match:ask:1",
        profile: "vendor-items",
        item: { sku: "SKU-7" },
        recordId: "vi-8",
        personId: "u-5",
      },
    ]);
  });

  it("learns nothing in a test run, and nothing from a record it didn't offer", async () => {
    const test = unsure();
    const a = answering("vi-8", "test");
    await executeWorkflow(
      a.runner,
      a.h.context({ catalog: CATALOG, match: test }),
      wf([match, end()]),
      {
        lines: [{ sku: "SKU-7" }],
      },
    );
    expect(test.learned).toEqual([]);

    const live = unsure();
    const b = answering("vi-999");
    await executeWorkflow(
      b.runner,
      b.h.context({ catalog: CATALOG, match: live }),
      wf([match, end()]),
      {
        lines: [{ sku: "SKU-7" }],
      },
    );
    expect(live.learned).toEqual([]);
    expect(b.h.row("s_match")?.output).toMatchObject({ anyUnsure: true });
  });

  it("asks the person or seat the Match's confer names, by its deadline, and learns their answer", async () => {
    const port = unsure();
    const named = {
      ...match,
      checks: {
        confer: {
          with: [
            { ai: { focus: "Is it the same vendor item?" } },
            {
              person: "seat:bill-questions",
              deadline: { after: "2 days", hours: "clock", ifNoAnswer: "skip" },
            },
          ],
        },
      },
    };
    const { h, runner } = answering("vi-7");
    const seats = {
      "bill-questions": { userIds: ["u-5"], backupUserIds: [], contactIds: [] },
    };
    const first = await executeWorkflow(
      runner,
      h.context({ catalog: CATALOG, match: port, seats }),
      wf([named, end()]),
      { lines: [{ sku: "SKU-7" }] },
    );
    expect(first.status).toBe("succeeded");
    const asked = [...h.items.values()][0]?.item;
    expect(asked?.step).toMatchObject({ assignee: "u-5" });
    // The reviewer's deadline (2 days), not the default seven.
    const due = Date.parse(asked?.dueAt ?? "") - Date.now();
    expect(due).toBeGreaterThan(86_400_000);
    expect(due).toBeLessThanOrEqual(2 * 86_400_000);
    expect(port.learned).toEqual([
      expect.objectContaining({ item: { sku: "SKU-7" }, recordId: "vi-7", personId: "u-5" }),
    ]);

    // The next run's same item is a learned hit: nobody is asked.
    const again = new Harness();
    await run(again, wf([named, end()]), { lines: [{ sku: "SKU-7" }] }, { match: port, seats });
    expect(again.items.size).toBe(0);
    expect(again.row("s_match")?.output).toMatchObject({
      matched: 1,
      anyUnsure: false,
      items: [{ matched: "vi-7", how: "learned" }],
    });
  });

  it("asks the client admin when the Match names nobody, or its seat is empty", async () => {
    for (const checks of [
      undefined,
      {
        confer: {
          with: [
            {
              person: "seat:bill-questions",
              deadline: { after: "2 days", hours: "clock", ifNoAnswer: "skip" },
            },
          ],
        },
      },
    ]) {
      const { h, runner } = answering("vi-8");
      await executeWorkflow(
        runner,
        h.context({ catalog: CATALOG, match: unsure() }),
        wf([{ ...match, ...(checks ? { checks } : {}) }, end()]),
        { lines: [{ sku: "SKU-7" }] },
      );
      expect([...h.items.values()][0]?.item?.step).toMatchObject({ assignee: "client_admin" });
    }
  });

  it("leaves an item unsure when nobody answers in time", async () => {
    const h = new Harness();
    const port = unsure();
    const { result } = await run(
      h,
      wf([match, end()]),
      { lines: [{ sku: "SKU-7" }] },
      { match: port },
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("s_match")?.output).toMatchObject({ unsure: 1, anyUnsure: true });
    expect(port.learned).toEqual([]);
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

  it("refuses a draft that doesn't pass the publish checks, before anything runs", async () => {
    const h = new Harness();
    const { result } = await run(h, wf([read, end([])]));
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("can't run");
    expect(h.rows.size).toBe(0);
  });

  it("runs a skill on another agent of the client when the step names one", () => {
    const ai = {
      id: "s_ai",
      kind: "do",
      name: "Read it",
      doneBy: "ai",
      uses: { type: "skill", skill: "docs.read-document" },
      agent: "reader",
    };
    const loaded = loadStepModel(wf([ai, end()]), () => undefined);
    expect(loaded.process.steps[0]).toMatchObject({ kind: "skill", agent: "reader" });
  });

  // Staging, 2026-11-27: a Contact step's field with an `about` couldn't start its conversation.
  it("asks a Contact step's output fields by their types, never by what they mean", () => {
    const contact = {
      id: "s_ask",
      kind: "do",
      name: "Ask the employee",
      doneBy: "contact",
      contact: {
        with: "{{trigger.contactId}}",
        channel: "email",
        goal: "Get the project each receipt is for.",
        maxTurns: 4,
        mayShare: [],
        messages: { first: "required", later: "required" },
        deadline: { after: "2 days", hours: "business", ifNoAnswer: "stop" },
      },
      output: [
        { name: "answers", type: "text", required: true, about: "What they said, in plain words" },
        { name: "total", type: "money", required: false },
        { name: "vendor", type: "record", record: "vendor", required: true },
        {
          name: "lines",
          type: "list",
          of: [{ name: "x", type: "text", required: true }],
          required: false,
        },
      ],
    };
    const loaded = loadStepModel(wf([contact, end()]), () => undefined);
    expect(loaded.process.steps[0]).toMatchObject({
      kind: "conversation",
      find: { answers: "text", total: "money?", vendor: "vendor", lines: "text[]?" },
    });
    for (const spec of Object.values(
      (loaded.process.steps[0] as { find: Record<string, string> }).find,
    )) {
      expect(spec).not.toContain(" ");
    }
  });

  it("keeps every id, so durable names and hand-offs are a v4 step's", () => {
    const loaded = loadStepModel(wf([read, end()]), () => "get");
    expect(loaded.process.steps.map((s) => [s.id, s.kind])).toEqual([
      ["s_read", "read"],
      ["s_end", "stop"],
    ]);
  });
});
