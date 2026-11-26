// Check the steps in the step model (stream Q): typed lines are "Not built yet" Do steps, matching
// one makes it a Do with that Uses (approval on for a Change or a Send), decisions are Forks whose
// paths end on Ends, the cards declare outputs the main End delivers, and the checks are core's.
import { steps } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { usesContextFrom } from "../builder/steps/catalog";
import { workflowIssues } from "../builder/steps/issues";
import type { DoStep, Workflow } from "../builder/steps/types";
import { draftWorkflow5, stepsCatalog } from "./checkFixtures";
import { fillRequest } from "./checkModel";
import {
  addDecision,
  addEnding,
  addLine,
  blankWorkflow,
  countLines,
  endingOf,
  endsOf,
  endWords,
  findLine,
  finishLines,
  handAdded,
  isHandLine,
  lineToDecision,
  listWords,
  mainEnd,
  matchLine,
  moveLine,
  movePathBelow,
  readWorkflow,
  removeEnding,
  removeLine,
  renameLine,
  setAfterPaths,
  setPathEnd,
  toggleEndOutput,
} from "./checkModel5";

function ids() {
  let n = 0;
  return () => `n-${++n}`;
}

const ROUTES = stepsCatalog();
const ctx = usesContextFrom({
  actions: (Object.values(ROUTES)[0] as () => { groups: never })().groups,
  catalog: (Object.values(ROUTES)[1] as () => never)(),
});

const draft = (): Workflow => readWorkflow(draftWorkflow5()) as Workflow;
const codes = (w: Workflow) => workflowIssues(w, ctx).map((i) => i.code);

describe("Check the steps in the step model", () => {
  it("starts a list with nothing in it as every new workflow does: a trigger, its End, nothing to do", () => {
    const w = blankWorkflow(ids());
    expect(w).toEqual({
      schemaVersion: 5,
      triggers: [{ id: "n-1", on: { type: "manual", input: { type: "object", properties: {} } } }],
      outputs: [{ id: "n-2", name: "Nothing to do", kind: "nothing", fields: [] }],
      steps: [{ id: "n-3", kind: "end", name: "End", outputs: ["n-2"], status: "succeeded" }],
    });
    expect(steps.validateWorkflow(w)).toEqual([]);
  });

  it("keeps a typed line as a Do that is not built yet, before the End, and its need follows its words", () => {
    const newId = ids();
    const out = addLine(blankWorkflow(newId), "root", 99, "  Read  the invoice ", newId);
    expect(out.workflow.steps.map((s) => s.kind)).toEqual(["do", "end"]);
    const line = findLine(out.workflow, out.stepId);
    expect(line).toEqual({
      id: "n-4",
      kind: "do",
      name: "Read the invoice",
      input: {},
      uses: { type: "missing", need: "Read the invoice" },
    });
    expect(line && isHandLine(line)).toBe(true);
    // Core's validator says it plainly.
    expect(workflowIssues(out.workflow, ctx)).toEqual([
      { at: "n-4", code: "not_built_yet", message: "Not built yet: Read the invoice" },
    ]);
    const renamed = renameLine(out.workflow, "n-4", "Read each invoice");
    expect(findLine(renamed, "n-4")).toMatchObject({
      name: "Read each invoice",
      uses: { type: "missing", need: "Read each invoice" },
    });
    // The End the builder keeps can't be taken out; the line can.
    const end = mainEnd(renamed);
    expect(removeLine(renamed, end?.id ?? "")).toBe(renamed);
    expect(removeLine(renamed, "n-4").steps.map((s) => s.kind)).toEqual(["end"]);
  });

  it("reads a stored workflow with its defaults, and gives a main line with no End its End", () => {
    expect(draft().steps.at(-1)).toMatchObject({ id: "s-end", kind: "end" });
    const noEnd = { ...draftWorkflow5(), steps: draftWorkflow5().steps.slice(0, -1) };
    const read = readWorkflow(noEnd, () => "e-1");
    expect(read?.steps.at(-1)).toMatchObject({ id: "e-1", kind: "end", outputs: [] });
    expect(readWorkflow({ schemaVersion: 4, triggers: [], steps: [] })).toBeNull();
  });

  it("matches a line to an action, a skill or an automation, keeping its id and name", () => {
    const newId = ids();
    const { workflow, stepId } = addLine(draft(), "root", 3, "Create the bill again", newId);
    // A Change starts with its approver on (invariant 8).
    const change = matchLine(
      workflow,
      stepId,
      { doneBy: "rules", uses: { type: "action", action: "qbo.bill.create" } },
      ctx,
    );
    expect(findLine(change, stepId)).toEqual({
      id: stepId,
      kind: "do",
      name: "Create the bill again",
      input: {},
      doneBy: "rules",
      uses: { type: "action", action: "qbo.bill.create" },
      checks: {
        approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
      },
    });
    // So does a Send: it goes out through the gate too.
    const send = matchLine(
      workflow,
      stepId,
      { doneBy: "rules", uses: { type: "action", action: "email.send" } },
      ctx,
    );
    expect((findLine(send, stepId) as DoStep).checks?.approval?.required).toBe("required");
    // A Get reads: no approver.
    const get = matchLine(
      workflow,
      stepId,
      { doneBy: "rules", uses: { type: "action", action: "qbo.vendor.find" } },
      ctx,
    );
    expect((findLine(get, stepId) as DoStep).checks).toBeUndefined();
    // A skill; an automation says who does each of its own steps.
    const skill = matchLine(
      workflow,
      stepId,
      { doneBy: "ai", uses: { type: "skill", skill: "docs.read-document" } },
      ctx,
    );
    expect(findLine(skill, stepId)).toMatchObject({ doneBy: "ai", uses: { type: "skill" } });
    const auto = matchLine(
      workflow,
      stepId,
      { doneBy: "rules", uses: { type: "automation", automation: "a.b" } },
      ctx,
    );
    expect((findLine(auto, stepId) as DoStep).doneBy).toBeUndefined();
    // A person with nothing to use: written in the step, which the checks ask to fill in.
    const person = matchLine(workflow, stepId, { doneBy: "person", uses: undefined }, ctx);
    expect(findLine(person, stepId)).toMatchObject({ doneBy: "person" });
    expect(codes(person)).toContain("instructions_missing");
    expect(codes(change)).not.toContain("not_built_yet");
  });

  it("turns a typed If line into a Fork in its place, its path ending on an End that asks what it delivers", () => {
    const newId = ids();
    const { workflow, stepId } = addLine(
      blankWorkflow(newId),
      "root",
      0,
      "If over $5,000, ask Dana and stop",
      newId,
    );
    const turned = lineToDecision(workflow, stepId, newId);
    const fork = findLine(turned, stepId);
    expect(fork).toMatchObject({
      id: stepId,
      kind: "fork",
      name: "If over $5,000",
      paths: [
        {
          name: "over $5,000",
          steps: [
            { kind: "do", name: "ask Dana", uses: { type: "missing", need: "ask Dana" } },
            { kind: "end", outputs: [] },
          ],
        },
      ],
      otherwise: { steps: [] },
    });
    expect(codes(turned)).toEqual(["not_built_yet", "end_empty"]);
    // A drafted step renamed "If …" stays as it is.
    expect(lineToDecision(draft(), "s-read")).toEqual(draft());
  });

  it("ends a path on an End and lets it rejoin; the main line keeps its End", () => {
    const newId = ids();
    const w = draft();
    const ended = setPathEnd(w, "path:p-dup", "stop", newId);
    const fork = findLine(ended, "s-dup");
    expect(fork?.kind === "fork" && fork.paths[0]?.steps.map((s) => s.kind)).toEqual(["do", "end"]);
    expect(setPathEnd(ended, "path:p-dup", "on", newId)).toEqual(w);
    // Every path ends: the steps after the Fork never run, and the main End stays.
    const apart = setAfterPaths(w, "s-dup", "apart", newId);
    expect(endsOf(apart).map((e) => e.where)).toEqual([
      "If the invoice is a duplicate",
      "Otherwise",
      "the main line",
    ]);
    expect(setAfterPaths(apart, "s-dup", "together", newId)).toEqual(w);
    // Picking what a path's End delivers settles it.
    const pathEnd = endsOf(ended)[0]?.end;
    expect(codes(ended)).toContain("end_empty");
    const picked = toggleEndOutput(ended, pathEnd?.id ?? "", "o-bill");
    expect(codes(picked)).not.toContain("end_empty");
    expect(endWords(endsOf(picked)[0] as never)).toBe(
      "Ends on If the invoice is a duplicate: The bill in QuickBooks",
    );
  });

  it("moves a path's steps below the decision, and a line by drag as arrayMove does", () => {
    const newId = ids();
    const onOtherwise = addLine(draft(), "otherwise:o-dup", 0, "Match the lines", newId);
    const below = movePathBelow(onOtherwise.workflow, "s-dup", "otherwise:o-dup");
    expect(below.steps.map((s) => s.id)).toEqual(["s-read", "s-dup", "n-1", "s-bill", "s-end"]);
    expect(moveLine(below, "s-read", 2).steps.map((s) => s.id)).toEqual([
      "s-dup",
      "n-1",
      "s-read",
      "s-bill",
      "s-end",
    ]);
    expect(moveLine(below, "s-bill", 0).steps.map((s) => s.id)).toEqual([
      "s-bill",
      "s-read",
      "s-dup",
      "n-1",
      "s-end",
    ]);
  });

  it("says how it ends from its outputs, and a card declares one the main End delivers", () => {
    expect(endingOf(draft()).kinds).toEqual(["write", "notify"]);
    const newId = ids();
    const blank = blankWorkflow(newId);
    expect(endingOf(blank).kinds).toEqual([]);
    // "It tells someone": the starter "Nothing to do" gives way to a report the End delivers.
    const told = addEnding(blank, "notify", newId);
    expect(told.workflow.outputs).toEqual([
      {
        id: "n-4",
        name: "Tell the client's team what was done",
        kind: "report",
        fields: [],
        report: { to: [], channel: "inbox", message: "" },
      },
    ]);
    expect(mainEnd(told.workflow)?.outputs).toEqual(["n-4"]);
    expect(endingOf(told.workflow).kinds).toEqual(["notify"]);
    // The report isn't set up yet: core says what it needs.
    expect(workflowIssues(told.workflow, ctx)).toEqual([
      { at: "n-4", code: "output_incomplete", message: "Say who gets this report." },
    ]);
    // A second card adds beside it; a person finishing it is a line before the End.
    const wrote = addEnding(told.workflow, "write", newId);
    expect(wrote.workflow.outputs.map((o) => o.kind)).toEqual(["report", "write"]);
    expect(mainEnd(wrote.workflow)?.outputs).toEqual(["n-4", "n-5"]);
    const person = addEnding(wrote.workflow, "person", newId);
    expect(person.workflow.steps.map((s) => s.kind)).toEqual(["do", "end"]);
    expect(endingOf(person.workflow, { [person.stepId ?? ""]: "person" }).kinds).toEqual([
      "write",
      "notify",
      "person",
    ]);
    // Feedback, 2026-11-26: a card that is on can be taken back.
    const unperson = removeEnding(person.workflow, "person", { [person.stepId ?? ""]: "person" });
    expect(unperson.steps.map((s) => s.kind)).toEqual(["end"]);
    const unwrote = removeEnding(unperson, "write");
    expect(unwrote.outputs.map((o) => o.kind)).toEqual(["report"]);
    expect(mainEnd(unwrote)?.outputs).toEqual(["n-4"]);
    // The last one taken back leaves the "Nothing to do" a new workflow starts with.
    const none = removeEnding(unwrote, "notify", {}, newId);
    expect(none.outputs.map((o) => [o.kind, o.name])).toEqual([["nothing", "Nothing to do"]]);
    expect(mainEnd(none)?.outputs).toEqual([none.outputs[0]?.id]);
    expect(endingOf(none).kinds).toEqual([]);
  });

  it("drops blank lines, counts lines and decisions, and asks the Builder about what was typed", () => {
    const newId = ids();
    const before = draft();
    let w = addLine(before, "root", 3, "Code each line to a job", newId).workflow;
    w = addLine(w, "root", 4, "", newId).workflow;
    w = addDecision(w, "root", 1, "the total is over $5,000", newId).workflow;
    const done = finishLines(w);
    expect(done.steps.map((s) => s.kind)).toEqual(["do", "fork", "fork", "do", "do", "end"]);
    expect(countLines(done)).toEqual({ steps: 3, decisions: 2 });
    const added = handAdded(before, done);
    expect(added.lines.map((l) => l.need)).toEqual(["Code each line to a job"]);
    const text = fillRequest({ workflowName: "Invoice intake", added, starts: null });
    expect(text).toContain('"Code each line to a job"');
    expect(text).toContain('if "the total is over $5,000"');
  });

  it("says the list in words for a build with no draft, with what it delivers", () => {
    const newId = ids();
    let w = blankWorkflow(newId);
    w = addLine(w, "root", 0, "Read the invoice", newId).workflow;
    const d = addLine(w, "root", 1, "If it is a duplicate, tell Dana and stop", newId);
    w = lineToDecision(d.workflow, d.stepId, newId);
    w = addEnding(w, "write", newId).workflow;
    expect(listWords(w, "When an invoice arrives")).toBe(
      "It starts: When an invoice arrives. 1. Read the invoice. 2. If it is a duplicate: tell Dana, then it ends. It delivers: Save the result.",
    );
  });
});
