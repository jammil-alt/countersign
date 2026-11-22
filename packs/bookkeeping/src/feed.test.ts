// docs/plan.md §1.221: the import of bank transactions says which feed it reads from, so its step
// carries that connector's mark (Plaid's), without naming a connection it would have to be bound to.
import { ToolSpec } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { importTool, settleTool } from "./tools";

describe("the bank feed on the import tool", () => {
  it("names the bank feed as its feed, and no connector", () => {
    const spec = ToolSpec.parse({ ...importTool.spec });
    expect(spec.feed).toBe("bankfeed");
    expect(spec.connector).toBeUndefined();
    expect(spec.sideEffect).toBe("internal");
  });

  it("leaves a tool that reads no feed without one", () => {
    expect(ToolSpec.parse({ ...settleTool.spec }).feed).toBeUndefined();
  });
});
