// Fetch on intent (docs/audit-plan.md 1.6) for the back office's Home and Escalations: hovering or
// focusing a row's link fills the store with the first call of the page it opens, so the page
// shows at once when it is clicked. Once per target, never on a touch, never in a hidden tab.
import { useCallback, useMemo, useRef } from "react";
import { apiRoutes } from "../../api/routes";
import { usePrefetch } from "../../api/useApi";

type Prefetch = ReturnType<typeof usePrefetch>;

/**
 * The first call of the back-office page at `to`, made through `prefetch`; false when the address
 * opens no page we know the call of. Its options are exactly the page's own, so the page finds the
 * answer under the same key: the run page (`opsRun`), an agent (`opsAgent`, which the agent's
 * address redirects through) and a client's pages (the frame's `opsClient`).
 */
// DECISION: only the first call of each page (the plan's rule), and no `import()`: the back office
// is one chunk until route splitting (4.2), so its screens are already loaded.
export function prefetchPage(prefetch: Prefetch, to: string): boolean {
  const path = to.split(/[?#]/)[0] ?? "";
  const run = path.match(/^\/ops\/runs\/([^/]+)$/);
  if (run?.[1]) {
    prefetch(apiRoutes.opsRun, { params: { id: run[1] } });
    return true;
  }
  const agent = path.match(/^\/ops\/agents\/([^/]+)$/);
  if (agent?.[1]) {
    prefetch(apiRoutes.opsAgent, { params: { id: agent[1] } });
    return true;
  }
  const client = path.match(/^\/ops\/clients\/([^/]+)(?:\/|$)/);
  if (client?.[1] && client[1] !== "new") {
    prefetch(apiRoutes.opsClient, { params: { id: client[1] } });
    return true;
  }
  return false;
}

/** Whether the tab is out of sight: nothing is fetched ahead then. */
function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Handlers for a list whose rows link to detail pages, put on the element around them (a
 * `contents` wrapper keeps the layout): a link the pointer moves onto (a mouse or pen, never a
 * touch, so scrolling a list on a phone fetches nothing) or the keyboard focuses prefetches its
 * page's first call, once per target for as long as the screen is open.
 */
// DECISION: one pair of handlers on the list, reading the link under the pointer, rather than
// props on each row: the rows are shared parts (`ActivityRow`) and their CSS counts on siblings.
export function usePrefetchOnIntent(): {
  onPointerOver: (e: { pointerType: string; target: EventTarget }) => void;
  onFocus: (e: { target: EventTarget }) => void;
} {
  const prefetch = usePrefetch();
  const done = useRef(new Set<string>());
  const go = useCallback(
    (target: EventTarget) => {
      const link = target instanceof Element ? target.closest("a[href]") : null;
      const to = link?.getAttribute("href");
      if (!to || done.current.has(to) || hidden()) return;
      if (prefetchPage(prefetch, to)) done.current.add(to);
    },
    [prefetch],
  );
  return useMemo(
    () => ({
      onPointerOver: (e: { pointerType: string; target: EventTarget }) => {
        if (e.pointerType !== "touch") go(e.target);
      },
      onFocus: (e: { target: EventTarget }) => go(e.target),
    }),
    [go],
  );
}
