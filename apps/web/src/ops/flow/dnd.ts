// Drag and drop on the chart (docs/builder-plan.md §12.3: `@dnd-kit` stays): what each draggable
// and droppable carries, and what a finished drag does, worked out without the DOM. The chart never
// makes its own DndContext: the host has one, so the rail's items can be dragged onto the chart.
// `FlowDndContext` below is a ready one, for hosts and tests.
//
// - A box ("flow-box:<id>") dragged onto a + takes that place; onto another box, it comes after it
//   (before it when that box is a Stop; first when it is the start).
// - A rail item ({ type: "palette", item }) is added the same way.
// - The dot under a box ("flow-dot:<id>") dropped on another box: that box comes next.

import {
  type Active,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Over,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { createElement, type ReactNode } from "react";
import type { ContainerId, PaletteItem, Step } from "../builder/model";
import { ROOT } from "../builder/model";
import type { ChartEvents, InsertPoint } from "./types";

/** What a dragged thing carries. A rail item's is today's palette drag data. */
export type FlowDragData =
  | {
      type: "flow-step";
      stepId: string;
      container: ContainerId;
      index: number;
      /** The containers inside the step, at any depth: it can't be moved into them. */
      inside: readonly ContainerId[];
    }
  | { type: "flow-dot"; stepId: string }
  | { type: "palette"; item: PaletteItem };

/** What a drop target carries. */
export type FlowDropData =
  | { type: "flow-insert"; at: InsertPoint }
  | {
      type: "flow-box";
      stepId: string;
      kind: Step["kind"];
      container: ContainerId;
      index: number;
    }
  /** The start box: dropping there puts the step first. */
  | { type: "flow-start" };

/**
 * What a finished drag does. A move's `to` is ready for `moveStep`: its index is counted after the
 * step has left its place (as arrayMove counts), so a host passes it straight through.
 */
export type FlowDrop =
  | { type: "move"; stepId: string; to: InsertPoint }
  | { type: "insert"; item: PaletteItem; at: InsertPoint }
  | { type: "connect"; from: string; to: string }
  | null;

export const boxDragId = (stepId: string) => `flow-box:${stepId}`;
export const dotDragId = (stepId: string) => `flow-dot:${stepId}`;
export const insertDropId = (at: InsertPoint) => `flow-insert:${at.container}#${at.index}`;
export const START_DROP_ID = "flow-start";

type Side = Pick<Active, "id" | "data"> | Pick<Over, "id" | "data">;

function dataOf<T>(side: Side | null | undefined): T | null {
  const data = side?.data?.current;
  return data && typeof data === "object" && "type" in data ? (data as T) : null;
}

/** Where a drop on a target puts a step: before index in container, as the chart shows it. */
function placeOf(over: FlowDropData): InsertPoint {
  if (over.type === "flow-insert") return over.at;
  if (over.type === "flow-start") return { container: ROOT, index: 0 };
  // Onto a box: after it; onto a Stop, before it (nothing comes after a Stop).
  return over.kind === "stop"
    ? { container: over.container, index: over.index }
    : { container: over.container, index: over.index + 1 };
}

/** What a finished drag does, or null when it does nothing. */
export function resolveFlowDrop(
  active: Side | null | undefined,
  over: Side | null | undefined,
): FlowDrop {
  const drag = dataOf<FlowDragData>(active);
  const target = dataOf<FlowDropData>(over);
  if (!drag || !target) return null;

  if (drag.type === "flow-dot") {
    if (target.type !== "flow-box" || target.stepId === drag.stepId) return null;
    return { type: "connect", from: drag.stepId, to: target.stepId };
  }

  const at = placeOf(target);
  if (drag.type === "palette") return { type: "insert", item: drag.item, at };

  if (drag.type === "flow-step") {
    if (target.type === "flow-box" && target.stepId === drag.stepId) return null;
    // A step can't go inside itself.
    if (drag.inside.includes(at.container)) return null;
    if (at.container === drag.container) {
      // Just before or just after itself: where it already is.
      if (at.index === drag.index || at.index === drag.index + 1) return null;
      const index = at.index > drag.index ? at.index - 1 : at.index;
      return { type: "move", stepId: drag.stepId, to: { container: at.container, index } };
    }
    return { type: "move", stepId: drag.stepId, to: at };
  }
  return null;
}

/** Under the pointer first (the + points are small); with the keyboard, the closest target. */
export const flowCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

/** Sends a resolved drop to the chart's callbacks. */
export function dispatchFlowDrop(
  drop: FlowDrop,
  events: Pick<ChartEvents, "onMove" | "onInsert" | "onConnect">,
): void {
  if (!drop) return;
  if (drop.type === "move") events.onMove(drop.stepId, drop.to);
  else if (drop.type === "insert") events.onInsert(drop.at, drop.item);
  else events.onConnect(drop.from, drop.to);
}

/**
 * A DndContext for the chart: the pointer (after a 4px move, so a click still selects) and the
 * keyboard, with each finished drag sent to the callbacks. A host with a DndContext of its own
 * calls `resolveFlowDrop` and `dispatchFlowDrop` from its onDragEnd instead.
 */
export function FlowDndContext(props: {
  events: Pick<ChartEvents, "onMove" | "onInsert" | "onConnect">;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const onDragEnd = (e: DragEndEvent) =>
    dispatchFlowDrop(resolveFlowDrop(e.active, e.over), props.events);
  return createElement(
    DndContext,
    { sensors, collisionDetection: flowCollision, onDragEnd },
    props.children,
  );
}
