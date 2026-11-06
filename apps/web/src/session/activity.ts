// Whether the person is using the app (docs/plan.md §1.35). The API ends a session after 30 minutes
// without a request the person made; this marks those requests (SESSION_ACTIVITY_HEADER) and tells
// the app when to sign out by itself. Input in any tab counts for all of them (localStorage), so a
// tab left open in the background doesn't sign out someone working in another.

import { SESSION_ACTIVITY_WINDOW_SEC, SESSION_IDLE_SEC } from "@countersign/core";

const KEY = "cs.lastInput";
// DECISION: the shared time is written at most every 15 seconds; the limits are in minutes.
const SHARE_EVERY_MS = 15_000;
const INPUTS = ["keydown", "pointerdown", "wheel", "touchstart"] as const;

// Opening the app is the person's own act.
let lastInput = Date.now();
let lastShared = 0;

function shared(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function noteInput(now = Date.now()): void {
  lastInput = now;
  if (now - lastShared < SHARE_EVERY_MS) return;
  lastShared = now;
  try {
    globalThis.localStorage?.setItem(KEY, String(now));
  } catch {
    // Private windows and blocked storage: this tab still counts its own input.
  }
}

/** The last input in any tab. */
export function lastInputAt(): number {
  return Math.max(lastInput, shared());
}

/** Whether a request now is the person's own: input within the last minute. */
export function recentlyActive(now = Date.now()): boolean {
  return now - lastInput < SESSION_ACTIVITY_WINDOW_SEC * 1000;
}

/** Whether the app should sign out: no input in any tab for the idle limit. */
export function idleTooLong(now = Date.now()): boolean {
  return now - lastInputAt() >= SESSION_IDLE_SEC * 1000;
}

/** Counts input on `target` until the returned function is called. */
export function watchInput(target: Pick<Window, "addEventListener" | "removeEventListener">) {
  const on = () => noteInput();
  for (const type of INPUTS) target.addEventListener(type, on, { passive: true, capture: true });
  return () => {
    for (const type of INPUTS) target.removeEventListener(type, on, { capture: true });
  };
}
