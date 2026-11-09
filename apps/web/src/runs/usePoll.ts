import { useEffect, useRef } from "react";

/** Whether the page is on screen: false in a background tab or a minimised window. */
export function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Calls `reload` every `ms` while `active` (plan §1.2 "Live updates": the run page polls every 2 s
 * while a run is going; the inbox every 15–30 s), skipping a tick while a load is still in flight
 * (`busy`, the useApi `loading`). Stops as soon as `active` turns false.
 */
// DECISION: a reload aborts the request before it (useApi), so a tick on top of a slow answer
// cancelled it: on staging, where the run page can take over 2 s to answer, every answer was
// cancelled and the run kept saying "Running" after it was done. A tick now waits for the answer.
// DECISION: no ticks while the tab is hidden (docs/plan.md §1.82): a back office left open in a
// background tab asked for every count around the clock. Coming back reloads once, at once, when a
// tick was skipped, so what is on screen is never older than one interval.
export function usePoll(reload: () => void, active: boolean, ms: number, busy: boolean): void {
  const inFlight = useRef(busy);
  inFlight.current = busy;
  useEffect(() => {
    if (!active) return;
    let missed = false;
    const timer = setInterval(() => {
      if (!pageVisible()) {
        missed = true;
        return;
      }
      if (!inFlight.current) reload();
    }, ms);
    const onVisible = () => {
      if (!missed || !pageVisible()) return;
      missed = false;
      if (!inFlight.current) reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, active, ms]);
}
