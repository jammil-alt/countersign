// Forms (docs/plan.md §1.121): the definition, the operator's ask (required questions and the
// limits on what the agent adds), secrets refused, answers checked by kind, and the output's split.

import { describe, expect, it } from "vitest";
import {
  answerProblems,
  askProblems,
  cleanAnswers,
  documentsOf,
  dueProblem,
  FormAsk,
  FormDefinition,
  type FormDefinitionIn,
  FormRequestInput,
  formEventType,
  formForRequest,
  formProblems,
  splitAnswers,
} from "./index";

const PO = { id: "po_number", label: "PO number", type: "text", required: true } as const;
const QUOTE = {
  id: "freight_quote",
  label: "The freight quote",
  type: "files",
  required: true,
} as const;

const form = (over: Partial<FormDefinitionIn> = {}) =>
  FormDefinition.parse({
    title: "Invoice 1042: two details",
    intro: "We have invoice 1042 for $3,180.00.",
    questions: [
      { ...PO, label: "Which PO is invoice 1042 for?" },
      { ...QUOTE, help: "A PDF or a photo is fine" },
    ],
    ...over,
  });

const ask = (over: Record<string, unknown> = {}) =>
  FormAsk.parse({ required: [PO, QUOTE], ...over });

describe("form definitions", () => {
  it("fills defaults and checks ids", () => {
    const f = form();
    expect(f.schemaVersion).toBe(1);
    const files = f.questions[1];
    expect(files?.type === "files" && files.accept).toEqual(["pdf", "image"]);
    expect(FormDefinition.safeParse({ title: "x", questions: [] }).success).toBe(false);
    expect(
      FormDefinition.safeParse({
        title: "x",
        questions: [{ id: "Bad Id", label: "x", type: "text" }],
      }).success,
    ).toBe(false);
    expect(formProblems(f)).toEqual([]);
  });

  it("refuses repeated ids and options", () => {
    const f = form({
      questions: [
        PO,
        PO,
        {
          id: "reason",
          label: "Why",
          type: "choice",
          options: [
            { id: "timing", label: "Timing" },
            { id: "timing", label: "Again" },
          ],
        },
      ],
    });
    expect(formProblems(f).map((p) => p.message)).toEqual([
      "question po_number is listed twice",
      "option timing is listed twice",
    ]);
  });

  it("never asks for secrets, whoever wrote the form", () => {
    for (const label of [
      "Your card number",
      "Credit card for the deposit",
      "The CVV",
      "Your online banking password",
      "Social security number",
      "SSN",
    ]) {
      const f = form({ questions: [{ id: "x", label, type: "text" }] });
      expect(formProblems(f)[0]?.message, label).toMatch(/never asks for/);
    }
    expect(formProblems(form({ title: "Send us your password" }))).toHaveLength(1);
    // A tax form or an account number for a payment is a document or a fact, not a secret here.
    expect(
      formProblems(form({ questions: [{ id: "w9", label: "Your W-9", type: "files" }] })),
    ).toEqual([]);
  });
});

describe("the step's ask", () => {
  it("passes a form that keeps the required questions, reworded", () => {
    expect(askProblems(form(), ask())).toEqual([]);
  });

  it("refuses a form that drops, retypes or loosens a required question", () => {
    const dropped = form({ questions: [PO] });
    expect(askProblems(dropped, ask()).map((p) => p.message)).toEqual([
      "the form leaves out freight_quote, which must be asked",
    ]);
    const retyped = form({ questions: [{ ...PO, type: "long_text" }, QUOTE] });
    expect(askProblems(retyped, ask())[0]?.message).toBe("po_number must be a text question");
    const loosened = form({ questions: [{ ...PO, required: false }, QUOTE] });
    expect(askProblems(loosened, ask())[0]?.message).toBe("po_number must be answered");
  });

  it("keeps a required choice's options", () => {
    const reason = {
      id: "reason",
      label: "Why is it over?",
      type: "choice",
      required: true,
      options: [
        { id: "timing", label: "Timing" },
        { id: "one_off", label: "One-off" },
      ],
    } as const;
    const a = FormAsk.parse({ required: [reason] });
    const reworded = form({
      questions: [
        {
          ...reason,
          options: [
            { id: "timing", label: "It lands next month" },
            { id: "one_off", label: "It won't happen again" },
          ],
        },
      ],
    });
    expect(askProblems(reworded, a)).toEqual([]);
    const changed = form({
      questions: [
        {
          ...reason,
          options: [
            { id: "timing", label: "x" },
            { id: "error", label: "y" },
          ],
        },
      ],
    });
    expect(askProblems(changed, a)[0]?.message).toBe("reason must keep the step's options");
  });

  it("limits what the agent adds: how many, which kinds, files", () => {
    const extra = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `q${i}`,
        label: `Question ${i}`,
        type: "text" as const,
      }));
    expect(askProblems(form({ questions: [PO, QUOTE, ...extra(5)] }), ask())).toEqual([]);
    expect(askProblems(form({ questions: [PO, QUOTE, ...extra(6)] }), ask())[0]?.message).toBe(
      "the form adds 6 questions; this step allows 5",
    );
    // Tables need the step to allow them; files are their own switch.
    expect(
      askProblems(
        form({
          questions: [
            PO,
            QUOTE,
            {
              id: "t",
              label: "Lines",
              type: "rows",
              columns: [{ id: "a", label: "A", type: "text" }],
            },
          ],
        }),
        ask(),
      )[0]?.message,
    ).toBe("this step doesn't let the agent add rows questions");
    const moreFiles = form({
      questions: [PO, QUOTE, { id: "more", label: "More", type: "files" }],
    });
    expect(askProblems(moreFiles, ask())).toEqual([]);
    expect(askProblems(moreFiles, ask({ allowFiles: false }))[0]?.message).toBe(
      "this step doesn't let the agent ask for files",
    );
    expect(askProblems(moreFiles, ask({ types: ["text"] }))[0]?.message).toBe(
      "this step doesn't let the agent ask for files",
    );
  });
});

describe("the form a request sends", () => {
  const input = (over: Record<string, unknown> = {}) =>
    FormRequestInput.parse({
      to: { contactId: "0190a0b0-0000-7000-8000-000000000001" },
      purpose: "Invoice 1042 has no PO number and its freight looks high",
      ask: { required: [PO, QUOTE] },
      ...over,
    });

  it("builds one from the required questions when none is given", () => {
    const r = formForRequest(input({ title: "Invoice 1042" }));
    expect(r.ok && r.form).toMatchObject({
      title: "Invoice 1042",
      questions: [{ id: "po_number" }, { id: "freight_quote" }],
    });
    const untitled = formForRequest(input());
    expect(untitled.ok && untitled.form.title).toBe(
      "Invoice 1042 has no PO number and its freight looks high",
    );
    expect(formForRequest(input({ ask: {} })).ok).toBe(false);
  });

  it("checks the agent's form against the schema and the ask", () => {
    expect(formForRequest(input({ form: form() })).ok).toBe(true);
    const bad = formForRequest(input({ form: { title: "x", questions: "nope" } }));
    expect(bad.ok).toBe(false);
    const short = formForRequest(input({ form: form({ questions: [PO] }) }));
    expect(!short.ok && short.problems[0]?.message).toMatch(/leaves out freight_quote/);
  });

  it("defaults the due date and caps it", () => {
    expect(input().due).toBe("5 days");
    expect(dueProblem("5 days")).toBeNull();
    expect(dueProblem("30 minutes")).toBe("give the person at least an hour");
    expect(dueProblem("5 weeks")).toBe("at most 30 days");
  });
});

describe("answers", () => {
  const rich = FormDefinition.parse({
    title: "Variance on travel",
    questions: [
      { id: "why", label: "Why", type: "long_text", required: true },
      { id: "amount", label: "Amount", type: "money" },
      { id: "when", label: "Reverses in", type: "date" },
      { id: "repeat", label: "Will it repeat?", type: "yes_no" },
      {
        id: "reason",
        label: "Reason",
        type: "choice",
        other: true,
        options: [
          { id: "timing", label: "Timing" },
          { id: "one_off", label: "One-off" },
        ],
      },
      {
        id: "tags",
        label: "Tags",
        type: "choices",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
      { id: "support", label: "Support", type: "files", max: 1 },
      {
        id: "lines",
        label: "Lines",
        type: "rows",
        min: 1,
        columns: [
          { id: "item", label: "Item", type: "text", required: true },
          { id: "cost", label: "Cost", type: "money" },
        ],
      },
    ],
  });

  it("takes values of each kind", () => {
    const answers = {
      why: "Denver trade show",
      amount: "3180.50",
      when: "2026-12-01",
      repeat: false,
      reason: { other: "Booked early" },
      tags: ["a", "b"],
      support: [{ documentId: "d1", filename: "quote.pdf" }],
      lines: [{ item: "Booth", cost: "2500" }],
    };
    expect(answerProblems(rich, answers, { final: true })).toEqual([]);
    expect(documentsOf(rich, answers)).toEqual(["d1"]);
  });

  it("names what is wrong, and what is missing only on sending", () => {
    const answers = {
      amount: "3,180",
      when: "2026-02-30",
      repeat: "no",
      reason: "late",
      tags: ["a", "a"],
      support: [
        { documentId: "d1", filename: "a.pdf" },
        { documentId: "d2", filename: "b.pdf" },
      ],
      lines: [{ cost: "x", extra: 1 }],
      nope: "x",
    };
    const draft = answerProblems(rich, answers, { final: false });
    expect(draft.map((p) => `${p.question}: ${p.message}`)).toEqual([
      "nope: the form has no such question",
      "amount: a number, like 1250.50",
      "when: a date",
      "repeat: yes or no",
      "reason: pick one of the options",
      "tags: each option at most once",
      "support: at most 1 files",
      "lines.0.extra: no such column",
      "lines.0.cost: a number, like 1250.50",
    ]);
    const sent = answerProblems(rich, { lines: [] }, { final: true });
    expect(sent.map((p) => p.question)).toEqual(["why", "lines"]);
    expect(answerProblems(rich, { lines: [{}] }, { final: true }).map((p) => p.question)).toEqual([
      "why",
      "lines.0.item",
    ]);
    expect(answerProblems(rich, [], { final: false })[0]?.message).toMatch(/an object/);
  });

  it("keeps answers clean and splits the required from the added", () => {
    const clean = cleanAnswers(rich, { why: "  Show  ", amount: "", tags: [] });
    expect(clean).toEqual({ why: "Show" });
    expect(splitAnswers({ po_number: "PO-7", note: "x" }, ask())).toEqual({
      answers: { po_number: "PO-7" },
      extra: { note: "x" },
    });
  });

  it("names the event a request waits on", () => {
    expect(formEventType("0190a0b0-0000-7000-8000-000000000001")).toBe(
      "form-0190a0b0000070008000000000000001",
    );
  });
});
