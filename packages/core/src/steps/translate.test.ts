import { describe, expect, it } from "vitest";
import type { Field } from "./schema";
import { DoStep, Workflow } from "./schema";
import {
  applyTranslation,
  describeExpr,
  requiredInputFrom,
  sourceKey,
  stateWords,
  type TranslateSource,
  translateStep,
  withSuggestions,
  workOutTranslation,
} from "./translate";
import { validateWorkflow } from "./validate";

const f = (name: string, type: Field["type"], required = true, of?: Field[]): Field => ({
  name,
  type,
  required,
  ...(of ? { of } : {}),
});

const read: TranslateSource = {
  ref: "steps.read-1.output",
  label: "Read the invoice",
  fields: [
    f("header", "group", true, [
      f("supplier", "text"),
      f("invoiceNo", "text"),
      f("total", "number"),
    ]),
    f("currency", "text"),
    f("lines", "list", true, [f("desc", "text"), f("qty", "number"), f("amount", "number")]),
  ],
};
const trigger: TranslateSource = {
  ref: "trigger",
  label: "Trigger",
  fields: [f("documentId", "record"), f("memo", "text", false)],
};

describe("workOutTranslation", () => {
  it("fits when a source hands on the same name and type: read directly, no translation", () => {
    const w = workOutTranslation({
      needs: [f("currency", "text"), f("documentId", "record")],
      sources: [trigger, read],
    });
    expect(w.state).toBe("fits");
    expect(w.translation).toBeUndefined();
    expect(w.input).toEqual({
      currency: "{{steps.read-1.output.currency}}",
      documentId: "{{trigger.documentId}}",
    });
    expect(w.fields.map((x) => x.state)).toEqual(["fits", "fits"]);
    expect(w.fields[0]?.from).toBe("Read the invoice › currency");
  });

  // Staging, 2026-11-27: a customer search's optional `name` was filled from the sender's name on
  // every load, so the search only ever found customers named after the employee.
  it("leaves an optional field as the person left it, even with a same-named source", () => {
    const w = workOutTranslation({
      needs: [f("documentId", "record"), f("memo", "text", false)],
      sources: [trigger],
    });
    expect(w.input).toEqual({ documentId: "{{trigger.documentId}}" });
    expect(w.fields.map((x) => [x.name, x.state])).toEqual([
      ["documentId", "fits"],
      ["memo", "empty"],
    ]);
    // Set by the person, it stays.
    const kept = workOutTranslation({
      needs: [f("memo", "text", false)],
      sources: [trigger],
      input: { memo: "{{trigger.memo}}" },
    });
    expect(kept.input).toEqual({ memo: "{{trigger.memo}}" });
  });

  it("translates renames, money and lists, and brings the source in under a `_` key", () => {
    const w = workOutTranslation({
      needs: [
        f("vendorName", "text"),
        f("invoiceNumber", "text"),
        f("total", "money"),
        f("lines", "list", true, [f("description", "text"), f("quantity", "number")]),
      ],
      sources: [trigger, read],
    });
    expect(w.state).toBe("translated");
    const key = sourceKey(read.ref);
    expect(key).toBe("_read_1");
    expect(w.input).toEqual({ [key]: "{{steps.read-1.output}}" });
    const byName = Object.fromEntries((w.translation?.fields ?? []).map((x) => [x.name, x.from]));
    expect(byName.vendorName).toEqual({ input: "_read_1.header.supplier" });
    expect(byName.invoiceNumber).toEqual({ input: "_read_1.header.invoiceNo" });
    // A number into money is written as money, a decimal string (invariant 6).
    expect(byName.total).toEqual({ formatMoney: { value: { input: "_read_1.header.total" } } });
    expect(byName.lines).toEqual({
      mapList: {
        list: { input: "_read_1.lines" },
        fields: { description: { item: "desc" }, quantity: { item: "qty" } },
      },
    });
    expect(stateWords(w.fields[0] as never)).toBe(
      "Translated: from Read the invoice › header › supplier (renamed)",
    );
  });

  it("says Doesn't fit for a required field nothing gives, and leaves an optional one empty", () => {
    const w = workOutTranslation({
      needs: [f("taxId", "text"), f("notesForAp", "text", false)],
      sources: [read],
    });
    expect(w.state).toBe("doesnt_fit");
    expect(w.fields.map((x) => x.state)).toEqual(["doesnt_fit", "empty"]);
    expect(w.translation).toBeUndefined();
    expect(w.input).toEqual({});
  });

  it("keeps what the person set: a field picked by hand and a fixed value", () => {
    const w = workOutTranslation({
      needs: [f("vendorName", "text"), f("terms", "text")],
      sources: [read],
      input: { vendorName: "{{steps.read-1.output.header.invoiceNo}}", terms: "Net 30" },
    });
    expect(w.input).toEqual({
      vendorName: "{{steps.read-1.output.header.invoiceNo}}",
      terms: "Net 30",
    });
    expect(w.fields.map((x) => [x.state, x.how])).toEqual([
      ["fits", "picked"],
      ["fits", "fixed"],
    ]);
  });

  it("drops a reference to a field the source no longer hands on, and works it out again", () => {
    const w = workOutTranslation({
      needs: [f("vendorName", "text")],
      sources: [read],
      input: { vendorName: "{{steps.read-1.output.header.gone}}" },
    });
    expect(w.fields[0]?.state).toBe("translated");
    expect(w.translation?.fields[0]?.from).toEqual({ input: "_read_1.header.supplier" });
  });

  it("is stable: working out a worked-out step changes nothing", () => {
    const needs = [f("vendorName", "text"), f("total", "money"), f("currency", "text")];
    const once = workOutTranslation({ needs, sources: [read] });
    const twice = workOutTranslation({
      needs,
      sources: [read],
      input: once.input,
      translation: once.translation,
    });
    expect(twice.input).toEqual(once.input);
    expect(twice.translation).toEqual(once.translation);
    expect(twice.fields.map((x) => x.state)).toEqual(once.fields.map((x) => x.state));
  });

  it("leaves a step that takes nothing known as it is", () => {
    const w = workOutTranslation({ needs: [], sources: [read], input: { anything: "x" } });
    expect(w).toEqual({ input: { anything: "x" }, fields: [], state: "fits" });
  });
});

describe("withSuggestions", () => {
  it("adds the AI's fills for what is left, without confirming", () => {
    const needs = [f("vendorName", "text"), f("dueIn", "number")];
    const w = workOutTranslation({ needs, sources: [read] });
    expect(w.state).toBe("doesnt_fit");
    const next = withSuggestions(w, { dueIn: { value: 30 } }, needs, [read]);
    expect(next.state).toBe("translated");
    expect(next.fields[1]).toMatchObject({ state: "translated", how: "ai", from: "30" });
    expect(next.translation?.fields.map((x) => x.name)).toEqual(["vendorName", "dueIn"]);
  });
});

describe("translateStep and the publish check", () => {
  const needs = [f("vendorName", "text"), f("taxId", "text")];
  const uses = { type: "action" as const, action: "qbo.vendor.create" };
  const step = DoStep.parse({
    id: "make",
    kind: "do",
    name: "Make the vendor",
    doneBy: "rules",
    uses,
  });

  it("returns the same step when nothing changes", () => {
    const first = translateStep(step, needs, [read]).step;
    expect(translateStep(first, needs, [read]).step).toBe(first);
  });

  it("feeds validateWorkflow: only Doesn't fit is an input_missing issue", () => {
    const next = translateStep(step, needs, [read]).step;
    const wf = Workflow.parse({
      schemaVersion: 5,
      triggers: [{ id: "t1", on: { type: "event", event: "document.extracted" } }],
      outputs: [{ id: "o", name: "Nothing", kind: "nothing" }],
      steps: [next, { id: "end", kind: "end", name: "Done", outputs: ["o"] }],
    });
    const issues = validateWorkflow(wf, { requiredInput: requiredInputFrom(() => needs) });
    expect(issues.filter((i) => i.code === "input_missing").map((i) => i.message)).toEqual([
      'Doesn\'t fit: nothing gives "taxId", which this step needs.',
    ]);
  });
});

describe("applyTranslation", () => {
  it("runs the translation as code before the engine: sources dropped, money decimal", () => {
    const needs = [f("vendorName", "text"), f("total", "money"), f("currency", "text")];
    const w = workOutTranslation({ needs, sources: [read] });
    const resolved = {
      currency: "USD",
      _read_1: { header: { supplier: "Acme", invoiceNo: "7", total: 0.1 + 0.2 }, currency: "USD" },
    };
    const out = applyTranslation({ translation: w.translation }, resolved, { today: "2026-11-25" });
    expect(out.problems).toEqual([]);
    expect(out.input).toEqual({ currency: "USD", vendorName: "Acme", total: "0.30" });
  });

  it("passes the input through without a translation, sources dropped", () => {
    expect(applyTranslation({}, { a: 1, _x: { b: 2 } }, { today: "2026-11-25" })).toEqual({
      input: { a: 1 },
      problems: [],
    });
  });

  it("reports a required field the data didn't have", () => {
    const w = workOutTranslation({ needs: [f("vendorName", "text")], sources: [read] });
    const out = applyTranslation(
      { translation: w.translation },
      { _read_1: {} },
      { today: "2026-11-25" },
    );
    expect(out.problems.map((p) => p.field)).toEqual(["vendorName"]);
  });
});

describe("describeExpr", () => {
  it("says an expression in words", () => {
    expect(describeExpr({ join: { values: [{ input: "_trigger.memo" }] } }, [trigger])).toBe(
      "Trigger › memo, joined",
    );
  });
});
