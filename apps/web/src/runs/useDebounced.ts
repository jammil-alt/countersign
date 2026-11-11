import { startTransition, useEffect, useRef, useState } from "react";

/** How long typing must pause before a search box asks the server (docs/audit-plan.md 2.4). */
export const SEARCH_PAUSE_MS = 300;

/**
 * `value` once it has stopped changing for `ms`: what a search box sends to the server, so typing
 * a word asks once, not once a letter. The settled value is set in a transition (plan 1.8, typing
 * and filtering): the list's re-render never holds up the next keystroke.
 */
// DECISION: one hook for the four search boxes (portal Contacts and Records, back-office Records,
// the directory), in `runs/` beside `usePoll`, the other timing hook the screens share. The two
// Records screens' copied 300 ms effect becomes this; Contacts and the directory, which asked on
// every keystroke, wait the same 300 ms.
export function useDebounced<T>(value: T, ms: number = SEARCH_PAUSE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => startTransition(() => setSettled(value)), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

/**
 * Whether the rows on screen answer an earlier search: a `keep` list (`useApi`) shows its last
 * answer while the one for `query` loads, and the screen dims those rows. False for a stored answer
 * refreshing behind, which answers the same query.
 */
export function useStale(
  state: { data: unknown; refreshing?: boolean | undefined },
  query: string,
): boolean {
  const shown = useRef<{ data: unknown; query: string } | null>(null);
  if (state.data !== undefined && !state.refreshing) shown.current = { data: state.data, query };
  const last = shown.current;
  return (
    state.data !== undefined && last !== null && last.data === state.data && last.query !== query
  );
}
