import { describe, expect, it } from "vitest";
import { ToolDisplay } from "../schemas/tool-display";
import { PersonInstructions } from "../steps/schema";
import {
  answerFields,
  answerProblem,
  batchKeyOf,
  choiceProblem,
  editablePaths,
  editProblem,
  snoozeUntil,
  undoSecondsOf,
  withUndoSeconds,
} from "./rules";

const display = ToolDisplay.parse({
  name: "Email",
  fields: [
    { label: "To", kind: "text", after: "input.to" },
    { label: "Subject", kind: "text", after: "input.subject", editable: true },
    { label: "Body", kind: "text", after: "input.body", editable: true },
    { label: "Total", kind: "money", after: "input.amount.value", editable: true },
  ],
});

describe("undo window setting", () => {
  it("defaults to 60 seconds and keeps other approval settings", () => {
    expect(undoSecondsOf({})).toBe(60);
    expect(undoSecondsOf({ approvals: { undoSeconds: 0 } })).toBe(0);
    expect(undoSecondsOf({ approvals: { undoSeconds: 900 } })).toBe(60);
    const next = withUndoSeconds({ approvals: { external_actions: "operator" } }, 120);
    expect(next).toEqual({ approvals: { external_actions: "operator", undoSeconds: 120 } });
    expect(() => withUndoSeconds({}, 301)).toThrow();
  });
});

describe("snoozeUntil", () => {
  const now = new Date("2026-11-06T10:00:00Z");
  it("refuses the past and more than 14 days", () => {
    expect(snoozeUntil({ until: now, now, dueAt: null })).toMatchObject({
      ok: false,
      code: "in_the_past",
    });
    expect(
      snoozeUntil({ until: new Date("2026-11-21T10:00:00Z"), now, dueAt: null }),
    ).toMatchObject({ ok: false, code: "too_far" });
  });
  it("is cut to an hour before the due time", () => {
    const r = snoozeUntil({
      until: new Date("2026-11-08T08:00:00Z"),
      now,
      dueAt: new Date("2026-11-07T10:00:00Z"),
    });
    expect(r).toEqual({ ok: true, until: new Date("2026-11-07T09:00:00Z"), cut: true });
    expect(
      snoozeUntil({
        until: new Date("2026-11-06T12:00:00Z"),
        now,
        dueAt: new Date("2026-11-06T10:30:00Z"),
      }),
    ).toMatchObject({ ok: false, code: "due_soon" });
  });
});

describe("edits before signing", () => {
  it("only plain input values can be marked editable", () => {
    expect(
      ToolDisplay.safeParse({
        name: "x",
        fields: [{ label: "Vendor", kind: "ref", after: "input.vendor", editable: true }],
      }).success,
    ).toBe(false);
    expect(
      ToolDisplay.safeParse({
        name: "x",
        fields: [{ label: "Now", kind: "text", now: "before.x", editable: true }],
      }).success,
    ).toBe(false);
  });

  it("lists editable paths without fixed inputs", () => {
    expect(editablePaths(display)).toEqual([["subject"], ["body"], ["amount", "value"]]);
    expect(editablePaths(display, ["body"])).toEqual([["subject"], ["amount", "value"]]);
  });

  it("accepts a change to editable fields only", () => {
    const original = {
      to: "a@x.test",
      subject: "Hi",
      body: "B",
      amount: { value: "1.00", currency: "USD" },
    };
    const paths = editablePaths(display);
    expect(editProblem({ original, edited: { ...original, subject: "Hello" }, paths })).toBeNull();
    expect(
      editProblem({
        original,
        edited: { ...original, amount: { value: "2.00", currency: "USD" } },
        paths,
      }),
    ).toBeNull();
    expect(editProblem({ original, edited: { ...original, to: "b@x.test" }, paths })).toMatch(
      /to can't/,
    );
    expect(
      editProblem({
        original,
        edited: { ...original, amount: { value: "1.00", currency: "EUR" } },
        paths,
      }),
    ).toMatch(/amount can't/);
    expect(editProblem({ original, edited: { ...original, extra: 1 }, paths })).toMatch(/extra/);
    expect(editProblem({ original, edited: original, paths: [] })).toMatch(/nothing/);
  });
});

describe("edit paths through a prototype", () => {
  it("are never editable, and an edit through them changes nothing", () => {
    const sneaky = {
      name: "x",
      fields: [
        { label: "A", kind: "text", after: "input.__proto__.polluted", editable: true },
        { label: "B", kind: "text", after: "input.constructor.prototype.x", editable: true },
      ],
    } as unknown as Parameters<typeof editablePaths>[0];
    expect(editablePaths(sneaky)).toEqual([]);
    const original = { subject: "Hi" };
    const edited = JSON.parse('{"subject":"Hi","__proto__":{"polluted":"yes"}}');
    for (const paths of [[["__proto__", "polluted"]], [["constructor", "prototype", "x"]]]) {
      expect(editProblem({ original, edited, paths })).not.toBeNull();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("quick answers", () => {
  it("takes one of the values", () => {
    const choices = [{ value: "yes" }, { value: "no" }];
    expect(choiceProblem(choices, "yes")).toBeNull();
    expect(choiceProblem(choices, "maybe")).toMatch(/yes, no/);
    expect(choiceProblem(choices, ["yes"])).not.toBeNull();
  });

  it("a person step takes 1 to 6 choices", () => {
    const step = {
      mode: "ask",
      who: "client_admin",
      question: "Pay now?",
      deadline: { after: "1 day", ifNoAnswer: "stop" },
    };
    const choice = (v: string) => ({ value: v, label: { en: v } });
    expect(PersonInstructions.safeParse({ ...step, choices: [choice("yes")] }).success).toBe(true);
    expect(PersonInstructions.safeParse({ ...step, choices: [] }).success).toBe(false);
    expect(
      PersonInstructions.safeParse({
        ...step,
        choices: ["a", "b", "c", "d", "e", "f", "g"].map(choice),
      }).success,
    ).toBe(false);
  });
});

describe("batchKeyOf", () => {
  it("keys a loop's children by the loop", () => {
    expect(batchKeyOf("r1", "send")).toBe("r1:send");
    expect(batchKeyOf("r1", "each:2:send")).toBe("r1:each");
  });
});

// Owner, 2026-11-28: a person step asks for the fields it lists, each handed on by its name.
describe("a person's answer to the fields it was asked for", () => {
  const fields = [
    { name: "choice", type: "text", required: true },
    { name: "note", type: "text", required: false },
    { name: "amount", type: "money", required: false },
  ] as const;
  const payload = {
    choices: [
      { value: "booked_by_hand", label: "I booked it" },
      { value: "missing", label: "Missing" },
    ],
    fields,
  };

  it("reads a form answer by name, and a single value as the first field", () => {
    expect(answerFields(fields, { choice: "missing", note: "No job named", extra: 1 })).toEqual({
      choice: "missing",
      note: "No job named",
      amount: null,
    });
    expect(answerFields(fields, "missing")).toEqual({
      choice: "missing",
      note: null,
      amount: null,
    });
    expect(answerFields(fields, null)).toEqual({ choice: null, note: null, amount: null });
  });

  it("holds the first field to the choices and the rest to their types", () => {
    expect(answerProblem(payload, { choice: "missing", note: "No job" })).toBeNull();
    expect(answerProblem(payload, "missing")).toBeNull();
    expect(answerProblem(payload, { choice: "maybe" })).toBe(
      "answer with one of: booked_by_hand, missing",
    );
    expect(answerProblem(payload, { choice: "missing", amount: "12.5x" })).toBe(
      "amount: give an amount, like 125.00",
    );
    expect(answerProblem({ fields }, { note: "x" })).toBe("choice: this is needed");
    expect(answerProblem({ fields }, { choice: "  " })).toBe("choice: this is needed");
    // No fields: as before, a choice or anything.
    expect(answerProblem({ choices: payload.choices }, "missing")).toBeNull();
    expect(answerProblem({}, "anything")).toBeNull();
  });
});
