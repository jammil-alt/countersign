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
 * The query the data on screen answers, and whether that is an earlier one (`stale`): a `keep`
 * list (`useApi`) shows its last answer while the answer for `query` loads, and still shows it if
 * that load fails. The screen dims stale rows and words its empty state for the query answered.
 * Recorded when the data changes, so kept data stays stale until a new answer replaces it; a stored
 * answer refreshing behind is the current query's own.
 */
export function useAnswered<Q>(data: unknown, query: Q): { query: Q; stale: boolean } {
  const shown = useRef<{ data: unknown; query: Q } | null>(null);
  if (data !== undefined && shown.current?.data !== data) shown.current = { data, query };
  const answered = shown.current?.query ?? query;
  return {
    query: answered,
    stale: data !== undefined && JSON.stringify(answered) !== JSON.stringify(query),
  };
}

/**
 * A search box whose word lives in the URL (`q`): what the box shows, and its setter. The word
 * goes to `push` once typing pauses, in a transition. A new `q` from elsewhere (a tab, "Clear", a
 * link) resets the box in the same render, so the old word is never pushed back; the `q` the box
 * itself just pushed does not, so keys pressed while that list renders stay in the box.
 */
export function useSearchBox(
  q: string,
  push: (q: string) => void,
): [text: string, setText: (text: string) => void] {
  const [text, setText] = useState(q);
  const [boxFor, setBoxFor] = useState(q);
  const pushed = useRef<string | null>(null);
  if (boxFor !== q) {
    setBoxFor(q);
    if (q !== pushed.current) {
      pushed.current = null;
      setText(q);
    }
  }
  const typed = useDebounced(text.trim());
  const latest = useRef(push);
  latest.current = push;
  useEffect(() => {
    // Only a pause on what is in the box; the same word typed again after a reset is asked again.
    if (typed !== text.trim() || typed === q) return;
    pushed.current = typed;
    startTransition(() => latest.current(typed));
  }, [typed, text, q]);
  return [text, setText];
}
