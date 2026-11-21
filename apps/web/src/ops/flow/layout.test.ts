// The chart's layout: a plain sequence, a decision with a path that ends and one that comes back, a
// decision on a path, loops framed or folded, automations as one box, every id carried through
// unchanged, and insert points that name the container and index insertStep takes.
import { describe, expect, it } from "vitest";
import { getContainer, insertStep, type Process, ROOT, type Step } from "../builder/model";
import {
  BOX_H,
  BOX_W,
  DIAMOND_H,
  FLOW_GIVES_BACK_ID,
  FLOW_START_ID,
  type FlowLayout,
  layoutFlow,
  pathLetter,
} from "./layout";
import type { FlowEnds } from "./types";

const ENDS: FlowEnds = {
  start: { title: "Starts when", lines: ["A document arrives"] },
  givesBack: null,
};

const read = (id: string, name = `Read ${id}`): Step =>
  ({ id, name, kind: "read", tool: "testkit.record.query", input: {} }) as Step;
const stop = (id: string): Step => ({ id, name: "", kind: "stop", status: "succeeded" }) as Step;
const iff = (id: string, paths: [string, string, Step[]][], otherwise: [string, Step[]]): Step =>
  ({
    id,
    name: `Decide ${id}`,
    kind: "if",
    paths: paths.map(([pid, name, steps]) => ({ id: pid, name, when: { all: [] }, steps })),
    otherwise: { id: otherwise[0], steps: otherwise[1] },
  }) as unknown as Step;
const forEach = (id: string, steps: Step[]): Step =>
  ({
    id,
    name: `Each ${id}`,
    kind: "for_each",
    over: "{{trigger.lines}}",
    concurrency: 10,
    steps,
  }) as Step;
const repeat = (id: string, steps: Step[]): Step =>
  ({
    id,
    name: `Repeat ${id}`,
    kind: "repeat",
    steps,
    until: { agent: { goal: "done" } },
    maxTimes: 3,
    onLimit: "stop",
  }) as Step;
const auto = (id: string): Step =>
  ({ id, name: `Auto ${id}`, kind: "process", process: "code-lines@2", input: {} }) as Step;

const proc = (steps: Step[]): Process =>
  ({ schemaVersion: 4, triggers: [{ id: "t1", on: { type: "manual" } }], steps }) as Process;

const box = (l: FlowLayout, id: string) => {
  const b = l.boxes.find((x) => x.id === id);
  if (!b) throw new Error(`no box ${id}`);
  return b;
};
const cx = (l: FlowLayout, id: string) => {
  const b = box(l, id);
  return b.x + b.w / 2;
};
const insertsIn = (l: FlowLayout, container: string) =>
  l.inserts.filter((p) => p.container === container).map((p) => p.index);

describe("layoutFlow", () => {
  it("lays a plain sequence down the middle, numbered, with + between and a tail", () => {
    const l = layoutFlow(proc([read("a"), read("b"), read("c")]), { ends: ENDS });
    expect(l.boxes.map((b) => b.id)).toEqual([FLOW_START_ID, "a", "b", "c"]);
    expect(l.boxes.slice(1).map((b) => b.number)).toEqual(["1", "2", "3"]);
    // One column: every box centred on the same x, each lower than the one before.
    const xs = new Set(l.boxes.map((b) => b.x + b.w / 2));
    expect(xs.size).toBe(1);
    const ys = l.boxes.map((b) => b.y);
    expect([...ys].sort((p, q) => p - q)).toEqual(ys);
    expect(box(l, "a")).toMatchObject({
      w: BOX_W,
      h: BOX_H,
      container: ROOT,
      index: 0,
      kind: "read",
    });
    // A + before each step; the tail adds after the last.
    expect(insertsIn(l, ROOT)).toEqual([0, 1, 2]);
    expect(l.tail).toMatchObject({ container: ROOT, index: 3 });
    // Arrows from the start to a, a to b, b to c.
    const pairs = l.edges.filter((e) => e.arrow).map((e) => [e.from, e.to]);
    expect(pairs).toEqual([
      [FLOW_START_ID, "a"],
      ["a", "b"],
      ["b", "c"],
    ]);
    for (const e of l.edges) {
      // Orthogonal: each segment is level or upright.
      for (let i = 1; i < e.points.length; i += 1) {
        const [x0, y0] = e.points[i - 1] as [number, number];
        const [x1, y1] = e.points[i] as [number, number];
        expect(x0 === x1 || y0 === y1).toBe(true);
      }
    }
    // Everything inside the chart's own size.
    for (const b of l.boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(l.width);
      expect(b.y + b.h).toBeLessThanOrEqual(l.height);
    }
  });

  it("spreads a decision's paths sideways; a path ending in Stop ends, the other comes back", () => {
    const l = layoutFlow(
      proc([
        read("a"),
        iff("d", [["p1", "It is a duplicate", [read("x"), stop("s")]]], ["o1", [read("y")]]),
        read("after"),
      ]),
      { ends: ENDS },
    );
    const d = box(l, "d");
    expect(d.shape).toBe("diamond");
    expect(d.h).toBe(DIAMOND_H);
    expect(box(l, "x").number).toBe("2 A1");
    expect(box(l, "s").number).toBe("2 A2");
    expect(box(l, "y").number).toBe("2 B1");
    expect(box(l, "s").shape).toBe("pill");
    // Path A to the left of Otherwise, both under the decision.
    expect(cx(l, "x")).toBeLessThan(cx(l, "y"));
    expect(box(l, "x").y).toBeGreaterThan(d.y + d.h);
    // The labels: the path's name, then Otherwise.
    const labels = l.edges.filter((e) => e.label).map((e) => e.label);
    expect(labels.map((x) => [x?.letter, x?.text, x?.otherwise])).toEqual([
      ["A", "It is a duplicate", false],
      ["B", "Otherwise", true],
    ]);
    // Nothing leaves the Stop; y comes back to the step after the decision.
    expect(l.edges.some((e) => e.from === "s")).toBe(false);
    expect(l.edges.some((e) => e.from === "y" && e.to === "after")).toBe(true);
    expect(l.edges.some((e) => e.from === "x" && e.to === "after")).toBe(false);
    expect(box(l, "after")).toMatchObject({ number: "3", unreachable: false });
    expect(box(l, "after").y).toBeGreaterThan(box(l, "s").y);
    // "+ Add a path" beside the decision.
    expect(l.addPaths).toEqual([expect.objectContaining({ ifId: "d" })]);
    expect(l.addPaths[0]?.x).toBeGreaterThan(cx(l, "y"));
  });

  it("splits a path again for a decision on it", () => {
    const inner = iff("d2", [["q1", "Over budget", [read("m")]]], ["o2", [read("n")]]);
    const l = layoutFlow(proc([iff("d1", [["p1", "Has a PO", [inner]]], ["o1", [read("z")]])]), {
      ends: ENDS,
    });
    expect(box(l, "d2").number).toBe("1 A1");
    expect(box(l, "m").number).toBe("1 A1 A1");
    expect(box(l, "n").number).toBe("1 A1 B1");
    expect(box(l, "m").container).toBe("path:q1");
    expect(box(l, "n").container).toBe("otherwise:o2");
    // The inner decision's two paths sit side by side within path A, left of the outer Otherwise.
    expect(cx(l, "m")).toBeLessThan(cx(l, "n"));
    expect(cx(l, "n")).toBeLessThan(cx(l, "z"));
    expect(l.addPaths.map((a) => a.ifId).sort()).toEqual(["d1", "d2"]);
  });

  it("marks steps after a point where every path ended as never running", () => {
    const l = layoutFlow(
      proc([iff("d", [["p1", "Bad", [stop("s1")]]], ["o1", [stop("s2")]]), read("late")]),
      { ends: ENDS },
    );
    expect(box(l, "late").unreachable).toBe(true);
    expect(l.edges.some((e) => e.to === "late")).toBe(false);
    expect(l.tail).toBeNull();
  });

  it("frames a loop with an arrow back to its top, or folds it to one box", () => {
    const steps = [forEach("f", [read("i1"), read("i2")]), repeat("r", [read("j1")])];
    const open = layoutFlow(proc(steps), { ends: ENDS });
    expect(open.frames.map((f) => [f.stepId, f.kind])).toEqual([
      ["f", "for_each"],
      ["r", "repeat"],
    ]);
    expect(open.frames[0]?.text).toBe("Once for each item");
    expect(open.frames[1]?.text).toBe("Again until done · up to 3 times");
    expect(box(open, "f")).toMatchObject({ fold: "open", inside: 2 });
    expect(box(open, "i1").number).toBe("1.1");
    expect(box(open, "i2").container).toBe("loop:f");
    const backs = open.edges.filter((e) => e.loopBack);
    expect(backs.map((e) => [e.from, e.to])).toEqual([
      ["i2", "f"],
      ["j1", "r"],
    ]);
    // The frame holds its steps.
    const frame = open.frames[0];
    const i2 = box(open, "i2");
    expect(frame && i2.y + i2.h < frame.y + frame.h).toBe(true);
    expect(insertsIn(open, "loop:f")).toEqual([0, 1, 2]);

    const folded = layoutFlow(proc(steps), { ends: ENDS, folded: new Set(["f"]) });
    expect(folded.frames.map((f) => f.stepId)).toEqual(["r"]);
    expect(box(folded, "f")).toMatchObject({ fold: "folded", inside: 2, h: BOX_H });
    expect(folded.boxes.some((b) => b.id === "i1")).toBe(false);
    expect(insertsIn(folded, "loop:f")).toEqual([]);
    expect(folded.height).toBeLessThan(open.height);
  });

  it("draws an automation as one box", () => {
    const l = layoutFlow(proc([auto("a1")]), { ends: ENDS });
    expect(box(l, "a1")).toMatchObject({ kind: "process", shape: "box", w: BOX_W, h: BOX_H });
    expect(box(l, "a1").fold).toBeUndefined();
    expect(l.frames).toEqual([]);
  });

  it("ends with what the flow gives back, when it gives anything", () => {
    const l = layoutFlow(proc([read("a")]), {
      ends: {
        start: { title: "Takes in", lines: ["invoice"] },
        givesBack: { title: "Gives back", lines: ["total"] },
      },
    });
    expect(l.boxes.map((b) => b.id)).toEqual([FLOW_START_ID, "a", FLOW_GIVES_BACK_ID]);
    expect(l.edges.some((e) => e.from === "a" && e.to === FLOW_GIVES_BACK_ID)).toBe(true);
    expect(l.tail).toBeNull();
    expect(insertsIn(l, ROOT)).toEqual([0, 1]);
  });

  it("starts at the top with no start box, and an empty flow is just the place to add", () => {
    const l = layoutFlow(proc([]), { ends: { start: null, givesBack: null } });
    expect(l.boxes).toEqual([]);
    expect(l.tail).toMatchObject({ container: ROOT, index: 0 });
    const one = layoutFlow(proc([read("a")]), { ends: { start: null, givesBack: null } });
    expect(insertsIn(one, ROOT)).toEqual([0]);
    expect(one.edges.some((e) => e.to === "a")).toBe(false);
  });

  it("carries every step, path and loop id through unchanged", () => {
    const process = proc([
      read("0192f0a0-0000-7000-8000-000000000001"),
      iff(
        "0192f0a0-0000-7000-8000-000000000002",
        [
          [
            "0192f0a0-0000-7000-8000-000000000003",
            "A",
            [read("0192f0a0-0000-7000-8000-000000000004")],
          ],
        ],
        ["0192f0a0-0000-7000-8000-000000000005", []],
      ),
      forEach("0192f0a0-0000-7000-8000-000000000006", [
        read("0192f0a0-0000-7000-8000-000000000007"),
      ]),
    ]);
    const before = JSON.stringify(process);
    const l = layoutFlow(process, { ends: ENDS });
    expect(JSON.stringify(process)).toBe(before);
    expect(
      l.boxes
        .filter((b) => b.role === "step")
        .map((b) => b.id)
        .sort(),
    ).toEqual(
      [
        "0192f0a0-0000-7000-8000-000000000001",
        "0192f0a0-0000-7000-8000-000000000002",
        "0192f0a0-0000-7000-8000-000000000004",
        "0192f0a0-0000-7000-8000-000000000006",
        "0192f0a0-0000-7000-8000-000000000007",
      ].sort(),
    );
    const paths = l.edges.filter((e) => e.label).map((e) => e.label?.pathId);
    expect(paths).toEqual([
      "0192f0a0-0000-7000-8000-000000000003",
      "0192f0a0-0000-7000-8000-000000000005",
    ]);
  });

  it("gives insert points that insertStep puts a step at, in the right list and place", () => {
    const process = proc([
      read("a"),
      iff("d", [["p1", "Yes", [read("x"), read("x2")]]], ["o1", []]),
      forEach("f", [read("i")]),
    ]);
    const l = layoutFlow(process, { ends: ENDS });
    expect(insertsIn(l, ROOT)).toEqual([0, 1, 2]);
    expect(l.tail).toMatchObject({ container: ROOT, index: 3 });
    expect(insertsIn(l, "path:p1")).toEqual([0, 1, 2]);
    expect(insertsIn(l, "otherwise:o1")).toEqual([0]);
    expect(insertsIn(l, "loop:f")).toEqual([0, 1]);
    // Each one is a place insertStep accepts: the new step lands there.
    for (const p of [...l.inserts, ...(l.tail ? [l.tail] : [])]) {
      const added = insertStep(process, p.container, p.index, read("new"));
      expect(getContainer(added, p.container)?.[p.index]?.id).toBe("new");
    }
    // The + between x and x2 sits between their boxes.
    const between = l.inserts.find((p) => p.container === "path:p1" && p.index === 1);
    expect(between && between.y > box(l, "x").y && between.y < box(l, "x2").y).toBe(true);
    // Keys are unique.
    expect(new Set(l.inserts.map((p) => p.key)).size).toBe(l.inserts.length);
  });

  it("letters paths A to Z, then AA", () => {
    expect([0, 1, 25, 26, 27].map(pathLetter)).toEqual(["A", "B", "Z", "AA", "AB"]);
  });
});
