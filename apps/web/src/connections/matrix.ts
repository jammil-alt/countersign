// The permission matrix as the Connections screens edit it (ARCHITECTURE §6.1; plan §1.2
// "Permission matrix"): per verb `auto`, `approval` or `off`. The operator sets it and may loosen;
// a client admin may only tighten from what is saved; a client user only reads it; delete stays
// off for everyone in v1. The API enforces the same rules; this only offers what it would accept.
import type { PermissionLevel, Verb } from "@countersign/core";
import type { PlainKey } from "../i18n/catalog";
import type { Tone } from "../ui/primitives";

export const VERBS: readonly Verb[] = ["read", "create", "update", "delete"];
export const LEVELS: readonly PermissionLevel[] = ["auto", "approval", "off"];

export type MatrixEditor = "operator" | "client_admin" | "viewer";

const STRICTNESS: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };

/** True when `next` is looser than `saved` (auto < approval < off in strictness). */
export function isLooser(next: PermissionLevel, saved: PermissionLevel): boolean {
  return STRICTNESS[next] < STRICTNESS[saved];
}

/**
 * The levels `editor` may choose for `verb` when `saved` is the stored level: the operator any
 * (but delete only off), a client admin the saved level or stricter, a viewer none.
 */
export function allowedLevels(
  verb: Verb,
  saved: PermissionLevel,
  editor: MatrixEditor,
): PermissionLevel[] {
  if (editor === "viewer") return [];
  if (verb === "delete") return ["off"];
  // DECISION: reads offer auto or off only: reads run unless off (core's decideToolCall), so
  // "approval" would promise a check that never happens.
  const levels = verb === "read" ? LEVELS.filter((l) => l !== "approval" || saved === l) : LEVELS;
  if (editor === "operator") return [...levels];
  return levels.filter((l) => !isLooser(l, saved));
}

export function levelTone(level: PermissionLevel): Tone {
  switch (level) {
    // Auto: the team does it alone (slate); approval: a person signs first (copper); off: nothing.
    case "auto":
      return "accent";
    case "approval":
      return "person";
    case "off":
      return "neutral";
  }
}

export const LEVEL_LABEL: Record<PermissionLevel, PlainKey> = {
  auto: "matrix.level.auto",
  approval: "matrix.level.approval",
  off: "matrix.level.off",
};

export const VERB_LABEL: Record<Verb, PlainKey> = {
  read: "matrix.verb.read",
  create: "matrix.verb.create",
  update: "matrix.verb.update",
  delete: "matrix.verb.delete",
};
