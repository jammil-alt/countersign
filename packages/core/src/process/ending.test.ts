// How it ends (owner, 2026-11-23): the steps a run can finish on, whether each reports out, and
// the validator's advice for one that doesn't.
import { describe, expect, it } from "vitest";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import { deadEnds, reportsOut, runEnds } from "./ending";
import { type Process, Process as ProcessSchema, type Step } from "./schema";
import { validateProcess } from "./validate";

const read = (id: string): Step => ({
  id,
  name: `Read ${id}`,
  kind: "read",
  tool: "t.read",
  input: {},
});
const write = (id: string): Step =>
  ({ id, name: `Write ${id}`, kind: "write", tool: "t.write", input: {} }) as Step;
const note = (id: string): Step =>
  ({
    id,
    name: `Tell ${id}`,
    kind: "notify",
    notify: { to: ["client_admin"], channel: "inbox", message: "Done" },
  }) as Step;
const stop = (id: string, status: "succeeded" | "failed" = "succeeded"): Step => ({
  id,
  name: "Stop",
  kind: "stop",
  status,
});
const decision = (id: string, path: Step[], otherwise: Step[]): Step =>
  ({
    id,
    name: "If",
    kind: "if",
    paths: [{ id: `${id}-p`, name: "it fits", when: { match: "all", rules: [] }, steps: path }],
    otherwise: { id: `${id}-o`, steps: otherwise },
  }) as Step;

const process = (steps: Step[], more: Partial<Process> = {}): Process =>
  ProcessSchema.parse({
    schemaVersion: 4,
    triggers: [{ id: "t0", on: { type: "manual", input: { type: "object" } } }],
    steps,
    ...more,
  });

const ids = (steps: Step[]) => steps.map((s) => s.id);

describe("how a process ends", () => {
  it("ends on its last step, looking past a Stop that only closes the list", () => {
    expect(ids(runEnds(process([read("a"), write("b")])))).toEqual(["b"]);
    expect(ids(runEnds(process([read("a"), write("b"), stop("s")])))).toEqual(["b"]);
    expect(runEnds(process([]))).toEqual([]);
    // A failed Stop is an end of its own: nothing before it is the run's result.
    expect(runEnds(process([read("a"), stop("s", "failed")]))).toEqual([]);
  });

  it("follows a closing decision down each path that has steps", () => {
    // An empty otherwise is "nothing to do": the run's ends are the path's.
    const p = process([read("a"), decision("d", [note("n")], [])]);
    expect(ids(runEnds(p))).toEqual(["n"]);
    expect(deadEnds(p)).toEqual([]);
    // A path that ends on a read is a dead end; the one that reports out isn't.
    const mixed = process([read("a"), decision("d", [note("n")], [read("r")])]);
    expect(ids(runEnds(mixed))).toEqual(["n", "r"]);
    expect(ids(deadEnds(mixed))).toEqual(["r"]);
    // A path that ends here by choice adds no end; the other still does.
    const chosen = process([read("a"), decision("d", [stop("s")], [read("r")])]);
    expect(ids(runEnds(chosen))).toEqual(["r"]);
    // A decision with nothing on any path does nothing: the run ends on what came before.
    const hollow = process([read("a"), decision("d", [], [])]);
    expect(ids(runEnds(hollow))).toEqual(["a"]);
    expect(ids(deadEnds(hollow))).toEqual(["a"]);
  });

  it("looks inside a closing loop", () => {
    const loop = {
      id: "l",
      name: "Each",
      kind: "for_each",
      over: "{{trigger.items}}",
      steps: [read("r")],
    };
    expect(ids(runEnds(process([loop as Step])))).toEqual(["r"]);
  });

  it("says what each kind reports out; a skill only with the registries", () => {
    expect(reportsOut(write("w"))).toBe("tool");
    expect(reportsOut(note("n"))).toBe("people");
    expect(reportsOut(read("r"))).toBe("none");
    expect(
      reportsOut({
        id: "h",
        name: "Hand off",
        kind: "handoff",
        to: { agent: "", step: "" },
        input: {},
      }),
    ).toBe("agent");
    const skill: Step = {
      id: "k",
      name: "Think",
      kind: "skill",
      skill: "custom:think",
      input: {},
    } as Step;
    expect(reportsOut(skill)).toBe("unknown");
    const def = (tools: string[], more: object = {}) =>
      ({ id: "custom:think", tools, ...more }) as unknown as SkillDefinition;
    const tools = {
      "t.read": { sideEffect: "none" },
      "t.save": { sideEffect: "internal" },
    } as unknown as Record<string, ToolSpec>;
    const ctx = (d: SkillDefinition) => ({ skills: { "custom:think": d }, tools });
    expect(reportsOut(skill, ctx(def(["t.read"])))).toBe("none");
    expect(reportsOut(skill, ctx(def(["t.save"])))).toBe("tool");
    expect(reportsOut(skill, ctx(def([], { reachesPeople: true })))).toBe("people");
    // A tool the registries don't know: not called a dead end.
    expect(reportsOut(skill, ctx(def(["t.other"])))).toBe("unknown");
  });

  it("is advice from the validator, one per dead end, and none when the output is passed on", () => {
    const p = process([write("b"), read("a")]);
    const r = validateProcess(p);
    expect(r.warnings.filter((w) => w.code === "no_output")).toEqual([
      expect.objectContaining({ stepId: "a", message: expect.stringContaining('"Read a"') }),
    ]);
    // Advice only: it doesn't make the process invalid by itself.
    expect(r.errors.filter((e) => e.stepId === "a" && e.code === ("no_output" as string))).toEqual(
      [],
    );
    const passed = process([write("b"), read("a")], { handoff: { output: "{{steps.a.output}}" } });
    expect(validateProcess(passed).warnings.filter((w) => w.code === "no_output")).toEqual([]);
    expect(validateProcess(process([read("a"), write("b")])).warnings).toEqual([]);
  });
});
