// Unsaved work this browser keeps between reloads (the workflow builder's rolling draft, in
// localStorage) belongs to one person: its key names the signed-in user as well as the agent.
// Every such key is removed at sign-out, and whenever the session is found ended or someone else's
// (./session.tsx `refresh`: an expired or revoked session, another tab's sign-in, a lapsed
// cookie), so the next person on this device never reads it. Client data otherwise never goes in browser storage (../api/store.ts).

/** Every builder draft key starts with this, including the ones from before keys named a person. */
export const BUILDER_DRAFT_PREFIX = "countersign:builder:";

/** The builder's rolling draft of one agent, for one person. */
export function builderDraftKey(userId: string, agentId: string): string {
  return `${BUILDER_DRAFT_PREFIX}${userId}:${agentId}`;
}

/**
 * Removes the builder drafts kept in this browser: every one, or, given the signed-in user, every
 * one that isn't theirs (another person's, and the ones from before keys named a person).
 */
export function forgetLocalDrafts(keepUserId?: string): void {
  const mine = keepUserId ? `${BUILDER_DRAFT_PREFIX}${keepUserId}:` : null;
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(BUILDER_DRAFT_PREFIX) && !(mine && key.startsWith(mine))) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage blocked: nothing could have been kept in it either.
  }
}
