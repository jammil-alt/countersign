import { describe, expect, it } from "vitest";
import { brief, saysMore } from "./brief";

describe("brief", () => {
  it("keeps a short description as it is, with a full stop", () => {
    expect(brief("Send email from your Gmail")).toBe("Send email from your Gmail.");
    expect(brief("Send email from your Gmail.")).toBe("Send email from your Gmail.");
    expect(saysMore("Send email from your Gmail.")).toBe(false);
    expect(saysMore("Send email from your Gmail", "Send email from your Gmail.")).toBe(false);
  });

  it("takes the first sentence, without asides, field names or the list after a colon", () => {
    const text =
      "One site's figures for a week (the last 7 finished days unless you give `period` 28) against the period before: visits, page views, goals. `written` has every figure. Cite `sourcesIds`.";
    expect(brief(text)).toBe("One site's figures for a week against the period before.");
    expect(saysMore(text)).toBe(true);
    expect(saysMore(text, "A week of figures.")).toBe(true);
  });

  it("doesn't end a sentence at an abbreviation", () => {
    expect(brief("File it under a path template, e.g. Bills/2026. Then stop.")).toBe(
      "File it under a path template, e.g. Bills/2026.",
    );
  });

  it("ends a sentence before a field name", () => {
    expect(brief("A document and its reading. `as: quote` reads a quote.")).toBe(
      "A document and its reading.",
    );
  });

  it("keeps a short headline whole rather than cutting at an early colon", () => {
    expect(brief("Reads: the bills")).toBe("Reads: the bills.");
  });

  it("cuts a long line at a clause or a word, with an ellipsis", () => {
    const long =
      "Bills, purchases, purchase orders, vendors, items, accounts, classes, attachments, invoices, customers and payments in your QuickBooks Online";
    const out = brief(long, 60);
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/,…$/);
  });

  it("is empty for no description", () => {
    expect(brief("")).toBe("");
    expect(brief(null)).toBe("");
  });
});
