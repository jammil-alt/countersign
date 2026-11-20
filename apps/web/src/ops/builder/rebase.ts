// The canvas's unsaved edits carried onto a newer draft (QA 2026-11-19: FLOW-6, a trigger saved
// above the builder; FLOW-9, the Builder's answer to a turn sent before the edits). Core's three-way
// merge (the update merge's), every id kept.
import {
  type AnyAgentBundle,
  canonicalJson,
  mergeBundles,
  type ProcessAgentBundle,
} from "@countersign/core";

/**
 * `theirs` with what the canvas changed since `base` (`ours`) carried onto it. Null when both
 * changed the same thing: the caller keeps the canvas as it is and says so.
 */
export function rebase(
  base: ProcessAgentBundle,
  ours: ProcessAgentBundle,
  theirs: ProcessAgentBundle,
  read: (bundle: AnyAgentBundle) => ProcessAgentBundle,
): ProcessAgentBundle | null {
  const was = canonicalJson(base);
  if (canonicalJson(ours) === was) return theirs;
  if (canonicalJson(theirs) === was) return ours;
  const merged = mergeBundles(base, ours, theirs);
  return merged.clean ? read(merged.bundle) : null;
}
