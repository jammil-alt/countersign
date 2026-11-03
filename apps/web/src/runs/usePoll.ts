import { useEffect } from "react";

/**
 * Calls `reload` every `ms` while `active` (plan §1.2 "Live updates": the run page polls every 2 s
 * while a run is going; the inbox every 15–30 s). Stops as soon as `active` turns false.
 */
export function usePoll(reload: () => void, active: boolean, ms: number): void {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, ms);
    return () => clearInterval(timer);
  }, [reload, active, ms]);
}
