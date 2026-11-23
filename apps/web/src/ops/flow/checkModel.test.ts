// Check the steps' edits (docs/builder-plan.md §12.5 F5): rename, a line added by hand as a
// missing step, reorder, a decision with paths, ends here and rejoins, and every id kept.
import { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { locate, type Process, ROOT, type Step } from "../builder/model";
import {
  addDecision,
  addLine,
  addPath,
  afterPaths,
  blankProcess,
  countLines,
  fillRequest,
  finishLines,
  handAdded,
  lineToDecision,
  listWords,
  moveLine,
  movePathBelow,
  otherwiseContainer,
  pathContainer,
  pathEnds,
  readIf,
  removeLine,
  removePath,
  renameLine,
  setAfterPaths,
  setCondition,
  setPathEnd,
  setStart,
  startKindOf,
} from "./checkModel";

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

const draft = (): Process => ({
  schemaVersion: 4,
  triggers: [{ id: "t0", on: { type: "event", event: "document.received" } }],
  steps: [
    { id: "read", kind: "skill", name: "Read the invoice", skill: "docs.extract", input: {} },
    {
      id: "dup",
      kind: "if",
      name: "Duplicate",
      paths: [
        {
          id: "p1",
          name: "the invoice is a duplicate",
          when: { match: "all", rules: [] },
          steps: [
            {
              id: "tell",
              kind: "notify",
              name: "Tell Dana",
              notify: { to: ["client_admin"], channel: "inbox", message: "" },
            },
          ],
        },
      ],
      otherwise: { id: "o1", steps: [] },
    },
    { id: "bill", kind: "write", name: "Create the bill", tool: "qbo.bill.create", input: {} },
  ],
});

const allIds = (p: Process) => {
  const out: string[] = [];
  processes.walkSteps(p, ({ step }) => out.push(step.id));
  return out;
};

const ifAt = (p: Process, id: string) => {
  const s = locate(p, id)?.step;
  if (s?.kind !== "if") throw new Error("not an if");
  return s;
};

describe("Check the steps' edits", () => {
  it("renames a line and keeps every id", () => {
    const before = draft();
    const p = renameLine(before, "read", "Read each invoice");
    expect(locate(p, "read")?.step.name).toBe("Read each invoice");
    expect(allIds(p)).toEqual(allIds(before));
    expect(p.triggers).toEqual(before.triggers);
  });

  it("adds a line typed by hand as a missing step whose need is its words", () => {
    const { process: p, stepId } = addLine(draft(), ROOT, 1, "Code each line to a job", ids());
    expect(stepId).toBe("id-1");
    expect(p.steps[1]).toEqual({
      id: "id-1",
      kind: "missing",
      name: "Code each line to a job",
      need: "Code each line to a job",
    });
    // Renaming it changes its need too; the id stays.
    const renamed = renameLine(p, "id-1", "Code each line  to a project");
    expect(locate(renamed, "id-1")?.step).toMatchObject({
      name: "Code each line  to a project",
      need: "Code each line to a project",
    });
    // A blank line is dropped on Build it; a line with words stays.
    const blank = addLine(renamed, ROOT, 0, "", () => "blank").process;
    const done = finishLines(blank);
    expect(done.steps.map((s) => s.id)).toEqual(["read", "id-1", "dup", "bill"]);
    // Removing a line removes only it.
    expect(removeLine(done, "id-1").steps.map((s) => s.id)).toEqual(["read", "dup", "bill"]);
  });

  it("reorders top-level lines", () => {
    const p = moveLine(draft(), "bill", 0);
    expect(p.steps.map((s) => s.id)).toEqual(["bill", "read", "dup"]);
    expect(moveLine(p, "bill", 2).steps.map((s) => s.id)).toEqual(["read", "dup", "bill"]);
  });

  it("turns a line typed with If into a decision in its place, keeping the line's id", () => {
    const newId = ids();
    const added = addLine(draft(), ROOT, 1, "If the price went up, tell Dana and stop", newId);
    const p = lineToDecision(added.process, added.stepId, newId);
    const d = ifAt(p, added.stepId);
    expect(d.paths).toHaveLength(1);
    expect(d.paths[0]?.name).toBe("the price went up");
    expect(d.name).toBe("If the price went up");
    expect(d.paths[0]?.steps.map((s) => [s.kind, s.name])).toEqual([
      ["missing", "tell Dana"],
      ["stop", "Stop here"],
    ]);
    expect(pathEnds(d.paths[0]?.steps ?? [])).toBe(true);
    expect(d.otherwise.steps).toEqual([]);
    // A drafted step renamed "If …" stays the step it is.
    const renamed = renameLine(p, "read", "If it is a PDF");
    expect(lineToDecision(renamed, "read", newId)).toBe(renamed);
    // A line without "If" is left as it is.
    const plain = addLine(p, ROOT, 0, "Save it", newId);
    expect(lineToDecision(plain.process, plain.stepId, newId)).toBe(plain.process);
  });

  it("reads If lines: condition, the path's step and its end", () => {
    expect(readIf("If a line doesn't match, ask Dana")).toEqual({
      condition: "a line doesn't match",
      onPath: "ask Dana",
      stops: false,
    });
    expect(readIf("if it is a duplicate then stop")).toEqual({
      condition: "it is a duplicate",
      onPath: "",
      stops: true,
    });
    expect(readIf("If it is late")).toEqual({ condition: "it is late", onPath: "", stops: false });
    expect(readIf("If the total is over $5,000, ask Dana")).toEqual({
      condition: "the total is over $5,000",
      onPath: "ask Dana",
      stops: false,
    });
    expect(readIf("Read it")).toBeNull();
  });

  it("builds a decision with paths: Or if, conditions, removing one, and the otherwise", () => {
    const newId = ids();
    const made = addDecision(draft(), ROOT, 3, "it is a credit memo", newId);
    const added = addPath(made.process, made.stepId, newId);
    expect(added.pathId).not.toBeNull();
    let p = setCondition(added.process, made.stepId, added.pathId ?? "", "it is a statement");
    let d = ifAt(p, made.stepId);
    expect(d.paths.map((x) => x.name)).toEqual(["it is a credit memo", "it is a statement"]);
    // A step on a path and one on the otherwise.
    p = addLine(
      p,
      pathContainer(added.pathId ?? ""),
      0,
      "Save it to the vendor's folder",
      newId,
    ).process;
    p = addLine(p, otherwiseContainer(d), 0, "Create the bill", newId).process;
    d = ifAt(p, made.stepId);
    expect(d.paths[1]?.steps.map((s) => s.name)).toEqual(["Save it to the vendor's folder"]);
    expect(d.otherwise.steps.map((s) => s.name)).toEqual(["Create the bill"]);
    // The first path's condition names the decision.
    p = setCondition(p, made.stepId, d.paths[0]?.id ?? "", "it is a credit");
    expect(ifAt(p, made.stepId).name).toBe("If it is a credit");
    // Removing a path takes its steps; the last path stays.
    p = removePath(p, made.stepId, added.pathId ?? "");
    d = ifAt(p, made.stepId);
    expect(d.paths).toHaveLength(1);
    expect(removePath(p, made.stepId, d.paths[0]?.id ?? "")).toEqual(p);
    expect(countLines(p)).toEqual({ steps: 2, decisions: 2 });
  });

  it("ends a path here or lets it rejoin, and sets every path at once", () => {
    const newId = ids();
    const before = draft();
    let p = setPathEnd(before, pathContainer("p1"), "stop", newId);
    let d = ifAt(p, "dup");
    expect(d.paths[0]?.steps.map((s) => s.kind)).toEqual(["notify", "stop"]);
    // Ending it twice adds no second Stop.
    expect(setPathEnd(p, pathContainer("p1"), "stop", newId)).toEqual(p);
    expect(afterPaths(d)).toBe("mixed");
    p = setAfterPaths(p, "dup", "apart", newId);
    d = ifAt(p, "dup");
    expect(afterPaths(d)).toBe("apart");
    expect(d.otherwise.steps.map((s) => s.kind)).toEqual(["stop"]);
    p = setAfterPaths(p, "dup", "together", newId);
    d = ifAt(p, "dup");
    expect(afterPaths(d)).toBe("together");
    // Back where it started: the Stops made here are gone, every other id is the same.
    expect(p).toEqual(before);
  });

  it("moves a path's steps below the decision, in order, before the lines already there", () => {
    const newId = ids();
    const before = draft();
    const d0 = ifAt(before, "dup");
    // The rest of the process drafted into the otherwise.
    let p = addLine(before, otherwiseContainer(d0), 0, "Match the vendor", newId).process;
    p = addLine(p, otherwiseContainer(d0), 1, "Match the lines", newId).process;
    const inside = ifAt(p, "dup").otherwise.steps.map((s) => s.id);
    const moved = movePathBelow(p, "dup", otherwiseContainer(d0));
    expect(ifAt(moved, "dup").otherwise.steps).toEqual([]);
    expect(moved.steps.map((s) => s.id)).toEqual(["read", "dup", ...inside, "bill"]);
    // Nothing is made or lost: the same steps, with their ids.
    expect(allIds(moved).sort()).toEqual(allIds(p).sort());
    // The path that stays is untouched, and an empty path moves nothing.
    expect(ifAt(moved, "dup").paths).toEqual(ifAt(p, "dup").paths);
    expect(movePathBelow(moved, "dup", otherwiseContainer(d0))).toEqual(moved);
    // A path that ends here keeps its steps: its Stop would end the lines below.
    const ended = setPathEnd(p, otherwiseContainer(d0), "stop", newId);
    expect(movePathBelow(ended, "dup", otherwiseContainer(d0))).toEqual(ended);
    // Not a decision: nothing changes.
    expect(movePathBelow(p, "read", otherwiseContainer(d0))).toEqual(p);
  });

  it("maps How it starts onto the first trigger, keeping its id", () => {
    const before = draft();
    expect(startKindOf(before.triggers[0]?.on ?? { type: "command", command: "x" })).toBe(
      "document",
    );
    // The same kind keeps the trigger as it is.
    expect(setStart(before, "document")).toBe(before);
    const p = setStart(before, "schedule");
    expect(p.triggers).toEqual([{ id: "t0", on: { type: "schedule", cron: "0 7 * * 1-5" } }]);
    expect(startKindOf(setStart(p, "person").triggers[0]?.on as never)).toBe("person");
    expect(startKindOf({ type: "event", event: "message.received" })).toBe("message");
    expect(startKindOf({ type: "event", event: "transaction.created" })).toBe("record");
    expect(startKindOf({ type: "event", event: "run.failed" })).toBeNull();
    expect(blankProcess(ids())).toEqual({
      schemaVersion: 4,
      triggers: [{ id: "id-1", on: { type: "manual", input: { type: "object", properties: {} } } }],
      steps: [],
    });
  });

  it("finds what was added by hand and asks the Builder to fill it once", () => {
    const newId = ids();
    const before = draft();
    let p = addLine(before, ROOT, 1, "Code each line to a job", newId).process;
    p = addLine(p, ROOT, 2, "", newId).process;
    p = addDecision(p, ROOT, 4, "the total is over $5,000", newId).process;
    const added = handAdded(before, finishLines(p));
    expect(added.lines.map((l) => l.need)).toEqual(["Code each line to a job"]);
    expect(added.decisions.map((d) => d.paths[0]?.name)).toEqual(["the total is over $5,000"]);
    const text = fillRequest({ workflowName: "Invoice intake", added, startWords: null });
    expect(text).toContain('"Code each line to a job"');
    expect(text).toContain('if "the total is over $5,000"');
    expect(text).not.toContain("It starts");
    expect(fillRequest({ workflowName: "x", added: handAdded(before, before) })).toBeNull();
    expect(
      fillRequest({
        workflowName: "x",
        added: handAdded(before, before),
        startWords: "When a vendor emails",
      }),
    ).toBe("It starts: When a vendor emails. Set its trigger to match.");
  });

  it("says a list typed with no draft as words the Builder drafts from", () => {
    const newId = ids();
    let p = blankProcess(newId);
    p = addLine(p, ROOT, 0, "Read the invoice", newId).process;
    const d = addLine(p, ROOT, 1, "If it is a duplicate, tell Dana and stop", newId);
    p = lineToDecision(d.process, d.stepId, newId);
    p = addLine(p, ROOT, 2, "Create the bill", newId).process;
    expect(listWords(p, "When an invoice arrives by email")).toBe(
      "It starts: When an invoice arrives by email. 1. Read the invoice. 2. If it is a duplicate: tell Dana, then it ends. 3. Create the bill.",
    );
  });

  it("never regenerates an id across a run of edits", () => {
    const newId = ids();
    const before = draft();
    let p = addLine(before, ROOT, 0, "Check the vendor", newId).process;
    p = moveLine(p, "bill", 1);
    p = setPathEnd(p, pathContainer("p1"), "stop", newId);
    p = renameLine(p, "tell", "Tell Dana it is a duplicate");
    const kept = allIds(before).filter((id) => allIds(p).includes(id));
    expect(kept).toEqual(allIds(before).filter((id) => id !== undefined));
    const step = locate(p, "tell")?.step as Step;
    expect(step.id).toBe("tell");
  });
});
