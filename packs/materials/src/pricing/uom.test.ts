// Unit conversion (ARCHITECTURE §12.3): each invoice unit to the item's standard unit, and no price
// without a rule (invariant 7).

import { describe, expect, it } from "vitest";
import { convert, readUom } from "./uom";

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
