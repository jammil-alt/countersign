// The portal header's Inbox count (overview `needsYou.inbox`). The header lives as long as the
// portal does, so it cannot load once: it reloads on every page change, every 20 s like the inbox,
// and whenever an item is resolved, so an approval that opens while the client has the portal open
// shows up in the count.
import { createContext, type ReactNode, useContext } from "react";

const RefreshInboxCount = createContext<() => void>(() => {});

export function InboxCountProvider({
  refresh,
  children,
}: {
  refresh: () => void;
  children: ReactNode;
}) {
  return <RefreshInboxCount.Provider value={refresh}>{children}</RefreshInboxCount.Provider>;
}

/** Reloads the header's count (after resolving an item). A no-op outside the portal frame. */
export function useRefreshInboxCount(): () => void {
  return useContext(RefreshInboxCount);
}

/** How often the header's count reloads: the inbox's own cadence (docs/plan.md "Inbox and run views"). */
export const INBOX_COUNT_POLL_MS = 20_000;
