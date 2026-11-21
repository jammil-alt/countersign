// The step a "Draft it now" gap stands on (docs/builder-plan.md §12.4). A works-first draft has a
// person do each part the catalog lacks (a person step, mode "ask") and names the part in its gaps,
// one sentence each; a guard may still leave a missing step. The gap item names that step so the
// chart can show it on its box. The drafter's answer doesn't link the two, so they are matched by
// their words.

import type { Process, Step } from "../process/schema";
import { allSteps } from "../process/walk";

// DECISION (docs/plan.md §1.170): a gap is matched to a stand-in step (a missing step, or a person
// step that asks) by the words they share: most of the step's own words in the gap's sentence, at
// least two of them, and more than any other stand-in shares. Anything less leaves the gap on no
// step rather than on a wrong one.
const STOP = new Set(
  (
    "a an and are as at be by can do does for from has have in into is it its no not now of on or " +
    "so that the them then they this to until was what when which who will with yet person people " +
    "part parts piece for now catalog connector connectors tool tools there here one"
  ).split(" "),
);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    let w = raw.replace(/'s$/, "").replace(/'/g, "");
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** A step that stands for a part the catalog lacks: a missing step, or a person step that asks. */
function standIn(step: Step): string | null {
  if (step.kind === "missing") return `${step.name} ${step.need}`;
  if (step.kind === "person" && step.mode === "ask") {
    return `${step.name} ${typeof step.title === "string" ? step.title : ""}`;
  }
  return null;
}

/**
 * For each gap, in order, the id of the stand-in step it is about, or null when no one step
 * clearly is.
 */
export function gapSteps(
  gaps: readonly string[],
  processes: readonly Pick<Process, "steps">[],
): (string | null)[] {
  const steps: { id: string; words: Set<string> }[] = [];
  for (const p of processes) {
    for (const { step } of allSteps(p)) {
      const text = standIn(step);
      if (text !== null) steps.push({ id: step.id, words: words(text) });
    }
  }
  return gaps.map((gap) => {
    const said = words(gap);
    const scored = steps
      .map((s) => {
        let shared = 0;
        for (const w of s.words) if (said.has(w)) shared += 1;
        return { id: s.id, shared, share: s.words.size > 0 ? shared / s.words.size : 0 };
      })
      .filter((s) => s.shared >= 2 && s.share >= 0.5)
      .sort((a, b) => b.shared - a.shared || b.share - a.share);
    const [best, next] = scored;
    if (!best) return null;
    if (next && next.shared === best.shared) return null;
    return best.id;
  });
}
