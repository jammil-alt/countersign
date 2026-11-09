// The reconciliation engine (docs/plan.md §1.80): matching in invariant 7's order, ambiguity left to
// a person, groups, the roll-forward and residual checks in decimal, labels, carried items.

import { describe, expect, it } from "vitest";
import { DEFAULT_RECON_SETTINGS, normalizeReference, type ReconSide, reconcile } from "./engine";

const side = (
  label: string,
  closing: string,
  items: ReconSide["items"],
  opening: string | null = null,
): ReconSide => ({
  label,
  opening,
  closing,
  items,
});

describe("normalizeReference", () => {
  it("compares references on their letters and digits", () => {
    expect(normalizeReference("CHK #1042")).toBe("chk1042");
    expect(normalizeReference("po_77")).toBe("po77");
    expect(normalizeReference("#1")).toBeNull();
    expect(normalizeReference(null)).toBeNull();
  });
});

describe("reconcile", () => {
  it("balances two sides whose items all match, by reference first, then by amount and date", () => {
    const bank = side(
      "Bank",
      "1000.00",
      [
        { ref: "b1", date: "2026-10-03", effect: "-120.00", reference: "CHK 1042" },
        { ref: "b2", date: "2026-10-10", effect: "500.00" },
        { ref: "b3", date: "2026-10-12", effect: "-80.00" },
      ],
      "700.00",
    );
    const books = side(
      "QuickBooks",
      "1000.00",
      [
        { ref: "q1", date: "2026-10-01", effect: "-120.00", reference: "chk-1042" },
        { ref: "q2", date: "2026-10-09", effect: "500.00" },
        { ref: "q3", date: "2026-10-12", effect: "-80.00" },
      ],
      "700.00",
    );
    const r = reconcile(bank, books, DEFAULT_RECON_SETTINGS, "2026-10-31");
    expect(r.outcome).toBe("balanced");
    expect(r.residual).toBe("0.0000");
    // The cheque by its number first; the rest by amount and date.
    expect(r.matches.map((m) => [m.method, m.a, m.b])).toEqual([
      ["exact", [0], [0]],
      ["amount_date", [1], [1]],
      ["amount_date", [2], [2]],
    ]);
    expect(r.rollForward).toEqual({ a: { gap: "0.0000" }, b: { gap: "0.0000" } });
  });

  it("explains a difference with a deposit in transit, labelled timing", () => {
    const bank = side(
      "Bank",
      "1000.00",
      [{ ref: "b1", date: "2026-10-10", effect: "-80.00" }],
      "1080.00",
    );
    const books = side(
      "QuickBooks",
      "1250.00",
      [
        { ref: "q1", date: "2026-10-10", effect: "-80.00" },
        { ref: "q2", date: "2026-10-31", effect: "250.00", description: "Deposit, Smith job" },
      ],
      "1080.00",
    );
    const r = reconcile(bank, books, DEFAULT_RECON_SETTINGS, "2026-10-31");
    expect(r).toMatchObject({ outcome: "explained", difference: "-250.0000", residual: "0.0000" });
    expect([...r.unmatched.b]).toEqual([[1, "timing"]]);
  });

  it("names what the items can't explain: an unexplained residual", () => {
    const bank = side("Bank", "1000.00", [], "1000.00");
    const books = side("QuickBooks", "990.00", [], "1000.00");
    // The books' items are missing: opening 1000 to closing 990 with nothing between.
    const r = reconcile(bank, books, DEFAULT_RECON_SETTINGS, "2026-10-31");
    expect(r.outcome).toBe("unexplained");
    expect(r.residual).toBe("10.0000");
    expect(r.rollForward.b.gap).toBe("10.0000");
  });

  it("leaves two equal candidates to a person rather than guess", () => {
    const bank = side("Bank", "-100.00", [
      { ref: "b1", date: "2026-10-05", effect: "-50.00" },
      { ref: "b2", date: "2026-10-06", effect: "-50.00" },
    ]);
    const books = side("QuickBooks", "-50.00", [
      { ref: "q1", date: "2026-10-05", effect: "-50.00" },
    ]);
    const r = reconcile(bank, books);
    expect(r.matches).toEqual([]);
    expect(r.unmatched.a.size).toBe(2);
    // Still arithmetic: the residual is 0, explained by the leftovers.
    expect(r.outcome).toBe("explained");
  });

  it("matches a payout deposit to its statement's charges, refund and fee as one group", () => {
    const deposit = side("Bank deposit", "958.70", [
      { ref: "dep", date: "2026-11-04", effect: "958.70", reference: "po_1Q2" },
    ]);
    const payout = side("Payout statement", "958.70", [
      { ref: "l1", date: "2026-11-02", effect: "600.00" },
      { ref: "l2", date: "2026-11-02", effect: "400.00" },
      { ref: "l3", date: "2026-11-03", effect: "-12.00" },
      { ref: "l4", date: "2026-11-03", effect: "-29.30" },
    ]);
    const r = reconcile(deposit, payout);
    expect(r.matches).toEqual([{ method: "group", a: [0], b: [0, 1, 2, 3] }]);
    expect(r.outcome).toBe("balanced");
  });

  it("finds no group when two different groups would fit", () => {
    const a = side("A", "30.00", [{ ref: "a", date: "2026-11-04", effect: "30.00" }]);
    const b = side("B", "60.00", [
      { ref: "x", date: "2026-11-04", effect: "10.00" },
      { ref: "y", date: "2026-11-04", effect: "20.00" },
      { ref: "z", date: "2026-11-04", effect: "15.00" },
      { ref: "w", date: "2026-11-04", effect: "15.00" },
    ]);
    const r = reconcile(a, b);
    expect(r.matches).toEqual([]);
  });

  it("keeps dates apart beyond the window, and needs a tolerance to match amounts that differ", () => {
    const a = side("A", "10.00", [{ ref: "a", date: "2026-10-01", effect: "10.00" }]);
    const b = side("B", "10.00", [{ ref: "b", date: "2026-10-20", effect: "10.00" }]);
    expect(reconcile(a, b).matches).toEqual([]);
    const c = side("C", "10.01", [{ ref: "c", date: "2026-10-01", effect: "10.01" }]);
    const d = side("D", "10.00", [{ ref: "d", date: "2026-10-01", effect: "10.00" }]);
    expect(reconcile(c, d).matches).toEqual([]);
    expect(reconcile(c, d, { ...DEFAULT_RECON_SETTINGS, tolerance: "0.01" }).matches).toHaveLength(
      1,
    );
  });

  it("labels a reference on both sides with different amounts, and a duplicate", () => {
    const a = side("Bank", "-245.00", [
      { ref: "a1", date: "2026-10-03", effect: "-200.00", reference: "INV 5531" },
      { ref: "a2", date: "2026-10-08", effect: "-45.00", reference: "SUB 77" },
    ]);
    const b = side("QuickBooks", "-290.00", [
      { ref: "b1", date: "2026-10-03", effect: "-195.00", reference: "inv-5531" },
      { ref: "b2", date: "2026-10-01", effect: "-47.50" },
      { ref: "b3", date: "2026-10-01", effect: "-47.50" },
    ]);
    const r = reconcile(a, b, DEFAULT_RECON_SETTINGS, "2026-10-31");
    expect(r.unmatched.a.get(0)).toBe("amount_differs");
    expect(r.unmatched.b.get(0)).toBe("amount_differs");
    expect(r.unmatched.b.get(1)).toBe("missing");
    expect(r.unmatched.b.get(2)).toBe("duplicate");
    expect(r.outcome).toBe("explained");
  });

  it("clears last month's deposit in transit against this month's bank deposit", () => {
    // October left $250 on the books, not yet at the bank. November: it reaches the bank.
    const bank = side(
      "Bank",
      "1250.00",
      [{ ref: "b1", date: "2026-11-02", effect: "250.00" }],
      "1000.00",
    );
    const books = side(
      "QuickBooks",
      "1250.00",
      [{ ref: "q-carried", date: "2026-10-31", effect: "250.00", carried: true }],
      "1250.00",
    );
    const r = reconcile(bank, books, DEFAULT_RECON_SETTINGS, "2026-11-30");
    expect(r.matches).toEqual([{ method: "amount_date", a: [0], b: [0] }]);
    expect(r).toMatchObject({ startGap: "0.0000", residual: "0.0000", outcome: "balanced" });
    // Carried items don't count in a side's own roll-forward.
    expect(r.rollForward.b.gap).toBe("0.0000");
  });
});
