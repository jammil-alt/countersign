import { describe, expect, it } from "vitest";
import { tools } from "../testing/fixtures";
import { ToolSpec, ToolUndo } from "./tool";

// R5 (docs/plan.md §9): write tools declare how they are taken back.
describe("ToolSpec undo", () => {
  const write = tools["qbo.bill.update_lines"] as ToolSpec;
  const read = tools["qbo.bill.query"] as ToolSpec;

  it("is optional, so specs from before R5 still parse", () => {
    expect(write.undo).toBeUndefined();
    expect(ToolSpec.safeParse(write).success).toBe(true);
  });

  it("parses none, reverse and restore (with or without a named tool)", () => {
    for (const undo of [
      { kind: "none" },
      { kind: "reverse", tool: "qbo.bill.void" },
      { kind: "restore" },
      { kind: "restore", tool: "qbo.bill.update" },
    ]) {
      expect(ToolSpec.parse({ ...write, undo }).undo).toEqual(undo);
    }
  });

  it("refuses an unknown kind, extra fields, a reverse without a tool or by itself", () => {
    expect(ToolUndo.safeParse({ kind: "delete" }).success).toBe(false);
    expect(ToolUndo.safeParse({ kind: "none", tool: "qbo.bill.void" }).success).toBe(false);
    expect(ToolUndo.safeParse({ kind: "reverse" }).success).toBe(false);
    expect(ToolUndo.safeParse({ kind: "restore", tool: "Not A Tool" }).success).toBe(false);
    expect(
      ToolSpec.safeParse({ ...write, undo: { kind: "reverse", tool: write.id } }).success,
    ).toBe(false);
  });

  it("belongs to external tools only", () => {
    expect(ToolSpec.safeParse({ ...read, undo: { kind: "none" } }).success).toBe(false);
  });
});
