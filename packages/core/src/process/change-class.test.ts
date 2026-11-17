// v0.19 O8 (ARCHITECTURE §10.15): a drafted change's class, by code.

import { describe, expect, it } from "vitest";
import { classifyChange } from "./change-class";

const manual = { id: "trg-manual", on: { type: "manual", input: { type: "object" } } };

const bundle = (
  steps: unknown[],
  definition: Record<string, unknown> = {},
  triggers: unknown[] = [manual],
) => ({
  schemaVersion: 1,
  definition: {
    permissions: { mode: "suggest_only" },
    extraTools: ["qbo.bill.query"],
    skills: [],
    ...definition,
  },
  workflows: [
    { slug: "bills-in", name: "Bills in", workflow: { schemaVersion: 4, triggers, steps } },
  ],
});

const read = { id: "read", kind: "skill", skill: "docs.read" };
const write = {
  id: "bill",
  kind: "write",
  tool: "qbo.bill.create",
  checks: { approval: { required: "required" } },
};

describe("classifyChange", () => {
  it("is none when nothing changed, and process for a change that loosens nothing", () => {
    expect(classifyChange(bundle([read, write]), bundle([read, write])).class).toBe("none");
    const later = bundle([{ ...read, input: { note: "trim the vendor name" } }, write]);
    expect(classifyChange(bundle([read, write]), later)).toEqual({
      class: "process",
      reasons: ["changes the process without loosening anything"],
    });
    // A new read step and a tighter approval are process changes too.
    const more = bundle([read, { id: "check", kind: "skill", skill: "docs.check" }, write]);
    expect(classifyChange(bundle([read, write]), more).class).toBe("process");
  });

  it("is never for a loosened approval, a removed check, a new write or new tools", () => {
    const loosened = bundle([
      read,
      { ...write, checks: { approval: { required: "not_required" } } },
    ]);
    expect(classifyChange(bundle([read, write]), loosened).reasons).toContain(
      `makes "bill"'s approval not required`,
    );
    const unchecked = bundle([read, { ...write, checks: {} }]);
    expect(classifyChange(bundle([read, write]), unchecked).class).toBe("never");
    const newWrite = bundle([
      read,
      write,
      { id: "pay", kind: "write", tool: "qbo.payment.create" },
    ]);
    expect(classifyChange(bundle([read, write]), newWrite).reasons).toContain(
      'adds a write step "pay"',
    );
    const tools = bundle([read, write], { extraTools: ["qbo.bill.query", "qbo.payment.create"] });
    expect(classifyChange(bundle([read, write]), tools).reasons).toContain(
      "adds the tool qbo.payment.create",
    );
    const mode = bundle([read, write], { permissions: { mode: "act" } });
    expect(classifyChange(bundle([read, write]), mode).class).toBe("never");
  });

  // Audit 5.11: computed from the whole bundle diff; anything not known to be safe loosens.
  const approve = (approvers: unknown[], mode = "in_turn") => ({
    ...write,
    checks: { approval: { required: "required", mode, approvers } },
  });
  const was = (s: unknown[]) => classifyChange(bundle([read, write]), bundle(s));

  it("is never for a removed step", () => {
    expect(was([write]).reasons).toContain('removes the step "read"');
  });

  it("is never for fewer or other approvers, and process for one more who must also sign", () => {
    const two = bundle([read, approve([{ who: "client_admin" }, { who: "lead" }])]);
    const one = bundle([read, approve([{ who: "client_admin" }])]);
    expect(classifyChange(two, one).class).toBe("never");
    const other = bundle([read, approve([{ who: "client_admin" }, { who: "operator" }])]);
    expect(classifyChange(two, other).class).toBe("never");
    const any = bundle([read, approve([{ who: "client_admin" }, { who: "lead" }], "any")]);
    expect(classifyChange(two, any).class).toBe("never");
    const three = bundle([
      read,
      approve([{ who: "client_admin" }, { who: "lead" }, { who: "operator" }]),
    ]);
    expect(classifyChange(two, three).class).toBe("process");
    // With `any`, one more approver is one more person who may sign alone.
    const anyThree = bundle([
      read,
      approve([{ who: "client_admin" }, { who: "lead" }, { who: "operator" }], "any"),
    ]);
    expect(classifyChange(any, anyThree).class).toBe("never");
  });

  it("is never for an approval limited to some runs or one that proceeds unanswered", () => {
    const when = {
      ...write,
      checks: { approval: { required: "required", when: { match: "all", rules: [] } } },
    };
    expect(was([read, when]).class).toBe("never");
    const proceed = {
      ...write,
      checks: { approval: { required: "required", ifNoAnswer: "proceed" } },
    };
    expect(was([read, proceed]).class).toBe("never");
  });

  it("is never for steps moved, review turned off, a new path or another agent's skill", () => {
    expect(was([write, read]).class).toBe("never");
    expect(was([{ ...read, review: "off" }, write]).class).toBe("never");
    expect(was([{ ...read, agent: "bookkeeper" }, write]).class).toBe("never");
    expect(was([{ ...read, skill: "docs.other" }, write]).class).toBe("never");
    const branch = (paths: unknown[]) => ({
      id: "route",
      name: "Route",
      kind: "if",
      paths,
      otherwise: { id: "else", steps: [write] },
    });
    const path = (id: string) => ({
      id,
      name: id,
      when: { match: "all", rules: [] },
      steps: [],
    });
    const before = bundle([read, branch([path("small")])]);
    expect(
      classifyChange(before, bundle([read, branch([path("small"), path("skip")])])).class,
    ).toBe("never");
    // A whole new branch with new steps that don't write is a process change.
    const added = bundle([
      read,
      write,
      { ...branch([path("a")]), id: "route2", otherwise: { id: "e2", steps: [] } },
    ]);
    expect(classifyChange(bundle([read, write]), added).class).toBe("process");
  });

  it("is process for a renamed step, a tightened approval, a second check or a lower budget", () => {
    expect(was([{ ...read, name: "Read the bill" }, write]).class).toBe("process");
    const loose = bundle([read, { ...write, checks: { approval: { required: "not_required" } } }]);
    expect(classifyChange(loose, bundle([read, write])).class).toBe("process");
    const confer = {
      ...write,
      checks: { ...write.checks, confer: { with: [{ ai: { focus: "the amount" } }] } },
    };
    expect(was([read, confer]).class).toBe("process");
    const budget = (maxCostUsd: string) =>
      bundle([read, write], { budgets: { maxSteps: 6, maxCostUsd } });
    expect(classifyChange(budget("0.50"), budget("0.40")).class).toBe("process");
    expect(classifyChange(budget("0.50"), budget("0.60")).class).toBe("never");
  });

  it("is never for a new trigger, a new skill, changed skill settings or another agent asked", () => {
    const hook = {
      id: "trg-hook",
      on: { type: "webhook", hookId: "0192f7a0-0000-7000-8000-000000000001" },
    };
    expect(
      classifyChange(bundle([read, write]), bundle([read, write], {}, [manual, hook])).class,
    ).toBe("never");
    // Removing a trigger starts fewer runs.
    expect(
      classifyChange(bundle([read, write], {}, [manual, hook]), bundle([read, write])).class,
    ).toBe("process");
    const skill = (settings: Record<string, unknown>) =>
      bundle([read, write], { skills: [{ skill: "docs.read", settings }] });
    expect(classifyChange(bundle([read, write]), skill({})).class).toBe("never");
    expect(classifyChange(skill({ threshold: 0.9 }), skill({ threshold: 0.5 })).class).toBe(
      "never",
    );
    expect(
      classifyChange(bundle([read, write]), bundle([read, write], { canCommand: ["bookkeeper"] }))
        .class,
    ).toBe("never");
  });
});
