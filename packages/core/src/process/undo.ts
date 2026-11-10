// R5 (docs/plan.md §1.86, §9): taking a write back. Pure: the executor reads the record and
// stores the states; this decides whether an undo may run and how the builder words it.
// A late reject is offered an undo, never applied by itself; the undo itself is a new write
// through the external-action path, decided again by the gate (invariant 8).

import { canonicalJson } from "../canonical";
import type { ToolSpec, ToolUndo } from "../schemas/tool";

/** What `canUndo` and `describeUndo` read of a tool's spec. */
export type UndoSpec = Pick<ToolSpec, "id" | "sideEffect" | "verb" | "undo">;

export const UNDO_REFUSALS = [
  /** A read or an internal record: nothing in a client's tool to take back. */
  "not_a_write",
  /** The tool says it can't be taken back (`undo: none`), or says nothing (treated as none). */
  "cannot_undo",
  /** A restore with no saved before state: there was nothing there before (a create). */
  "nothing_before",
  /** The record isn't there any more. */
  "record_gone",
  /** We don't have the record as our write left it, so we can't tell whether it changed since. */
  "after_unknown",
  /** Someone changed the record after our write: putting ours back would overwrite theirs. */
  "changed_since",
  /** The record already holds what was there before: nothing to undo. */
  "already_undone",
] as const;
export type UndoRefusal = (typeof UNDO_REFUSALS)[number];

export type CanUndo = { ok: true } | { ok: false; code: UndoRefusal; reason: string };

/** A write's undo, `none` when the tool says nothing (R5: unknown counts as can't). */
export function undoOf(spec: Pick<ToolSpec, "sideEffect" | "undo">): ToolUndo | null {
  if (spec.sideEffect !== "external") return null;
  return spec.undo ?? { kind: "none" };
}

/** Equal by canonical JSON, so key order and `undefined` properties don't count as a change. */
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function refuse(code: UndoRefusal, reason: string): CanUndo {
  return { ok: false, code, reason };
}

/**
 * Whether a write can be taken back now.
 *
 * - `beforeState`: the record before our write (`external_action.before`; null for a create).
 * - `currentState`: the record now, read with the tool's own `before` and the write's input, so it
 *   has the same shape as the other two.
 * - `afterState`: the record as our write left it, read the same way right after the write.
 *
 * DECISION: "changed since our write" compares the current record with the record as our write
 * left it (canonical JSON, the whole snapshot, version stamps included), so any change by anyone
 * else refuses. Without the after state we can't tell, so we refuse: a refused undo goes to a
 * person, an undo that overwrote someone's change would not.
 */
export function canUndo(
  spec: UndoSpec,
  beforeState: unknown,
  currentState: unknown,
  afterState?: unknown,
): CanUndo {
  const undo = undoOf(spec);
  if (!undo) return refuse("not_a_write", `${spec.id} doesn't change a client's tool`);
  if (undo.kind === "none") {
    return refuse(
      "cannot_undo",
      spec.undo
        ? `${spec.id} can't be taken back once it's done`
        : `${spec.id} doesn't say how it's taken back, so we treat it as final`,
    );
  }
  if (undo.kind === "restore" && (beforeState === null || beforeState === undefined)) {
    return refuse("nothing_before", "there was nothing there before this change to put back");
  }
  if (currentState === null || currentState === undefined) {
    return refuse("record_gone", "the record isn't there any more");
  }
  if (afterState === null || afterState === undefined) {
    return refuse(
      "after_unknown",
      "we didn't keep the record as this change left it, so we can't tell whether it changed since",
    );
  }
  if (!same(currentState, afterState)) {
    return refuse(
      "changed_since",
      "the record changed after this change; putting it back would undo someone else's work",
    );
  }
  if (undo.kind === "restore" && same(currentState, beforeState)) {
    return refuse("already_undone", "the record already holds what was there before");
  }
  return { ok: true };
}

export interface UndoDescription {
  kind: ToolUndo["kind"];
  /** Whether the write can be taken back at all. */
  undoable: boolean;
  /** The tool that takes it back, when it isn't the write itself. */
  tool: string | null;
  /** One plain line for the step's panel. */
  text: string;
  /**
   * The builder's warning next to "if nobody answers: go ahead", for a write that can't be taken
   * back; null when it can.
   */
  warning: string | null;
}

// DECISION: the warning's verb comes from the tool id's last word (send, post, publish, place,
// answer), else "goes ahead"; a declared word per tool would be a schema change for wording.
const ACTS: Record<string, string> = {
  send: "sends",
  post: "posts",
  publish: "publishes",
  place: "places the call",
  answer: "answers the call",
};

function acts(id: string): string {
  return ACTS[id.slice(id.lastIndexOf(".") + 1)] ?? "goes ahead";
}

/** How the builder words a write's undo; null for a tool that doesn't change a client's tool. */
export function describeUndo(spec: UndoSpec): UndoDescription | null {
  const undo = undoOf(spec);
  if (!undo) return null;
  switch (undo.kind) {
    case "none":
      return {
        kind: "none",
        undoable: false,
        tool: null,
        text: "Can't be taken back once it's done.",
        warning: `If nobody answers, this ${acts(spec.id)} and can't be taken back.`,
      };
    case "reverse":
      return {
        kind: "reverse",
        undoable: true,
        tool: undo.tool,
        text: `Can be taken back with ${undo.tool}, if nobody changed it since.`,
        warning: null,
      };
    case "restore":
      return {
        kind: "restore",
        undoable: true,
        tool: undo.tool ?? null,
        text: "Can be taken back: we put back what was there before, if nobody changed it since.",
        warning: null,
      };
  }
}
