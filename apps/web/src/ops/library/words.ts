// R8: the Library's words for the process model (ARCHITECTURE §10.14): v4 step kinds, skill
// methods, a tool's side effect and undo, and where a condition sits. Pure.
import type {
  LibraryConditionUse,
  LibraryTool,
  processes,
  SkillKind,
  SkillListItem,
} from "@countersign/core";
import { PROCESS_KIND_LABEL } from "../workflow/describe";

/**
 * A v4 step kind in the builder's words. One map, the step lists' (ops/workflow/describe), as the
 * library stream's integration note asked.
 */
export function kindLabel(kind: string): string {
  return PROCESS_KIND_LABEL[kind as processes.StepKind] ?? kind;
}

type Method = NonNullable<SkillListItem["method"]>;

export const METHOD_LABEL: Record<Method, string> = {
  rules: "Rules",
  ai: "AI",
  rules_then_ai: "Rules then AI",
};

export const METHOD_LINE: Record<Method, string> = {
  rules: "Code over plain rules, no model",
  ai: "A model call with typed input and output",
  rules_then_ai: "Rules first; the model only for what they leave open",
};

/** Skill model (2026-11-10): what each kind of skill is, in a line (a card's hover). */
export const KIND_LINE: Record<SkillKind, string> = {
  deterministic: "Rules or built-in code: the same answer every time, no model",
  ai: "Instructions and a model; its answer is checked against the output fields",
};

/** "Reads", "Changes our records", "Changes the client's tool". */
export function sideEffectWords(tool: Pick<LibraryTool, "sideEffect">): string {
  switch (tool.sideEffect) {
    case "none":
      return "Reads";
    case "internal":
      return "Changes our records";
    case "external":
      return "Changes the client's tool";
  }
}

/** How a write is undone, in words; null for a tool that changes nothing in a client's tool. */
export function undoWords(tool: Pick<LibraryTool, "undo" | "undoDeclared">): string | null {
  const undo = tool.undo;
  if (!undo) return null;
  switch (undo.kind) {
    case "none":
      return tool.undoDeclared ? "No undo" : "No undo declared";
    case "reverse":
      return `Reversed by ${undo.tool}`;
    case "restore":
      return undo.tool ? `Restored with ${undo.tool}` : "Restored from the before state";
  }
}

export const PLACE_LABEL: Record<LibraryConditionUse["place"], string> = {
  trigger: "Trigger filter",
  if_path: "If path",
  confer: "Confer",
  conferee: "Confer, one reviewer",
  approval: "Approval",
  notify: "Notify",
  urgent: "Urgent notify",
};
