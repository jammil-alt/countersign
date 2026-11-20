// A draft's problems as one count (BUILDER_QA CONS-6): the build page, its draft gate and the
// workflow builder group the validator's errors the same way, so they say the same number. One
// step reading several values of a step that doesn't run before it is one problem (move the step),
// however many values it reads.

/** What grouping reads of a validator error. */
export interface GroupableProblem {
  workflow?: string | null | undefined;
  stepId: string | null;
  code: string;
  message: string;
}

// A reference is anything up to the closing braces, trimmed after: spaces and the reference
// matched by parts that overlap took polynomial time on a long "{{    " (CodeQL js/polynomial-redos).
const ORDER = /^\{\{([^}]*)\}\}:\s*step "(.+)" does not run before this one on its path$/s;

/**
 * The step a problem's reference reads that doesn't run before its step, and the reference, or
 * null for any other problem.
 */
export function orderProblem(e: GroupableProblem): { ref: string; after: string } | null {
  // A Reshape mapping's problem names the mapping's own fields: it stays a line of its own.
  if (e.code === "reshape_mapping") return null;
  const m = ORDER.exec(e.message);
  const ref = m?.[1]?.trim();
  return ref && m?.[2] ? { ref, after: m[2] } : null;
}

/** The key that joins problems into one: a step's references to the same later step; else null. */
export function problemGroupKey(e: GroupableProblem): string | null {
  const order = orderProblem(e);
  return order ? `${e.workflow ?? ""}:${e.stepId ?? ""}:order:${order.after}` : null;
}

/** The problems grouped as they are counted: in order of first appearance, each group's errors. */
export function groupProblems<E extends GroupableProblem>(errors: readonly E[]): E[][] {
  const out: E[][] = [];
  const at = new Map<string, number>();
  for (const e of errors) {
    const key = problemGroupKey(e);
    const i = key === null ? undefined : at.get(key);
    if (i !== undefined) {
      out[i]?.push(e);
      continue;
    }
    if (key !== null) at.set(key, out.length);
    out.push([e]);
  }
  return out;
}
