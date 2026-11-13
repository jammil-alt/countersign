// The app lock (docs/plan.md §1.97): after five minutes away, Face ID or a fingerprint before
// anything shows. Pure, so the rule is tested without a phone.

/** How long the app may sit in the background before it locks. */
export const LOCK_AFTER_MS = 5 * 60 * 1000;

export interface LockState {
  locked: boolean;
  /** When the app last went to the background; null while it is in front. */
  awaySince: number | null;
}

/** A cold start with a session locks at once: nobody has proved who holds the phone yet. */
export const startLock = (signedIn: boolean): LockState => ({ locked: signedIn, awaySince: null });

export function wentAway(state: LockState, now: number): LockState {
  return state.awaySince === null ? { ...state, awaySince: now } : state;
}

export function cameBack(state: LockState, now: number, limitMs = LOCK_AFTER_MS): LockState {
  if (state.awaySince === null) return state;
  const tooLong = now - state.awaySince >= limitMs;
  return { locked: state.locked || tooLong, awaySince: null };
}

export const unlocked = (): LockState => ({ locked: false, awaySince: null });
