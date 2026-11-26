// The v5 publish checks that ported what v4's validator held a workflow to: a step's references,
// what must be written in the step, seats, hand-offs to the agent's own workflows, schedules.
import { describe, expect, it } from "vitest";
import type { Step, Workflow } from "../steps/schema";
import { stepModelSeatProblems } from "./seats";
import { stepModelHandoffErrors } from "./step-model-handoff";
import { stepModelFixedInputErrors, stepModelScheduleErrors } from "./step-model-publish";
import { stepModelRefErrors } from "./step-model-refs";

const rules = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    kind: "do",
    doneBy: "rules",
    uses: { type: "action", action: "testkit.record.read" },
    input: {},
    ...extra,
  }) as unknown as Step;

const wf = (steps: Step[], extra: Record<string, unknown> = {}) =>
  ({
    schemaVersion: 5,
    triggers: [{ id: "t", on: { type: "manual", input: {} } }],
    outputs: [],
    steps,
    ...extra,
  }) as unknown as Workflow;

describe("stepModelRefErrors", () => {
  it("accepts a reference to a step that ran before, and refuses one that hasn't or doesn't exist", () => {
    const ok = wf([rules("a"), rules("b", { input: { x: "{{steps.a.output.id}}" } })]);
    expect(stepModelRefErrors(ok)).toEqual([]);
    const later = wf([rules("a", { input: { x: "{{steps.b.output.id}}" } }), rules("b")]);
    expect(stepModelRefErrors(later).map((e) => [e.stepId, e.code])).toEqual([
      ["a", "template_scope"],
    ]);
    const unknown = wf([rules("a", { input: { x: "{{steps.nope.output}}" } })]);
    expect(stepModelRefErrors(unknown)[0]?.message).toContain("unknown reference");
  });

  it("lets a step's checks read its own output (a notice, an approval condition)", () => {
    const own = wf([
      rules("save", {
        checks: {
          notify: [{ to: "client_admin", message: "{{steps.save.output.count}} saved" }],
        },
      }),
    ]);
    expect(stepModelRefErrors(own)).toEqual([]);
    // Its inputs may not: it hasn't run yet.
    const input = wf([rules("save", { input: { x: "{{steps.save.output.count}}" } })]);
    expect(stepModelRefErrors(input)).toHaveLength(1);
  });

  it("sees a path's steps from the steps before the fork, not from a sibling path", () => {
    const fork = {
      id: "f",
      name: "f",
      kind: "fork",
      paths: [
        {
          id: "p1",
          name: "p1",
          when: { match: "all", rules: [] },
          steps: [rules("x")],
        },
        {
          id: "p2",
          name: "p2",
          when: { match: "all", rules: [] },
          steps: [rules("y", { input: { v: "{{steps.x.output}}" } })],
        },
      ],
      otherwise: { id: "o", steps: [] },
    } as unknown as Step;
    expect(stepModelRefErrors(wf([fork])).map((e) => e.stepId)).toEqual(["y"]);
  });
});

describe("stepModelFixedInputErrors", () => {
  const ctx = {
    tools: {
      "comms.call": {
        id: "comms.call",
        fixedInputs: ["purpose"],
      },
    },
  } as never;

  it("refuses an action input a tool says is written in the step", () => {
    const w = wf([
      rules("call", {
        uses: { type: "action", action: "comms.call" },
        input: { purpose: "{{trigger.why}}" },
      }),
    ]);
    expect(stepModelFixedInputErrors(w, ctx).map((e) => [e.stepId, e.code, e.field])).toEqual([
      ["call", "input_not_fixed", "input.purpose"],
    ]);
  });

  it("refuses a Contact's goal filled from a template, and accepts fixed words", () => {
    const contact = (goal: string) =>
      wf([
        {
          id: "talk",
          name: "talk",
          kind: "do",
          doneBy: "contact",
          input: {},
          contact: { with: "{{trigger.who}}", channel: "email", goal },
        } as unknown as Step,
      ]);
    expect(
      stepModelFixedInputErrors(contact("{{trigger.x}}"), ctx).map((e) => [e.code, e.field]),
    ).toEqual([["input_not_fixed", "contact.goal"]]);
    expect(stepModelFixedInputErrors(contact("Confirm Friday's delivery"), ctx)).toEqual([]);
  });
});

describe("stepModelScheduleErrors", () => {
  const schedule = (cron: string, tz?: string) =>
    ({
      triggers: [{ id: "s", on: { type: "schedule", cron, ...(tz ? { tz } : {}) } }],
    }) as unknown as Pick<Workflow, "triggers">;

  it("refuses a cron that isn't five fields and a zone nobody knows", () => {
    expect(stepModelScheduleErrors(schedule("0 7 * * 1-5", "America/Chicago"))).toEqual([]);
    expect(stepModelScheduleErrors(schedule("every day")).map((e) => e.code)).toEqual([
      "invalid_cron",
    ]);
    expect(
      stepModelScheduleErrors(schedule("0 7 * * *", "Mars/Olympus")).map((e) => e.code),
    ).toEqual(["invalid_timezone"]);
  });
});

describe("stepModelSeatProblems", () => {
  const person = (who: string, mode: "approve" | "ask" = "approve") =>
    wf([
      {
        id: "ask",
        name: "ask",
        kind: "do",
        doneBy: "person",
        input: {},
        person: {
          mode,
          who,
          question: "ok?",
          show: {},
          deadline: { after: "1 day", ifNoAnswer: "stop" },
          channel: "inbox",
          onReject: "stop",
        },
      } as unknown as Step,
    ]);

  it("names a seat the agent doesn't declare, and a seat of the wrong kind", () => {
    expect(stepModelSeatProblems(person("seat:buyer"), []).map((p) => p.code)).toEqual([
      "unknown_seat",
    ]);
    const told = [{ role: "buyer", description: "", required: false, kind: "told" }] as never;
    expect(stepModelSeatProblems(person("seat:buyer"), told).map((p) => p.code)).toEqual([
      "seat_kind",
    ]);
    const signs = [{ role: "buyer", description: "", required: false, kind: "signs" }] as never;
    expect(stepModelSeatProblems(person("seat:buyer"), signs)).toEqual([]);
  });

  it("leaves a role, a user or a contact alone", () => {
    expect(stepModelSeatProblems(person("client_admin"), [])).toEqual([]);
  });
});

describe("stepModelHandoffErrors: a hand-off to this agent's own workflow", () => {
  const handoff = (workflow: string, step: string) =>
    ({
      id: "go",
      name: "go",
      kind: "handoff",
      to: { agent: "@self", workflow, step },
      input: {},
    }) as unknown as Step;
  const person: Step = {
    id: "ask",
    name: "ask",
    kind: "do",
    doneBy: "person",
    input: {},
    person: {
      mode: "approve",
      who: "client_admin",
      question: "ok?",
      show: {},
      deadline: { after: "1 day", ifNoAnswer: "stop" },
      channel: "inbox",
      onReject: "stop",
    },
  } as unknown as Step;
  const tell = {
    id: "say",
    name: "say",
    kind: "do",
    doneBy: "rules",
    uses: { type: "tell" },
    input: {},
  } as unknown as Step;
  const target = (steps: Step[]) => ({
    slug: "b",
    name: "B",
    enabled: true,
    workflow: wf(steps),
  });
  const from = (to: string, step: string) => ({
    slug: "a",
    name: "A",
    enabled: true,
    workflow: wf([handoff(to, step)]),
  });
  const codes = (steps: Step[]) =>
    stepModelHandoffErrors([from("b", steps[0]?.id ?? ""), target(steps)], undefined).map(
      (e) => e.code,
    );

  it("starts at a read, skill or write Do, or a Loop", () => {
    expect(codes([rules("r")])).toEqual([]);
    expect(codes([rules("w", { uses: { type: "action", action: "x.y.create" } })])).toEqual([]);
  });

  it("refuses a Do done by a person or a Tell: they would ignore the hand-off's input", () => {
    expect(codes([person])).toEqual(["handoff_entry_kind"]);
    expect(codes([tell])).toEqual(["handoff_entry_kind"]);
  });

  it("refuses a loop between workflows once, and a workflow or step that isn't there", () => {
    const a = {
      slug: "a",
      name: "A",
      enabled: true,
      workflow: wf([rules("r1"), handoff("b", "r2")]),
    };
    const b = {
      slug: "b",
      name: "B",
      enabled: true,
      workflow: wf([rules("r2"), handoff("a", "r1")]),
    };
    expect(
      stepModelHandoffErrors([a, b], undefined)
        .filter((e) => e.code === "handoff_loop")
        .map((e) => e.workflow),
    ).toEqual(["a", "b"]);
    expect(stepModelHandoffErrors([from("zzz", "r")], undefined).map((e) => e.code)).toEqual([
      "handoff_unknown_workflow",
    ]);
    expect(
      stepModelHandoffErrors([from("b", "nope"), target([rules("r")])], undefined).map(
        (e) => e.code,
      ),
    ).toEqual(["handoff_unknown_step"]);
  });
});
