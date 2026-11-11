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
// DECISION: a tick waits for the answer before it. When a reload aborted the request before it,
// a run page on staging (over 2 s to answer) had every answer cancelled. Since the store under
// useApi (docs/audit-plan.md 1.2) nothing is aborted and a tick in flight joins the request, but
// `busy` is only true while there is no data, so the wait still matters on a first load.
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
