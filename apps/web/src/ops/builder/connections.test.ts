// Connections (owner, 2026-11-14): "Prior step" and "Next step" move a step in its list, and the
// move is checked first with the validator, with no screen.
import { processes, type SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { BuilderProblem } from "./catalog";
import { assessReconnect, neighbours, reconnect, reconnectWithReshape } from "./connections";
import type { Process } from "./model";

const io = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

const skill = (id: string, input: object, output: object) =>
  ({
    schemaVersion: 1,
    id,
    name: id,
    description: "",
    category: "documents",
    mode: "task",
    model: { id: "claude-haiku-5-5" },
    tools: [],
    input,
    output,
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
  }) as SkillDefinition;

const READ = skill(
  "docs.read",
  io({}),
  io({ vendorName: { type: "string" }, total: { type: "string" } }),
);
const CHECK = skill(
  "vendors.check",
  io({ vendor: { type: "string" } }, ["vendor"]),
  io({ ok: { type: "boolean" } }),
);
const NOTE = skill("docs.note", io({}), io({}));
const ctx = { skills: { [READ.id]: READ, [CHECK.id]: CHECK, [NOTE.id]: NOTE } };

const process: Process = processes.Process.parse({
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: io({}) } }],
  steps: [
    { id: "a", kind: "skill", name: "Read document", skill: READ.id, input: {} },
    {
      id: "b",
      kind: "skill",
      name: "Check vendor",
      skill: CHECK.id,
      input: { vendor: "{{steps.a.output.vendorName}}" },
    },
    { id: "c", kind: "skill", name: "Note it", skill: NOTE.id, input: {} },
  ],
});

const check = (p: Process): BuilderProblem[] => processes.validateProcess(p, ctx).errors;
const ids = (p: Process) => p.steps.map((s) => s.id);

describe("a step's connections", () => {
  it("reads the steps right before and after it on its list", () => {
    const n = neighbours(process, "b");
    expect(n?.prior?.id).toBe("a");
    expect(n?.next?.id).toBe("c");
    expect(neighbours(process, "a")?.prior).toBeNull();
    expect(neighbours(process, "c")?.next).toBeNull();
  });

  it("moves the step to meet a new prior or next step", () => {
    expect(ids(reconnect(process, "c", { end: "prior", to: "a" }))).toEqual(["a", "c", "b"]);
    expect(ids(reconnect(process, "a", { end: "next", to: null }))).toEqual(["b", "c", "a"]);
    expect(ids(reconnect(process, "c", { end: "prior", to: null }))).toEqual(["c", "a", "b"]);
    expect(ids(reconnect(process, "a", { end: "next", to: "c" }))).toEqual(["b", "a", "c"]);
  });

  it("makes a move that breaks nothing with no problems to show", () => {
    expect(check(process)).toEqual([]);
    const r = assessReconnect(process, "c", { end: "next", to: "a" }, check);
    expect(ids(r?.process as Process)).toEqual(["c", "a", "b"]);
    expect(r?.added).toEqual([]);
    expect(r?.fits).toEqual([]);
  });

  it("says nothing moves when the pick is the step it is already connected to", () => {
    expect(assessReconnect(process, "b", { end: "prior", to: "a" }, check)).toBeNull();
  });

  it("finds data a step reads that would no longer run before it, and where it fits instead", () => {
    // "Check vendor" first: the vendor it reads from "Read document" would come after it.
    const r = assessReconnect(process, "b", { end: "prior", to: null }, check);
    expect(ids(r?.process as Process)).toEqual(["b", "a", "c"]);
    expect(r?.added.map((g) => g.kind)).toEqual(["reads"]);
    expect(r?.added[0]?.problems[0]).toMatchObject({ stepId: "b", code: "template_scope" });
    expect(r?.reshape.map((s) => s.id)).toEqual(["b"]);
    // Last, after "Note it", "Read document" still runs before it.
    expect(r?.fits.map((p) => [p.prior?.id ?? null, p.next?.id ?? null])).toEqual([["c", null]]);
  });

  it("moves the step and puts a Reshape step before the one it leaves unfilled, in one edit", () => {
    let n = 0;
    const out = reconnectWithReshape(
      process,
      "a",
      { end: "next", to: null },
      ["b"],
      ctx,
      () => `r${++n}`,
    );
    expect(ids(out)).toEqual(["r1", "b", "c", "a"]);
    expect(out.steps[0]).toMatchObject({ skill: processes.RESHAPE_SKILL });
  });
});
