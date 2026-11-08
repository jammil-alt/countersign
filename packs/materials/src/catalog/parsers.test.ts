// Parser tables (docs/plan.md §4 M8): the spellings vendors use, each read to one value.

import { describe, expect, it } from "vitest";
import { compareKeys, keySignature, parseLine, scorePair } from "./keys";
import { descriptionHash, normalize } from "./normalize";
import { findSheetSize, findThickness, nominalThickness } from "./units";

const thicknessOf = (raw: string) => findThickness(normalize(raw).split(" "))?.thickness;
const sizeOf = (raw: string) => findSheetSize(normalize(raw).split(" "))?.size;

describe("normalize", () => {
  it.each([
    ['3/4" BB PLY 4 X 8', '3/4" BALTIC BIRCH PLYWOOD 4X8'],
    ["3/4 bb/bb baltic birch, 5x5", "3/4 BB/BB BALTIC BIRCH 5X5"],
    ["18 mm Balt. Birch (B/BB) 1525 x 1525 mm", "18MM BALTIC BIRCH B/BB 1525X1525MM"],
    ["Titebond II  Premium Wood Glue - 1 Gal.", "TITEBOND II PREMIUM WOOD GLUE 1GALLON"],
    ["4/4 RO FAS RGH", "4/4 RED OAK FAS ROUGH"],
    ["3/4 WHT MEL PB 49X97", "3/4 WHITE MELAMINE PARTICLEBOARD 49X97"],
    ["Board Feet", "BF"],
  ])("%s → %s", (raw, expected) => {
    expect(normalize(raw)).toBe(expected);
  });

  it("is idempotent and applies a vendor's own abbreviations", () => {
    const once = normalize('3/4" BB PLY 4 X 8');
    expect(normalize(once)).toBe(once);
    expect(normalize("3/4 NBB 5X5", { abbreviations: { nbb: "baltic birch" } })).toBe(
      "3/4 BALTIC BIRCH 5X5",
    );
  });

  it("hashes the normalized text with sha256", async () => {
    expect(await descriptionHash("ABC")).toBe(
      "b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78",
    );
  });
});

describe("sheet thickness", () => {
  it.each([
    ['3/4"', "3/4in", "19"],
    ["3/4", "3/4in", "19"],
    ["3/4IN", "3/4in", "19"],
    [".75", "3/4in", "19"],
    ['0.75"', "3/4in", "19"],
    ["18MM", "3/4in", "18"],
    ["18 mm", "3/4in", "18"],
    ["19mm", "3/4in", "19"],
    ["23/32", "3/4in", "18.3"],
    ["1/2", "1/2in", "12.7"],
    ["15/32", "1/2in", "11.9"],
    ["12MM", "1/2in", "12"],
    ["5/8", "5/8in", "15.9"],
    ["15mm", "5/8in", "15"],
    ["1/4", "1/4in", "6.4"],
    ["6MM", "1/4in", "6"],
    ["5.2MM", "1/4in", "5.2"],
    ["9mm", "3/8in", "9"],
    ['1"', "1in", "25.4"],
    ["1-1/2", "1-1/2in", "38.1"],
  ])("%s → %s (actual %s mm)", (raw, nominal, mm) => {
    expect(thicknessOf(raw)).toEqual({ nominal, actualMm: mm });
  });

  it.each(["4/4", "8/4", "BB/BB", "4", "4 SHEETS", "45MM"])(
    "%s is not a sheet thickness",
    (raw) => {
      expect(thicknessOf(raw)).toBeUndefined();
    },
  );

  it("reads nothing far from a nominal", () => {
    expect(nominalThickness(0.31)).toBeNull();
  });
});

describe("sheet size", () => {
  it.each([
    ["4X8", "48x96in"],
    ["4 x 8", "48x96in"],
    ["48X96", "48x96in"],
    ["48 x 96", "48x96in"],
    ["4'X8'", "48x96in"],
    ["4' x 8'", "48x96in"],
    ['48"X96"', "48x96in"],
    ["96X48", "48x96in"],
    ["1220X2440MM", "48x96in"],
    ["1220 x 2440", "48x96in"],
    ["5X5", "60x60in"],
    ["60X60", "60x60in"],
    ["1525X1525MM", "60x60in"],
    ["49X97", "49x97in"],
    ["4X10", "48x120in"],
    ["3/4X4X8", "48x96in"],
  ])("%s → %s", (raw, size) => {
    expect(sizeOf(raw)).toBe(size);
  });
});

describe("sheet goods", () => {
  it.each([
    [
      '3/4" BALTIC BIRCH B/BB 5X5',
      {
        material: "plywood",
        face: "baltic_birch",
        grade: "b/bb",
        thickness: "3/4in",
        size: "60x60in",
        core: "all_ply",
        finish: "unfinished",
      },
    ],
    [
      "18MM BB/BB BALTIC BIRCH PLYWOOD 1525X1525",
      { grade: "bb/bb", thickness: "3/4in", size: "60x60in" },
    ],
    [
      "3/4 MAPLE PLY VC A1 4X8",
      { material: "plywood", face: "maple", core: "veneer", grade: "a1", size: "48x96in" },
    ],
    ["3/4 PREFINISHED MAPLE PLY 4X8 A-1 UV2S", { finish: "prefinished", grade: "a1" }],
    [
      "3/4 WHT MEL PB 49X97",
      {
        material: "melamine",
        face: "white",
        core: "particleboard",
        size: "49x97in",
        finish: "none",
      },
    ],
    ["3/4 MDF 4X8", { material: "mdf", face: "none", finish: "unfinished", thickness: "3/4in" }],
    ["3/4 RIFT WO PLY 4X8 A1 MDF CORE", { face: "white_oak", cut: "rift", core: "mdf" }],
    ["1/4 HARDBOARD 4X8", { material: "hardboard", thickness: "1/4in" }],
    ["3/4 MDF FR 4X8", { spec: "fire_rated" }],
  ])("%s", (raw, expected) => {
    const parsed = parseLine(raw);
    expect(parsed.category).toBe("sheet_goods");
    expect(parsed.attributes).toMatchObject(expected);
    expect(parsed.standardUom).toBe("sheet");
  });
});

describe("hardwood", () => {
  it.each([
    [
      "4/4 RED OAK FAS RGH",
      { species: "red_oak", thickness: "4/4", grade: "fas", surfacing: "rough" },
    ],
    [
      "8/4 HARD MAPLE SEL&BTR S2S",
      { species: "hard_maple", thickness: "8/4", grade: "sel_btr", surfacing: "s2s" },
    ],
    [
      "5/4 WALNUT #1 COMMON SL1E",
      { species: "walnut", thickness: "5/4", grade: "1c", surfacing: "s2s1e" },
    ],
    ["4/4 POPLAR 1COM S4S BF", { species: "poplar", grade: "1c", surfacing: "s4s" }],
    ["4/4 QS WHITE OAK FAS", { species: "white_oak", cut: "quartered" }],
  ])("%s", (raw, expected) => {
    const parsed = parseLine(raw);
    expect(parsed.category).toBe("hardwood");
    expect(parsed.attributes).toMatchObject(expected);
    expect(parsed.standardUom).toBe("board_foot");
  });
});

describe("hardware", () => {
  it.each([
    ["BLUM 71B3550 CLIP TOP HINGE 110 DEG", { brand: "blum", model: "71b3550", kind: "hinge" }],
    ["Blum Clip Top 110 deg Hinge 71B3550 BX/50", { model: "71b3550", pack_size: "50" }],
    ["BLUM TANDEM 563H5330B 21IN SLIDE", { model: "563h5330b", size: "21in", kind: "slide" }],
    ["ACCURIDE 3832 22IN FULL EXT SLIDE", { brand: "accuride", model: "3832", size: "22in" }],
    ['KV 8800 22" SLIDE', { brand: "knape_vogt", model: "8800", size: "22in" }],
    ["AMEROCK BP53010SN PULL 3IN SATIN NICKEL", { brand: "amerock", finish: "satin_nickel" }],
    [
      "TOP KNOBS M1234 PULL 128MM ORB",
      { brand: "top_knobs", size: "128mm", finish: "oil_rubbed_bronze" },
    ],
  ])("%s", (raw, expected) => {
    const parsed = parseLine(raw);
    expect(parsed.category).toBe("hardware");
    expect(parsed.attributes).toMatchObject(expected);
  });
});

describe("mouldings and edgebanding (basic)", () => {
  it.each([
    [
      "15/16 X .5MM WHITE PVC EDGEBANDING 600FT",
      {
        kind: "edgebanding",
        material: "pvc",
        face: "white",
        width: "24mm",
        thickness: "0.5mm",
        length_ft: "600",
      },
    ],
    [
      "EB 7/8 MAPLE WOOD VENEER 250'",
      { kind: "edgebanding", material: "veneer", face: "maple", width: "22mm" },
    ],
    ["22MM X 1MM BLACK PVC EDGE BANDING", { width: "22mm", thickness: "1mm" }],
    ["WM366 PRIMED MDF CASING 16FT", { kind: "moulding", profile: "wm366", material: "mdf" }],
    [
      "POPLAR CROWN 3/4 X 3-1/2",
      { kind: "moulding", profile: "crown", material: "poplar", width: "89mm", thickness: "19mm" },
    ],
  ])("%s", (raw, expected) => {
    const parsed = parseLine(raw);
    expect(parsed.category).toBe("mouldings");
    expect(parsed.attributes).toMatchObject(expected);
    expect(parsed.standardUom).toBe("linear_foot");
  });
});

describe("finishes and adhesives (basic)", () => {
  it.each([
    [
      "TITEBOND II PREMIUM WOOD GLUE 1 GAL",
      { kind: "adhesive", brand: "titebond", product: "2 premium", container: "1 gallon" },
    ],
    ["Titebond 2 Premium Wood Glue - Gallon", { brand: "titebond", product: "2 premium" }],
    [
      "ML CAMPBELL MAGNAMAX 35 SHEEN 5 GAL",
      { brand: "ml_campbell", product: "magnamax", sheen: "35_sheen", container: "5 gallon" },
    ],
    [
      "SHERWIN WILLIAMS KEM AQUA SATIN LACQUER QT",
      { brand: "sherwin_williams", sheen: "satin", kind: "finish" },
    ],
  ])("%s", (raw, expected) => {
    const parsed = parseLine(raw);
    expect(parsed.category).toBe("finishes");
    expect(parsed.attributes).toMatchObject(expected);
  });
});

describe("key attributes", () => {
  it("Baltic birch three ways is one signature", () => {
    const sigs = [
      "3/4 BB/BB BALTIC BIRCH 5X5",
      "BALTIC BIRCH PLYWOOD 18MM BB/BB 60X60",
      'BIRCH BALTIC 3/4" 1525X1525MM BB/BB',
    ].map((raw) => {
      const p = parseLine(raw);
      return keySignature(p.category, p.attributes);
    });
    expect(new Set(sigs).size).toBe(1);
    expect(sigs[0]).toContain("thickness=3/4in");
  });

  it.each([
    ["3/4 BB/BB BALTIC BIRCH 5X5", "1/2 BB/BB BALTIC BIRCH 5X5", "thickness"],
    ["3/4 BB/BB BALTIC BIRCH 5X5", "3/4 B/BB BALTIC BIRCH 5X5", "grade"],
    ["3/4 MAPLE PLY A1 VC 4X8", "3/4 MAPLE PLY A1 VC 5X5", "size"],
    ["3/4 MAPLE PLY A1 VC 4X8", "3/4 PREFINISHED MAPLE PLY A1 VC 4X8", "finish"],
    ["BLUM 71B3550 HINGE", "BLUM 71B3590 HINGE", "model"],
  ])("%s vs %s differ on %s (veto)", (a, b, hinge) => {
    const score = scorePair(parseLine(a), parseLine(b));
    expect(score.confidence).toBe(0);
    expect(score.hinge).toBe(hinge);
  });

  it("an attribute only one side states keeps the match below the threshold", () => {
    const a = parseLine("3/4 BALTIC BIRCH BB/BB 5X5");
    const b = parseLine("3/4 BALTIC BIRCH 5X5");
    const c = compareKeys(a, b);
    expect(c.oneSided).toContain("grade");
    expect(scorePair(a, b).confidence).toBeLessThan(0.9);
  });

  it("a description that names no category is never matched by rules", () => {
    const p = parseLine("FREIGHT CHARGE");
    expect(p.category).toBe("other");
    expect(p.complete).toBe(false);
    expect(scorePair(p, p).confidence).toBeLessThan(0.9);
  });
});
