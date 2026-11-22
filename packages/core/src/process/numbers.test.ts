import { describe, expect, it } from "vitest";
import { loopStepNumber, pathLetter, pathStepNumber } from "./numbers";

describe("step numbers (one per step on every screen)", () => {
  it("letters paths A to Z, then AA", () => {
    expect([0, 1, 25, 26, 27].map(pathLetter)).toEqual(["A", "B", "Z", "AA", "AB"]);
  });

  it("numbers a path's steps after their decision, and a loop's after the loop", () => {
    expect(pathStepNumber("5", "A", 0)).toBe("5 A1");
    expect(pathStepNumber("2 A3", "B", 1)).toBe("2 A3 B2");
    expect(loopStepNumber("6", 1)).toBe("6.2");
    expect(loopStepNumber("5 A1", 0)).toBe("5 A1.1");
  });
});
