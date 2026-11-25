import { describe, expect, it } from "vitest";
import { offeredSpecs, SUPERSEDED_ACTIONS } from "./offered";

describe("offered actions", () => {
  const specs = [
    "docs.read",
    "docs.extract",
    "docs.reading.record",
    "docs.totals.check",
    "docs.bill.check",
    "ledger.accounts.list",
    "qbo.bill.create",
  ].map((id) => ({ id }));

  it("leaves out what the step model folded into another action", () => {
    expect(offeredSpecs(specs).map((s) => s.id)).toEqual([
      "docs.read",
      "ledger.accounts.list",
      "qbo.bill.create",
    ]);
    expect(SUPERSEDED_ACTIONS.has("docs.read")).toBe(false);
  });

  it("leaves out what the operator turned off on the connector's page", () => {
    expect(offeredSpecs(specs, new Set(["qbo.bill.create"])).map((s) => s.id)).toEqual([
      "docs.read",
      "ledger.accounts.list",
    ]);
  });
});
