// Polls that back off (docs/audit-plan.md 2.7): a wait that goes on is asked about less and less
// often, and never in a hidden tab (`usePoll` skips those ticks and asks once on the way back).
import { useCallback, useEffect, useRef, useState } from "react";
import { usePoll } from "../runs/usePoll";

export interface Backoff {
  /** The first interval. */
  firstMs: number;
  /** The longest interval it grows to. */
  maxMs: number;
  /** Each tick's interval over the last one's. */
  factor?: number;
  /** Ticks after which it stops; none by default (the interval stops growing at `maxMs`). */
  maxTries?: number;
}

/** The interval before tick `n` (0 first): `firstMs`, then times `factor` each tick, up to `maxMs`. */
export function backoffMs(n: number, { firstMs, maxMs, factor = 1.5 }: Backoff): number {
  return Math.min(maxMs, Math.round(firstMs * factor ** n));
}

/**
 * `usePoll` with a growing interval: `reload` every `firstMs`, then less often up to `maxMs`,
 * while `active`. It starts again from `firstMs` whenever `active` turns on or `restart` changes
 * (a new message sent, a new upload), and stops after `maxTries` ticks if given.
 */
// DECISION: 3 s growing by half each tick to 30 s for the portal's waits (Sloan's answer, a
// document being read): the first answers still come within seconds, and a wait left open costs
// two requests a minute instead of twenty.
export function useBackoffPoll(
  reload: () => void,
  active: boolean,
  backoff: Backoff,
  busy: boolean,
  restart: unknown = null,
): void {
  const [tick, setTick] = useState(0);
  // The ticks so far, also kept outside React's state, so a tick never runs past `maxTries` even
  // before the render that stops the timer.
  const ticks = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a restart starts the backoff again.
  useEffect(() => {
    ticks.current = 0;
    setTick(0);
  }, [active, restart]);
  const { maxTries } = backoff;
  const done = maxTries !== undefined && tick >= maxTries;
  const step = useCallback(() => {
    if (maxTries !== undefined && ticks.current >= maxTries) return;
    ticks.current += 1;
    reload();
    setTick(ticks.current);
  }, [reload, maxTries]);
  usePoll(step, active && !done, backoffMs(tick, backoff), busy);
}
