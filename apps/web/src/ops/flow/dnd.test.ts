// What a finished drag on the chart does: a box onto a + or another box moves it (counted as
// moveStep counts), never into itself; a rail item is added there; the dot onto a box connects.
import { describe, expect, it } from "vitest";
import type { PaletteItem } from "../builder/model";
import { type FlowDragData, type FlowDropData, resolveFlowDrop } from "./dnd";

const side = (id: string, data: FlowDragData | FlowDropData) => ({ id, data: { current: data } });
const step = (stepId: string, container: string, index: number, inside: string[] = []) =>
  side(`flow-box:${stepId}`, { type: "flow-step", stepId, container, index, inside });
const plus = (container: string, index: number) =>
  side(`flow-insert:${container}#${index}`, { type: "flow-insert", at: { container, index } });
const onto = (stepId: string, container: string, index: number, kind: "read" | "stop" = "read") =>
  side(`flow-box:${stepId}`, { type: "flow-box", stepId, kind, container, index });
const ITEM: PaletteItem = {
  type: "logic",
  key: "logic:wait",
  title: "Wait",
  detail: "",
  logic: "wait",
};
const palette = side("palette:wait", { type: "palette", item: ITEM });

describe("resolveFlowDrop", () => {
  it("moves a box onto a + in another list to that place", () => {
    expect(resolveFlowDrop(step("a", "root", 0), plus("path:p1", 1))).toEqual({
      type: "move",
      stepId: "a",
      to: { container: "path:p1", index: 1 },
    });
  });

  it("counts a move down its own list after the step has left its place", () => {
    expect(resolveFlowDrop(step("a", "root", 0), plus("root", 3))).toEqual({
      type: "move",
      stepId: "a",
      to: { container: "root", index: 2 },
    });
    expect(resolveFlowDrop(step("c", "root", 2), plus("root", 0))).toEqual({
      type: "move",
      stepId: "c",
      to: { container: "root", index: 0 },
    });
  });

  it("does nothing for a drop just before or after the step itself, or onto itself", () => {
    expect(resolveFlowDrop(step("a", "root", 1), plus("root", 1))).toBeNull();
    expect(resolveFlowDrop(step("a", "root", 1), plus("root", 2))).toBeNull();
    expect(resolveFlowDrop(step("a", "root", 1), onto("a", "root", 1))).toBeNull();
  });

  it("never moves a step inside itself", () => {
    const loop = step("f", "root", 0, ["loop:f", "path:p9"]);
    expect(resolveFlowDrop(loop, plus("loop:f", 0))).toBeNull();
    expect(resolveFlowDrop(loop, onto("x", "path:p9", 0))).toBeNull();
  });

  it("puts a box dropped on another box after it, or before a Stop", () => {
    expect(resolveFlowDrop(step("a", "root", 0), onto("x", "path:p1", 0))).toEqual({
      type: "move",
      stepId: "a",
      to: { container: "path:p1", index: 1 },
    });
    expect(resolveFlowDrop(step("a", "root", 0), onto("s", "path:p1", 2, "stop"))).toEqual({
      type: "move",
      stepId: "a",
      to: { container: "path:p1", index: 2 },
    });
  });

  it("puts a step dropped on the start first", () => {
    expect(
      resolveFlowDrop(step("c", "root", 2), side("flow-start", { type: "flow-start" })),
    ).toEqual({
      type: "move",
      stepId: "c",
      to: { container: "root", index: 0 },
    });
  });

  it("adds a rail item where it is dropped", () => {
    expect(resolveFlowDrop(palette, plus("otherwise:o1", 0))).toEqual({
      type: "insert",
      item: ITEM,
      at: { container: "otherwise:o1", index: 0 },
    });
    expect(resolveFlowDrop(palette, onto("x", "root", 4))).toEqual({
      type: "insert",
      item: ITEM,
      at: { container: "root", index: 5 },
    });
  });

  it("connects the dot dropped on another box", () => {
    const dot = side("flow-dot:a", { type: "flow-dot", stepId: "a" });
    expect(resolveFlowDrop(dot, onto("b", "root", 3))).toEqual({
      type: "connect",
      from: "a",
      to: "b",
    });
    expect(resolveFlowDrop(dot, onto("a", "root", 0))).toBeNull();
    expect(resolveFlowDrop(dot, plus("root", 1))).toBeNull();
  });

  it("does nothing with no target or with data it doesn't know", () => {
    expect(resolveFlowDrop(step("a", "root", 0), null)).toBeNull();
    expect(resolveFlowDrop(null, plus("root", 0))).toBeNull();
    expect(resolveFlowDrop({ id: "x", data: { current: undefined } }, plus("root", 0))).toBeNull();
  });
});
