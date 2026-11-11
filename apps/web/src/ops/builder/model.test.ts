// The builder's model: a stored v3 workflow read as a v4 process with every id kept, edits that
// keep every id, moves into and out of if paths and loops, new steps with approval on, the
// approval control's rules, customizations against the template, and undo/redo.
import {
  AgentBundle,
  type AgentBundleInput,
  canonicalJson,
  nodeIds,
  type ProcessAgentBundle,
  processes,
  type SkillDefinition,
  type ToolSpec,
  type TypingContext,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  type ApprovalEnv,
  addTrigger,
  addWorkflow,
  allowStep,
  approvalOption,
  commit,
  createStep,
  customizedSteps,
  editWorkflow,
  getContainer,
  holdsV3,
  insertStep,
  isLoosened,
  locate,
  moveStep,
  type Process,
  ROOT,
  readProcessBundle,
  redo,
  removeStep,
  removeTrigger,
  type Step,
  setTrigger,
  startHistory,
  toolTitle,
  undo,
  updateStep,
  workflowCounts,
} from "./model";

const UPDATE: ToolSpec = {
  id: "testkit.record.update",
  description: "Update a record",
  input: { type: "object", properties: { id: { type: "string" } } },
  output: { type: "object" },
  sideEffect: "external",
  verb: "update",
  source: "testkit",
  connector: "testkit",
};
const QUERY: ToolSpec = {
  id: "testkit.record.query",
  description: "Read records",
  input: { type: "object" },
  output: { type: "object" },
  sideEffect: "none",
  verb: "read",
  source: "testkit",
  connector: "testkit",
};
/** A tool-mode skill that only wraps the query: it reads as a read step. */
const WRAPPER = {
  schemaVersion: 1,
  id: "testkit.query",
  name: "Query records",
  description: "",
  category: "testkit",
  mode: "tool",
  handler: QUERY.id,
  tools: [],
  input: { type: "object" },
  output: { type: "object" },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
} as unknown as SkillDefinition;
const CTX: TypingContext = {
  tools: { [UPDATE.id]: UPDATE, [QUERY.id]: QUERY },
  skills: { [WRAPPER.id]: WRAPPER },
};

const INPUT: AgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Clerk", role: "Records", mission: "Keep records right" },
    kind: "functional",
    model: { id: "m" },
    instructions: "Work carefully.",
    skills: [],
    extraTools: ["testkit.record.update"],
    permissions: { mode: "act" },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 3,
        trigger: { id: "t1", on: { type: "manual", input: {} } },
        steps: [
          { id: "a", kind: "wait", name: "A", for: "1 day" },
          {
            id: "f",
            kind: "fork",
            name: "Fork",
            paths: [
              {
                id: "p1",
                name: "Big",
                when: { rules: [{ field: "{{trigger.total}}", op: ">", value: 5 }] },
                steps: [{ id: "b", kind: "wait", name: "B", for: "1 day" }],
              },
              { id: "p2", name: "Small", when: { rules: [] }, steps: [] },
            ],
            otherwise: { id: "o", steps: [] },
          },
          {
            id: "loop",
            kind: "for_each",
            name: "Each",
            over: "{{trigger.items}}",
            steps: [{ id: "c", kind: "wait", name: "C", for: "1 day" }],
          },
          {
            id: "u",
            kind: "action",
            name: "Update",
            tool: "testkit.record.update",
            input: { id: "1" },
          },
        ],
      },
    },
  ],
};
const STORED = AgentBundle.parse(INPUT);
const BUNDLE: ProcessAgentBundle = readProcessBundle(STORED, CTX);
const WF = BUNDLE.workflows[0]?.workflow as Process;

const ids = (steps: Step[] | null) => (steps ?? []).map((s) => s.id);

describe("builder model", () => {
  it("reads a stored v3 workflow as a v4 process, keeping every id; v4 stays as it is", () => {
    const v3 = STORED.workflows[0]?.workflow;
    if (!v3) throw new Error("no workflow");
    expect(holdsV3(STORED)).toBe(true);
    expect(WF.schemaVersion).toBe(4);
    expect(processes.nodeIds(WF)).toEqual(nodeIds(v3));
    expect(locate(WF, "f")?.step.kind).toBe("if");
    // v3's action is a write with its approval as a check (on, as invariant 8 keeps it).
    expect(locate(WF, "u")?.step).toMatchObject({
      kind: "write",
      checks: { approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop" } },
    });
    // A v4 bundle reads back unchanged, and nothing in it is v3.
    expect(readProcessBundle(BUNDLE, CTX)).toEqual(BUNDLE);
    expect(holdsV3(BUNDLE)).toBe(false);
    // A skill that only wraps a read tool becomes a read step on that tool.
    const wrapped = readProcessBundle(
      AgentBundle.parse({
        ...INPUT,
        workflows: [
          {
            slug: "main",
            name: "Main",
            workflow: {
              schemaVersion: 3,
              trigger: { id: "t1", on: { type: "manual", input: {} } },
              steps: [{ id: "q", kind: "skill", name: "Query", skill: "testkit.query" }],
            },
          },
        ],
      }),
      CTX,
    );
    expect(wrapped.workflows[0]?.workflow.steps[0]).toMatchObject({
      id: "q",
      kind: "read",
      tool: QUERY.id,
    });
  });

  it("keeps every id through edits, and the process exactly as it was when they are undone", () => {
    const h = startHistory(BUNDLE);
    expect(canonicalJson(h.present)).toBe(canonicalJson(BUNDLE));

    // A rename, a move into a path and out again, and an undo of nothing else: every node id stays.
    let w = updateStep(WF, "a", (s) => ({ ...s, name: "A renamed" }));
    w = moveStep(w, "u", "path:p2", 0);
    w = moveStep(w, "u", ROOT, 3);
    expect(processes.nodeIds(w).sort()).toEqual(processes.nodeIds(WF).sort());
    const back = updateStep(w, "a", (s) => ({ ...s, name: "A" }));
    expect(canonicalJson(back)).toBe(canonicalJson(WF));
  });

  it("inserts, removes and reorders within a list as arrayMove does", () => {
    const step: Step = { id: "n", kind: "stop", name: "Stop", status: "succeeded" };
    expect(ids(insertStep(WF, ROOT, 1, step).steps)).toEqual(["a", "n", "f", "loop", "u"]);
    expect(ids(removeStep(WF, "loop").steps)).toEqual(["a", "f", "u"]);
    expect(ids(moveStep(WF, "a", ROOT, 2).steps)).toEqual(["f", "loop", "a", "u"]);
    expect(ids(moveStep(WF, "u", ROOT, 0).steps)).toEqual(["u", "a", "f", "loop"]);
  });

  it("moves steps into and out of if paths, otherwise and loops", () => {
    const into = moveStep(WF, "a", "path:p2", 0);
    expect(ids(into.steps)).toEqual(["f", "loop", "u"]);
    expect(ids(getContainer(into, "path:p2"))).toEqual(["a"]);
    expect(locate(into, "a")).toMatchObject({ container: "path:p2", index: 0 });

    const out = moveStep(into, "b", ROOT, 0);
    expect(ids(out.steps)).toEqual(["b", "f", "loop", "u"]);
    expect(ids(getContainer(out, "path:p1"))).toEqual([]);

    const looped = moveStep(WF, "u", "loop:loop", 1);
    expect(ids(getContainer(looped, "loop:loop"))).toEqual(["c", "u"]);
    const otherwise = moveStep(WF, "c", "otherwise:o", 0);
    expect(ids(getContainer(otherwise, "otherwise:o"))).toEqual(["c"]);
  });

  it("never moves an if or loop into itself", () => {
    expect(moveStep(WF, "f", "path:p1", 0)).toBe(WF);
    expect(moveStep(WF, "loop", "loop:loop", 0)).toBe(WF);
  });

  it("makes new steps with fresh ids once, approval on for writes, and allows what they need", () => {
    let n = 0;
    const newId = () => `id-${++n}`;
    const write = createStep(
      { type: "write", key: "x", title: "Update record", detail: "", tool: UPDATE, group: "" },
      CTX,
      newId,
    );
    expect(write).toMatchObject({
      id: "id-1",
      kind: "write",
      tool: UPDATE.id,
      checks: { approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop" } },
    });
    const read = createStep(
      { type: "read", key: "r", title: "Read records", detail: "", tool: QUERY, group: "" },
      CTX,
      newId,
    );
    expect(read).toEqual({
      id: "id-2",
      kind: "read",
      name: "Read records",
      tool: QUERY.id,
      input: {},
    });
    const ifStep = createStep(
      { type: "logic", key: "f", title: "If", detail: "", logic: "if" },
      CTX,
      newId,
    );
    expect(ifStep).toMatchObject({
      id: "id-3",
      kind: "if",
      paths: [{ id: "id-4" }],
      otherwise: { id: "id-5" },
    });
    // Every new step validates as a v4 step.
    for (const s of [write, read, ifStep]) expect(processes.Step.safeParse(s).success).toBe(true);

    const noTools = { ...BUNDLE, definition: { ...BUNDLE.definition, extraTools: [] } };
    expect(allowStep(noTools, write, CTX).definition.extraTools).toEqual([UPDATE.id]);
    expect(allowStep(BUNDLE, read, CTX).definition.extraTools).toEqual([UPDATE.id, QUERY.id]);
    const skill: Step = { id: "s", kind: "skill", name: "S", skill: "docs.extract", input: {} };
    expect(allowStep(BUNDLE, skill, CTX).definition.skills).toEqual([
      { skill: "docs.extract", settings: {} },
    ]);
    expect(toolTitle(UPDATE)).toBe("Update a record");
  });

  // R7: conversations are their own step kind (ARCHITECTURE §10.14).
  it("starts a conversation step with its first message signed, one field and a deadline", () => {
    const step = createStep(
      { type: "conversation", key: "conversation", title: "Talk with a person", detail: "" },
      CTX,
      () => "c1",
    );
    expect(step).toMatchObject({
      id: "c1",
      kind: "conversation",
      channel: "whatsapp",
      find: { answer: "text" },
      messages: { first: "required", later: "required" },
      deadline: { after: "3 days", hours: "clock", ifNoAnswer: "stop" },
    });
    expect(processes.Step.safeParse(step).success).toBe(true);
    // A person step waits three days, then stops and tells the operator, as v3's default did.
    const person = createStep(
      { type: "person", key: "p", title: "Ask", detail: "", mode: "ask" },
      CTX,
      () => "p1",
    );
    expect(person).toMatchObject({
      deadline: { after: "3 days", ifNoAnswer: "stop", tell: ["operator"] },
    });
  });

  it("keeps a trigger's id when what starts the process changes; adds triggers and workflows", () => {
    const w = setTrigger(WF, { type: "schedule", cron: "0 7 * * 1-5" });
    expect(w.triggers).toEqual([{ id: "t1", on: { type: "schedule", cron: "0 7 * * 1-5" } }]);
    const two = addTrigger(w, { type: "command", command: "go" }, () => "t9");
    expect(two.triggers.map((t) => t.id)).toEqual(["t1", "t9"]);
    expect(setTrigger(two, { type: "command", command: "now" }, "t9").triggers[1]?.on).toEqual({
      type: "command",
      command: "now",
    });
    expect(removeTrigger(two, "t1").triggers.map((t) => t.id)).toEqual(["t9"]);
    // The last trigger stays: a process starts somehow.
    expect(removeTrigger(w, "t1")).toBe(w);
    const b = addWorkflow(
      BUNDLE,
      { slug: "weekly", name: "Weekly", on: { type: "command", command: "go" } },
      () => "t2",
    );
    expect(b.workflows.map((x) => x.slug)).toEqual(["main", "weekly"]);
    expect(b.workflows[1]?.workflow).toEqual({
      schemaVersion: 4,
      triggers: [{ id: "t2", on: { type: "command", command: "go" } }],
      steps: [],
    });
  });

  describe("approval", () => {
    const env = (over: Partial<ApprovalEnv> = {}): ApprovalEnv => ({
      ctx: CTX,
      agentKind: "client",
      mode: "act",
      matrices: { testkit: { read: "auto", update: "auto" } },
      connectorName: () => "Testkit",
      ...over,
    });
    const update = locate(WF, "u")?.step as Extract<Step, { kind: "write" }>;
    const approval = update.checks?.approval;
    if (!approval) throw new Error("no approval");
    const off: Step = {
      ...update,
      checks: { approval: { ...approval, required: "not_required" } },
    };

    it("offers run without approval where the connection allows auto and the agent acts", () => {
      expect(approvalOption(update, env())).toMatchObject({
        canSkip: true,
        reason: null,
        required: true,
        automatic: false,
      });
      expect(approvalOption(off, env())).toMatchObject({ automatic: true });
      // A write with no approval check waits for the default approver.
      const { checks: _c, ...bare } = update;
      expect(approvalOption(bare, env())).toMatchObject({ required: true, automatic: false });
    });

    it("refuses it on templates, without a binding, below auto, and in suggest-only mode", () => {
      expect(approvalOption(update, env({ agentKind: "template" }))?.reason).toMatch(
        /Templates keep approval on/,
      );
      expect(approvalOption(update, env({ matrices: {} }))?.reason).toMatch(
        /Bind a Testkit connection first/,
      );
      expect(
        approvalOption(update, env({ matrices: { testkit: { update: "approval" } } }))?.reason,
      ).toBe("The Testkit connection requires approval for updates.");
      expect(
        approvalOption(update, env({ matrices: { testkit: { update: "off" } } }))?.reason,
      ).toBe("The Testkit connection doesn't allow updates.");
      expect(approvalOption(update, env({ mode: "suggest_only" }))?.reason).toMatch(/suggest only/);
      // A step already set to skip approval where it may not still waits.
      expect(approvalOption(off, env({ mode: "suggest_only" }))).toMatchObject({
        canSkip: false,
        automatic: false,
      });
    });

    it("counts going ahead with no answer and some runs only as loosening", () => {
      expect(isLoosened(approval)).toBe(false);
      expect(isLoosened({ ...approval, ifNoAnswer: "proceed" })).toBe(true);
      expect(isLoosened({ ...approval, when: { match: "all", rules: [] } })).toBe(true);
      expect(
        isLoosened({
          ...approval,
          approvers: [
            { who: "lead", deadline: { after: "1 day", hours: "clock", ifNoAnswer: "proceed" } },
          ],
        }),
      ).toBe(true);
    });

    it("has no approval for steps that change no client tool, and counts the ones that wait", () => {
      expect(approvalOption(locate(WF, "a")?.step as Step, env())).toBeNull();
      expect(workflowCounts(WF, env())).toEqual({ steps: 6, ifs: 1, writes: 1, needApproval: 1 });
      const auto = updateStep(WF, "u", () => off);
      expect(workflowCounts(auto, env()).needApproval).toBe(0);
    });
  });

  it("marks a client agent's steps added or changed against the template", () => {
    let w = updateStep(WF, "a", (s) => ({ ...s, name: "Renamed" }));
    w = insertStep(w, ROOT, 0, { id: "new", kind: "stop", name: "Stop", status: "succeeded" });
    // A nested change is the nested step's own, not its if's.
    w = updateStep(w, "b", (s) => ({ ...s, name: "B2" }));
    expect(Object.fromEntries(customizedSteps(w, WF))).toEqual({
      a: "changed",
      new: "added",
      b: "changed",
    });
    expect(customizedSteps(WF, WF).size).toBe(0);
  });

  it("undoes and redoes, and groups typing in one field into one step", () => {
    const rename = (b: ProcessAgentBundle, name: string) =>
      editWorkflow(b, "main", (w) => updateStep(w, "a", (s) => ({ ...s, name })));
    let h = startHistory(BUNDLE);
    h = commit(h, rename(h.present, "A1"), "a:name", 1000);
    h = commit(h, rename(h.present, "A12"), "a:name", 1500);
    h = commit(
      h,
      editWorkflow(h.present, "main", (w) => removeStep(w, "u")),
      null,
      1600,
    );
    expect(h.past).toHaveLength(2);
    h = undo(h);
    expect(locate(h.present.workflows[0]?.workflow as Process, "u")).not.toBeNull();
    h = undo(h);
    expect(h.present).toBe(BUNDLE);
    h = redo(redo(h));
    expect(locate(h.present.workflows[0]?.workflow as Process, "u")).toBeNull();
    expect(locate(h.present.workflows[0]?.workflow as Process, "a")?.step.name).toBe("A12");
    // A new edit drops what could be redone.
    h = commit(undo(h), rename(h.present, "x"));
    expect(h.future).toEqual([]);
  });
});
