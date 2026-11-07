import { describe, expect, it } from "vitest";
import { errorGroupLabel } from "./words";

describe("errorGroupLabel", () => {
  it("reads a failed-runs group's key in words, never its id", () => {
    expect(errorGroupLabel("testkit.record.update:unauthorized")).toBe(
      "Testkit · Update a record · unauthorized",
    );
    expect(errorGroupLabel("person:timeout")).toBe("A person step · timeout");
    expect(errorGroupLabel("run:no_workflow")).toBe("Before any step · no workflow");
    expect(errorGroupLabel("unknown")).toBe("No reason given");
  });
});
