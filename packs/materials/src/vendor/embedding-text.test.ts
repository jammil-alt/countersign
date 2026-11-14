// The one embedding template (docs/plan.md §1.88): name + description + specs, the same labels and
// order for master items, vendor items and open lines; empty fields out; prices, quantities, dates
// and order or shipping terms stripped; capped.

import { describe, expect, it } from "vitest";
import { parseLine } from "../catalog/keys";
import { EMBEDDING_TEXT_MAX_WORDS, embeddingText, specsText, stripTerms } from "./embedding-text";
import { lineEmbeddingText, masterText, openLineEmbeddingText, vendorItemText } from "./pipeline";

describe("the embedding template", () => {
  it("is Name, Description and Specs, in that order, empty fields left out", () => {
    const p = parseLine('BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB');
    expect(
      embeddingText({
        name: "BB34-55 Baltic birch 5x5",
        description: "Baltic birch plywood, B/BB faces",
        category: p.category,
        attributes: p.attributes,
      }),
    ).toBe(
      [
        "Name: BB34-55 Baltic birch 5x5",
        "Description: Baltic birch plywood, B/BB faces",
        "Specs: category sheet goods; material plywood; face baltic birch; core all ply; thickness 3/4in (19mm); size 60x60in; grade bb/bb; finish unfinished; cut rotary; spec standard",
      ].join("\n"),
    );
    expect(embeddingText({ name: "WALNUT 4/4 FAS" })).toBe("Name: WALNUT 4/4 FAS");
    expect(embeddingText({ name: "", description: "", category: null })).toBe("");
    // A description that repeats the name is left out.
    expect(embeddingText({ name: "Walnut 4/4", description: "WALNUT 4/4" })).toBe(
      "Name: Walnut 4/4",
    );
  });

  it("writes the specs in the category's key order, units normalized, packaging left out", () => {
    expect(
      specsText("hardware", { pack_size: "50", model: "71B3550", brand: "blum", kind: "hinge" }),
    ).toBe("category hardware; brand blum; model 71b3550; kind hinge");
    expect(
      specsText("sheet_goods", { thickness: "3/4in", thickness_mm: "18", grade: "none" }),
    ).toBe("category sheet goods; thickness 3/4in (18mm)");
    expect(specsText("mouldings", { thickness_mm: "2" })).toBe("category mouldings; thickness 2mm");
    expect(specsText(null, null)).toBe("");
  });

  it("strips prices, quantities, dates and order or shipping terms, and nothing the item is", () => {
    expect(
      stripTerms(
        'BB PLY 3/4" 4X8 QTY 40 @ $68.50/SHT PO# 7781 ship via UPS 11/02/2026 Net 30 FOB origin, freight included',
      ),
    ).toBe('BB PLY 3/4" 4X8');
    expect(stripTerms("HINGE BLUM 71B3550 BOX OF 50, 2026-11-02, 12.40/EA, USD 9.80")).toBe(
      "HINGE BLUM 71B3550",
    );
    expect(stripTerms("Screws 100/box, shipped 12, Nov 2, 2026, invoice # A-17")).toBe("Screws");
    // Sizes, fractions, threads, thicknesses and words that only start like a month stay.
    expect(stripTerms('1/4-20 x 2" bolt, 1-1/2 in, .75 18MM 4X8 Marine 12')).toBe(
      '1/4-20 x 2" bolt, 1-1/2 in, .75 18MM 4X8 Marine 12',
    );
  });

  it("never takes a grade or a fraction for a labelled price", () => {
    // The EXT grade and a fraction after a price word stay whole.
    expect(stripTerms("CDX PLYWOOD EXT 3/4 4X8")).toBe("CDX PLYWOOD EXT 3/4 4X8");
    expect(stripTerms("BIRCH 3/4 4X8 TOTAL 5/8 EDGE")).toBe("BIRCH 3/4 4X8 TOTAL 5/8 EDGE");
    expect(stripTerms("CDX EXT 1/2 PRICE 3/4")).toBe("CDX EXT 1/2 PRICE 3/4");
    // A labelled price still goes, whole or with cents.
    expect(stripTerms("CDX PLYWOOD EXT 3/4 4X8 PRICE: 41.20 TOTAL 1648")).toBe(
      "CDX PLYWOOD EXT 3/4 4X8",
    );
    expect(stripTerms("OAK 4/4 EXT: $980.00 cost 12")).toBe("OAK 4/4");
    expect(stripTerms("OAK 4/4 extended price $980.00")).toBe("OAK 4/4");
  });

  it(`caps the text at ${EMBEDDING_TEXT_MAX_WORDS} words, cutting the description first`, () => {
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    const text = embeddingText({
      name: "Walnut 4/4 FAS",
      description: long,
      category: "hardwood",
      attributes: { species: "walnut" },
    });
    expect(text.split(/\s+/).length).toBe(EMBEDDING_TEXT_MAX_WORDS);
    expect(text.startsWith("Name: Walnut 4/4 FAS\nDescription: w0 w1")).toBe(true);
    expect(text.endsWith("Specs: category hardwood; species walnut")).toBe(true);
    const longName = embeddingText({ name: long });
    expect(longName.split(/\s+/).length).toBe(EMBEDDING_TEXT_MAX_WORDS);
  });

  it("is the same template for a master item, a vendor item and an open line", () => {
    const text = 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB';
    const p = parseLine(text);
    const master = masterText({ name: text, category: p.category, attributes: p.attributes });
    const vendor = vendorItemText(
      { name: "BB34-55 BALTIC BIRCH 5X5", description: "QTY 40 @ $68.50" },
      { category: p.category, attributes: p.attributes },
    );
    const line = openLineEmbeddingText("BB PLY 18MM 5X5 $66.00");
    for (const t of [master, vendor, line]) {
      expect(t).toMatch(/^Name: .+\nSpecs: category sheet goods; material plywood; face baltic/);
    }
    // The vendor's description was only a quantity and a price: nothing of it is left.
    expect(vendor).not.toContain("Description");
    expect(line).toContain("Name: BB PLY 18MM 5X5\n");
    expect(line).toContain("thickness 3/4in (18mm)");
    expect(lineEmbeddingText("Cherry 4/4", { category: "hardwood", attributes: {} })).toBe(
      "Name: Cherry 4/4\nSpecs: category hardwood",
    );
  });
});
