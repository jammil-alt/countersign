// Unit conversion (ARCHITECTURE §12.3): each invoice unit to the item's standard unit, and no price
// without a rule (invariant 7).

import { describe, expect, it } from "vitest";
import { convert, packsIn, readUom } from "./uom";

describe("units", () => {
  it("reads invoice spellings", () => {
    expect(readUom("SHT")).toBe("sheet");
    expect(readUom("bd. ft.")).toBe("board_foot");
    expect(readUom("Gal")).toBe("gallon");
    expect(readUom("FURLONG")).toBeNull();
  });

  const cases: [string | null, string, Record<string, string>, string | null][] = [
    ["SHT", "sheet", {}, "1"],
    ["EA", "sheet", {}, "1"],
    [null, "sheet", {}, "1"],
    ["BF", "board_foot", {}, "1"],
    ["MBF", "board_foot", {}, "1000"],
    ["LF", "linear_foot", {}, "1"],
    ["ROLL", "linear_foot", { length_ft: "500" }, "500"],
    ["ROLL", "linear_foot", {}, null],
    ["BX", "each", { pack_size: "100" }, "100"],
    ["BX", "each", {}, null],
    ["PR", "each", {}, "2"],
    ["QT", "gallon", {}, "0.25"],
    ["EA", "gallon", { container: "5 gallon" }, "5"],
    ["PAIL", "gallon", { container: "1 quart" }, "0.25"],
    ["EA", "gallon", {}, null],
    ["GAL", "quart", {}, "4"],
    ["BF", "sheet", {}, null],
    ["SHT", "board_foot", {}, null],
    ["FURLONG", "sheet", {}, null],
  ];
  it.each(cases)("%s → %s %j: %s", (raw, std, attrs, factor) => {
    const c = convert(raw, std as Parameters<typeof convert>[1], attrs);
    if (factor === null) {
      expect(c.ok).toBe(false);
    } else {
      expect(c.ok && c.factor.toString()).toBe(factor);
    }
  });

  it("marks a missing unit as assumed", () => {
    const c = convert("", "sheet", {});
    expect(c.ok && c.assumed).toBe(true);
  });
});

describe("packsIn", () => {
  it("reads a pack only with its size, in the vendor's word", () => {
    expect(packsIn("#8 SCREW 100/BX")).toEqual([{ word: "box", size: "100" }]);
    expect(packsIn("SCREW CS/1000")).toEqual([{ word: "case", size: "1000" }]);
    expect(packsIn("box of 100 screws")).toEqual([{ word: "box", size: "100" }]);
    expect(packsIn("#10 SCREW CS 100")).toEqual([{ word: "case", size: "100" }]);
    expect(packsIn("16D BOX NAIL")).toEqual([]);
    expect(packsIn("#8 X 1-1/4 WOOD SCREW")).toEqual([]);
    expect(packsIn("BOX 3/4 PLY")).toEqual([]);
  });

  it("never reads a number that another pack or a measure follows as a pack's size", () => {
    expect(packsIn("#8 SCREW 100/BX 10 BX/CS")).toEqual([{ word: "box", size: "100" }]);
    expect(packsIn("PAIL 5 GAL")).toEqual([]);
    expect(packsIn("CAN 12 OZ")).toEqual([]);
    expect(packsIn("SPRAY PAINT CAN 12OZ")).toEqual([]);
    expect(packsIn("BOX NAIL 16D 50 LB")).toEqual([]);
    expect(packsIn("TAPE BOX 2 IN")).toEqual([]);
    expect(packsIn("TRIM PK 8 FT")).toEqual([]);
    expect(packsIn("JUNCTION BOX 2-1/8")).toEqual([]);
    expect(packsIn("BOX 10 X 3")).toEqual([]);
    expect(packsIn("100 PER BOX")).toEqual([{ word: "box", size: "100" }]);
    expect(packsIn("#10 SCREW BX 100")).toEqual([{ word: "box", size: "100" }]);
  });
});
