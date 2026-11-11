// Fetch on intent (docs/audit-plan.md 1.6): on hover or focus of a link that opens a detail page,
// the page's first call goes into the store, so the click shows it at once. One prefetch per
// target, none on touch (a finger scrolling past a row is not intent), none in a hidden tab.
import type { FocusEvent, PointerEvent } from "react";
import { useCallback, useRef } from "react";
import { apiRoutes } from "../../api/routes";
import { usePrefetch } from "../../api/useApi";

export type Prefetch = ReturnType<typeof usePrefetch>;

/** What a link carries: fire `run` the first time a mouse rests on it or it takes focus. */
export interface IntentProps {
  onPointerEnter(e: PointerEvent): void;
  onFocus(e: FocusEvent): void;
}

/**
 * `intent(key, run)`: the props for one link. `run` gets the store's `prefetch` and fires once per
 * key for as long as the component is mounted (the store keeps a fresh answer from asking twice
 * across components).
 */
export function useIntent(): (key: string, run: (prefetch: Prefetch) => void) => IntentProps {
  const prefetch = usePrefetch();
  const seen = useRef(new Set<string>());
  return useCallback(
    (key, run) => {
      const go = () => {
        if (seen.current.has(key)) return;
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        seen.current.add(key);
        run(prefetch);
      };
      return {
        onPointerEnter: (e) => {
          if (e.pointerType === "mouse" || e.pointerType === "pen") go();
        },
        onFocus: go,
      };
    },
    [prefetch],
  );
}

/** An agent page's first call: the agent (its bar, tabs and versions). */
export function prefetchAgent(prefetch: Prefetch, agentId: string): void {
  prefetch(apiRoutes.opsAgent, { params: { id: agentId } });
}

// The agent and run pages are in the back office's own chunk, already loaded wherever these links
// are, so there is no chunk to start on hover; the Workflow tab's builder is its own chunk (below).

/** A run page's first call. */
export function prefetchRun(prefetch: Prefetch, runId: string): void {
  prefetch(apiRoutes.opsRun, { params: { id: runId } });
}

/**
 * The Workflow tab's own data, on hover of the tab: the builder's catalog and the event catalog,
 * and the builder's chunk.
 */
export function prefetchWorkflowTab(prefetch: Prefetch, agentId: string): void {
  prefetch(apiRoutes.opsBuilderCatalog, { params: { id: agentId } }, "catalog");
  prefetch(apiRoutes.opsEventCatalog, {}, "catalog");
  void import("../builder/WorkflowBuilder");
}
