import { describe, expect, it } from "vitest";
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
