// The builder's model: edits that keep every id, moves into and out of fork paths and loops, the
// approval control's rules, customizations against the template, and undo/redo.
import {
  AgentBundle,
  type AgentBundleInput,
  canonicalJson,
  nodeIds,
  type Step,
  type ToolSpec,
  type TypingContext,
  type Workflow,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  type ApprovalEnv,
  addWorkflow,
  allowStep,
  approvalOption,
  commit,
  createStep,
  customizedSteps,
  editWorkflow,
  getContainer,
  insertStep,
  locate,
  moveStep,
  ROOT,
  redo,
  removeStep,
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
const CTX: TypingContext = { tools: { [UPDATE.id]: UPDATE } };

const INPUT: AgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Clerk", role: "Records", mission: "Keep records right" },
    kind: "functional",
    model: { id: "claude-opus-5-5" },
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
const BUNDLE = AgentBundle.parse(INPUT);
const WF = BUNDLE.workflows[0]?.workflow as Workflow;

const ids = (steps: Step[] | null) => (steps ?? []).map((s) => s.id);

describe("builder model", () => {
  it("keeps a bundle exactly as it was when nothing is edited, and every id through edits", () => {
    const h = startHistory(BUNDLE);
    expect(canonicalJson(h.present)).toBe(canonicalJson(BUNDLE));

    // A rename, a move into a path and out again, and an undo of nothing else: every node id stays.
    let w = updateStep(WF, "a", (s) => ({ ...s, name: "A renamed" }));
    w = moveStep(w, "u", "path:p2", 0);
    w = moveStep(w, "u", ROOT, 3);
    expect(nodeIds(w).sort()).toEqual(nodeIds(WF).sort());
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

  it("moves steps into and out of fork paths, otherwise and loops", () => {
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

  it("never moves a fork or loop into itself", () => {
    expect(moveStep(WF, "f", "path:p1", 0)).toBe(WF);
    expect(moveStep(WF, "loop", "loop:loop", 0)).toBe(WF);
  });

  it("makes new steps with fresh ids once, approval on for writes, and allows what they need", () => {
    let n = 0;
    const newId = () => `id-${++n}`;
    const action = createStep(
      { type: "action", key: "x", title: "Update record", detail: "", tool: UPDATE, group: "" },
      CTX,
      newId,
    );
    expect(action).toMatchObject({
      id: "id-1",
      kind: "action",
      tool: UPDATE.id,
      approval: { required: "required" },
    });
    const fork = createStep(
      { type: "logic", key: "f", title: "Fork", detail: "", logic: "fork" },
      CTX,
      newId,
    );
    expect(fork).toMatchObject({ id: "id-2", paths: [{ id: "id-3" }], otherwise: { id: "id-4" } });

    const noTools = { ...BUNDLE, definition: { ...BUNDLE.definition, extraTools: [] } };
    expect(allowStep(noTools, action, CTX).definition.extraTools).toEqual([UPDATE.id]);
    const skill: Step = { id: "s", kind: "skill", name: "S", skill: "docs.extract", input: {} };
    expect(allowStep(BUNDLE, skill, CTX).definition.skills).toEqual([
      { skill: "docs.extract", settings: {} },
    ]);
    expect(toolTitle(UPDATE)).toBe("Update a record");
  });

  it("keeps the trigger's id when what starts the workflow changes; adds workflows", () => {
    const w = setTrigger(WF, { type: "schedule", cron: "0 7 * * 1-5" });
    expect(w.trigger).toEqual({ id: "t1", on: { type: "schedule", cron: "0 7 * * 1-5" } });
    const b = addWorkflow(
      BUNDLE,
      { slug: "weekly", name: "Weekly", on: { type: "command", command: "go" } },
      () => "t2",
    );
    expect(b.workflows.map((x) => x.slug)).toEqual(["main", "weekly"]);
    expect(b.workflows[1]?.workflow.trigger.id).toBe("t2");
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
    const update = locate(WF, "u")?.step as Step;
    const off = {
      ...update,
      approval: { required: "not_required" as const, onReject: "stop" as const },
    };

    it("offers run without approval where the connection allows auto and the agent acts", () => {
      expect(approvalOption(update, env())).toMatchObject({
        canSkip: true,
        reason: null,
        required: true,
        automatic: false,
      });
      expect(approvalOption(off, env())).toMatchObject({ automatic: true });
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

    it("has no approval for steps that change no client tool, and counts the ones that wait", () => {
      expect(approvalOption(locate(WF, "a")?.step as Step, env())).toBeNull();
      expect(workflowCounts(WF, env())).toEqual({ steps: 6, forks: 1, writes: 1, needApproval: 1 });
      const auto = updateStep(WF, "u", () => off);
      expect(workflowCounts(auto, env()).needApproval).toBe(0);
    });
  });

  it("marks a client agent's steps added or changed against the template", () => {
    let w = updateStep(WF, "a", (s) => ({ ...s, name: "Renamed" }));
    w = insertStep(w, ROOT, 0, { id: "new", kind: "stop", name: "Stop", status: "succeeded" });
    // A nested change is the nested step's own, not its fork's.
    w = updateStep(w, "b", (s) => ({ ...s, name: "B2" }));
    expect(Object.fromEntries(customizedSteps(w, WF))).toEqual({
      a: "changed",
      new: "added",
      b: "changed",
    });
    expect(customizedSteps(WF, WF).size).toBe(0);
  });

  it("undoes and redoes, and groups typing in one field into one step", () => {
    const rename = (b: AgentBundle, name: string) =>
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
    expect(locate(h.present.workflows[0]?.workflow as Workflow, "u")).not.toBeNull();
    h = undo(h);
    expect(h.present).toBe(BUNDLE);
    h = redo(redo(h));
    expect(locate(h.present.workflows[0]?.workflow as Workflow, "u")).toBeNull();
    expect(locate(h.present.workflows[0]?.workflow as Workflow, "a")?.step.name).toBe("A12");
    // A new edit drops what could be redone.
    h = commit(undo(h), rename(h.present, "x"));
    expect(h.future).toEqual([]);
  });
});
