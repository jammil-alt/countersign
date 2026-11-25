// Lockdown (docs/plan.md §1.243): whether the API has answered this tab `423 client_locked`. Every
// call goes through the API client, which notes it here; the portal then shows its locked page in
// place of whatever screen asked. Cleared when the account is unlocked or another one is chosen.
import { useSyncExternalStore } from "react";

let locked = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** A failed call: `423 client_locked` means the account is locked. */
export function noteLockedFailure(error: { status: number; code: string }): void {
  if (error.status !== 423 || error.code !== "client_locked" || locked) return;
  locked = true;
  emit();
}

/** The account was unlocked, or another one was chosen: screens may ask again. */
export function clearLocked(): void {
  if (!locked) return;
  locked = false;
  emit();
}

export function isLocked(): boolean {
  return locked;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether this tab's account is locked, as the API last said. */
export function useAccountLocked(): boolean {
  return useSyncExternalStore(subscribe, isLocked, isLocked);
}
