import { describe, expect, it } from "vitest";
import { type Step, stepStateLabel } from "../schemas/workflow";
import { changeSubject, RunSubject } from "./run-subject";

describe("a run's subject", () => {
  it("reads a change through its tool's display, as the card heads it", () => {
    const subject = changeSubject(
      {
        name: { en: "QuickBooks bill", es: "Factura de QuickBooks" },
        number: "before.docNumber",
        subject: "before.vendor",
        fields: [],
      },
      "QuickBooks",
      { docNumber: "20418", vendor: { id: "56", name: "Northline Panel Supply" } },
      { id: "146" },
    );
    expect(subject).toEqual({
      kind: "change",
      name: { en: "QuickBooks bill", es: "Factura de QuickBooks" },
      number: "20418",
      with: "Northline Panel Supply",
    });
    expect(RunSubject.parse(subject)).toEqual(subject);
  });

  it("falls back to the connector and the record's own name without a display", () => {
    expect(changeSubject(null, "Testkit", { id: "r1", name: "Oak board" }, {})).toEqual({
      kind: "change",
      name: "Testkit",
      number: null,
      with: "Oak board",
    });
  });
});

describe("a step's name by its state", () => {
  const action = {
    id: "itemize",
    kind: "action",
    name: "Itemize the bill",
    tool: "qbo.bill.update_lines",
    input: {},
    client: { visible: true, label: "Itemized the bill" },
  } as unknown as Step;

  it("says what it does until it has run, then what it did", () => {
    expect(stepStateLabel(action, false)).toBe("Itemize the bill");
    expect(stepStateLabel(action, true)).toBe("Itemized the bill");
  });

  it("keeps a person step's label in every state", () => {
    const person = { ...action, kind: "person", client: { visible: true, label: "Ana checks" } };
    expect(stepStateLabel(person as unknown as Step, false)).toBe("Ana checks");
  });
});
