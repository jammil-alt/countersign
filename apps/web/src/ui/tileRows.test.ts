// Even rows of KPI tiles (staging QA, 2026-11-22: 4 + 1 on Your call, 4 + 2 on Sales and Build).
import { describe, expect, it } from "vitest";
import { evenColumns } from "./tileRows";

/** The width that holds exactly `k` tiles of 176px with 12px between them. */
const fits = (k: number) => k * 176 + (k - 1) * 12;

describe("evenColumns", () => {
  it("puts every tile in one row when they fit", () => {
    expect(evenColumns(5, fits(5))).toBe(5);
    expect(evenColumns(6, 1400)).toBe(6);
    expect(evenColumns(3, fits(4))).toBe(3);
  });

  it("shares tiles out evenly when they don't, never leaving one alone", () => {
    // Room for four: 5 tiles were 4 + 1, now 3 + 2; 6 were 4 + 2, now 3 + 3.
    expect(evenColumns(5, fits(4))).toBe(3);
    expect(evenColumns(6, fits(4))).toBe(3);
    expect(evenColumns(6, fits(5))).toBe(3);
    // Room for three: 5 is 3 + 2, 6 is 3 + 3; room for five, 8 is 4 + 4.
    expect(evenColumns(5, fits(3))).toBe(3);
    expect(evenColumns(6, fits(3))).toBe(3);
    expect(evenColumns(8, fits(5))).toBe(4);
  });

  it("keeps two columns at phone width, as the design system does", () => {
    expect(evenColumns(5, 358)).toBe(2);
    expect(evenColumns(6, 300)).toBe(2);
    expect(evenColumns(1, 300)).toBe(1);
  });
});
