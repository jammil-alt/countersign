// Whether a list on screen is the last query's answer, kept while a new filter loads (`keep: true`,
// docs/audit-plan.md 1.8), rather than this query's own answer (stored, refreshing behind, or
// polled). Only a kept list is dimmed: a poll or a revisit of a stored answer is not.
import { useRef } from "react";

/**
 * True while `data` is the answer the screen last showed for another query. `query` names the
 * options asked (any stable string); `data` is what `useApi` returns for them. A kept answer is
 * the very object last shown under the other query; this query's own answer is a different one,
 * even when it comes from the store.
 */
// DECISION: the screen tells a kept list from its own by the answer's identity and the query it
// last answered, so `useApi` needs no new flag (docs/plan.md §1.91 keeps `keep` opt-in per site).
export function useKept(query: string, data: unknown): boolean {
  const shown = useRef<{ query: string; data: unknown } | null>(null);
  if (data === undefined) return false;
  const kept =
    shown.current !== null && shown.current.query !== query && shown.current.data === data;
  if (!kept) shown.current = { query, data };
  return kept;
}
