// A step's connections (owner, 2026-11-14): the step that runs right before it ("Prior step") and
// right after it ("Next step"), picked in the inspector. A process runs its lists top to bottom, so
// a connection *is* a place in the list: picking another prior or next step moves the step there,
// on its own path. Before the move is made, the builder checks the process as it would be (the same
// validator the server runs) and says what the move would break: data a step reads that would no
// longer run before it, required inputs left empty, data of the wrong shape, a Reshape mapping that
// no longer fits. It offers ways out: the places in the list where the step fits without new
// problems, a Reshape step before each step whose inputs can't be filled, or the move as asked
// (its problems then show on their steps, each with Fix).
// DECISION: the pickers offer the steps of the step's own list (the process's, a path's or a loop's
// block). Moving a step into another path or loop stays a drag on the canvas: a prior step on
// another path doesn't say where on that path the step would go.
import type { TypingContext } from "@countersign/core";
import type { BuilderProblem } from "./catalog";
import {
  type ContainerId,
  getContainer,
  locate,
  moveStep,
  type NewId,
  type Process,
  type Step,
} from "./model";
import { addReshapeBefore, isReshape } from "./reshape";

export interface Neighbours {
  container: ContainerId;
  index: number;
  /** Every step of the list, this one included, in order. */
  siblings: Step[];
  prior: Step | null;
  next: Step | null;
}

/** The step's list and the steps right before and after it there; null when it isn't found. */
export function neighbours(process: Process, stepId: string): Neighbours | null {
  const loc = locate(process, stepId);
  if (!loc) return null;
  const siblings = getContainer(process, loc.container) ?? [];
  return {
    container: loc.container,
    index: loc.index,
    siblings,
    prior: siblings[loc.index - 1] ?? null,
    next: siblings[loc.index + 1] ?? null,
  };
}

/** "Prior step" or "Next step" set to another step of the list; null is the start or the end. */
export type Reconnect = { end: "prior" | "next"; to: string | null };

/** Where the step goes in its list (counted after it has left its place) for a new connection. */
export function reconnectIndex(n: Neighbours, stepId: string, change: Reconnect): number | null {
  const rest = n.siblings.filter((s) => s.id !== stepId);
  if (change.to === null) return change.end === "prior" ? 0 : rest.length;
  const at = rest.findIndex((s) => s.id === change.to);
  if (at === -1) return null;
  return change.end === "prior" ? at + 1 : at;
}

/** The process with the step moved to meet its new prior or next step (unchanged if it can't). */
export function reconnect(process: Process, stepId: string, change: Reconnect): Process {
  const n = neighbours(process, stepId);
  if (!n) return process;
  const index = reconnectIndex(n, stepId, change);
  if (index === null) return process;
  return moveStep(process, stepId, n.container, index);
}

/** What a kind of problem means for a connection, in a few words. */
export type IssueKind = "reads" | "required" | "shape" | "mapping" | "other";

export const ISSUE_TITLE: Record<IssueKind, string> = {
  reads: "Data a step reads would no longer come before it",
  required: "Required inputs would be left empty",
  shape: "Data would arrive in the wrong shape",
  mapping: "A Reshape mapping would no longer fit",
  other: "Other problems",
};

export function issueKind(code: string): IssueKind {
  if (code === "template_path" || code === "template_scope") return "reads";
  if (code === "input_missing") return "required";
  if (code === "input_type" || code === "input_unknown" || code === "for_each_not_array") {
    return "shape";
  }
  if (code === "reshape_mapping") return "mapping";
  return "other";
}

/** Codes that a Reshape step before the step can answer: its inputs can't be filled. */
const RESHAPE_ANSWERS = new Set(["input_missing", "input_type", "template_path", "template_scope"]);

export interface Place {
  /** The index in the list (counted after the step has left its place). */
  index: number;
  prior: Step | null;
  next: Step | null;
}

export interface Assessment {
  /** The process as the move leaves it. */
  process: Process;
  /** Problems the move makes, by kind, in the order they first appear. */
  added: { kind: IssueKind; problems: BuilderProblem[] }[];
  /** Problems the move clears. */
  cleared: BuilderProblem[];
  /** Steps whose inputs the move leaves unfilled: a Reshape step before each can fill them. */
  reshape: Step[];
  /** Other places in the list where the step goes without a new problem. */
  fits: Place[];
}

function key(e: BuilderProblem): string {
  return `${e.stepId ?? ""}|${e.field}|${e.code}|${e.message}`;
}

function diff(before: readonly BuilderProblem[], after: readonly BuilderProblem[]) {
  const was = new Set(before.map(key));
  const now = new Set(after.map(key));
  return {
    added: after.filter((e) => !was.has(key(e))),
    cleared: before.filter((e) => !now.has(key(e))),
  };
}

/**
 * What moving the step to meet its new prior or next step would do: the problems it makes and
 * clears (`check` is the builder's validator on a process of this workflow), the steps a Reshape
 * step would help, and the other places in the list where the step goes without a new problem.
 * Null when the change moves nothing.
 */
export function assessReconnect(
  process: Process,
  stepId: string,
  change: Reconnect,
  check: (p: Process) => BuilderProblem[],
): Assessment | null {
  const n = neighbours(process, stepId);
  if (!n) return null;
  const index = reconnectIndex(n, stepId, change);
  if (index === null || index === n.index) return null;
  const after = moveStep(process, stepId, n.container, index);
  const base = check(process);
  const { added, cleared } = diff(base, check(after));

  const groups: Assessment["added"] = [];
  for (const e of added) {
    const kind = issueKind(e.code);
    const g = groups.find((x) => x.kind === kind);
    if (g) g.problems.push(e);
    else groups.push({ kind, problems: [e] });
  }

  const reshape: Step[] = [];
  for (const e of added) {
    if (!e.stepId || !RESHAPE_ANSWERS.has(e.code) || !e.field.startsWith("input")) continue;
    const s = locate(after, e.stepId)?.step;
    if (!s || isReshape(s) || reshape.some((r) => r.id === s.id)) continue;
    if (s.kind !== "read" && s.kind !== "write" && s.kind !== "skill") continue;
    reshape.push(s);
  }

  // Only worth the work when the move breaks something: the places that don't.
  const fits: Place[] = [];
  if (added.length) {
    const rest = n.siblings.filter((s) => s.id !== stepId);
    for (let i = 0; i <= rest.length; i++) {
      if (i === n.index || i === index) continue;
      const there = moveStep(process, stepId, n.container, i);
      if (diff(base, check(there)).added.length === 0) {
        fits.push({ index: i, prior: rest[i - 1] ?? null, next: rest[i] ?? null });
      }
    }
  }
  return { process: after, added: groups, cleared, reshape, fits };
}

/**
 * The move and a Reshape step before each step it leaves unfilled, each mapping proposed from what
 * runs before (as "Add a Reshape step before this" does), in one edit.
 */
export function reconnectWithReshape(
  process: Process,
  stepId: string,
  change: Reconnect,
  before: readonly string[],
  ctx: TypingContext,
  newId: NewId,
): Process {
  let out = reconnect(process, stepId, change);
  for (const id of before) out = addReshapeBefore(out, id, ctx, newId)?.process ?? out;
  return out;
}
