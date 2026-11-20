// The agent manual a build writes into its draft (docs/builder-plan.md §5, B3): from the brief,
// the build's decisions (their risk worked out by code, as the build shows them) and its known
// risks (the gap items put off), with the decision points read from the draft's process. The
// route saves it as one new version of the draft per move, through the back office's own save.

import {
  type AgentManual,
  type AnyAgentBundle,
  type BuildDetail,
  deepEqual,
  fillManual,
  readManual,
} from "@countersign/core";

/** A known risk's words for whoever reads the manual: the item's own detail is the operator's. */
// DECISION: the manual says what a known risk means in one fixed line, not the item's detail
// (written for the operator, with how it would be built later).
export const KNOWN_RISK_DETAIL = "Not built in this version: when it happens, a person handles it.";

/** The build's known risks: its gap items put off (§1.153). */
export function knownRisksOf(detail: Pick<BuildDetail, "items">) {
  return detail.items
    .filter((i) => i.kind === "gap" && i.state === "deferred")
    .map((i) => ({ id: i.key ?? i.id, what: i.title, detail: KNOWN_RISK_DETAIL }));
}

/**
 * The draft's bundle with the manual the build writes now, or null when it would not change it
 * (so a move that changes nothing saves no version).
 */
export function withBuildManual(
  detail: BuildDetail,
  bundle: AnyAgentBundle,
): AnyAgentBundle | null {
  const before = readManual(bundle.definition.manual) ?? undefined;
  const manual: AgentManual = fillManual({
    brief: detail.build.brief,
    decisions: detail.build.fitgap.decisions,
    knownRisks: knownRisksOf(detail),
    bundle,
    before,
  });
  if (before && deepEqual(before, manual)) return null;
  return { ...bundle, definition: { ...bundle.definition, manual } };
}
