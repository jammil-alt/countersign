import { useEffect, useRef } from "react";

/**
 * Calls `reload` every `ms` while `active` (plan §1.2 "Live updates": the run page polls every 2 s
 * while a run is going; the inbox every 15–30 s), skipping a tick while a load is still in flight
 * (`busy`, the useApi `loading`). Stops as soon as `active` turns false.
 */
// DECISION: a reload aborts the request before it (useApi), so a tick on top of a slow answer
// cancelled it: on staging, where the run page can take over 2 s to answer, every answer was
// cancelled and the run kept saying "Running" after it was done. A tick now waits for the answer.
export function usePoll(reload: () => void, active: boolean, ms: number, busy: boolean): void {
  const inFlight = useRef(busy);
  inFlight.current = busy;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!inFlight.current) reload();
    }, ms);
    return () => clearInterval(timer);
  }, [reload, active, ms]);
}
