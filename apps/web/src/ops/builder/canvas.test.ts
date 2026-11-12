import { describe, expect, it } from "vitest";
import { barShares, pathLetter } from "./Canvas";

describe("pathLetter", () => {
  it("letters paths A to Z, then AA", () => {
    expect([0, 1, 2, 25, 26, 27].map(pathLetter)).toEqual(["A", "B", "C", "Z", "AA", "AB"]);
  });
});

describe("barShares", () => {
  it("splits from the first path's line to the last's", () => {
    expect(barShares(3, 0.5, 2.5)).toEqual([
      { left: "50%", right: "0%" },
      { left: "0%", right: "0%" },
      { left: "0%", right: "50%" },
    ]);
  });

  it("joins only the paths that carry on, through the middle", () => {
    // A and B carry on, C ends: the bar stops at B's line, the middle.
    expect(barShares(3, 0.5, 1.5)).toEqual([
      { left: "50%", right: "0%" },
      { left: "0%", right: "50%" },
      null,
    ]);
    // Only D of four carries on: the bar runs from the middle to D's line.
    expect(barShares(4, 2, 3.5)).toEqual([
      null,
      null,
      { left: "0%", right: "0%" },
      { left: "0%", right: "50%" },
    ]);
  });
});
