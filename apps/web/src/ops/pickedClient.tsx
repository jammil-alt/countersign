// The client the back office's top-bar picker shows: the page's own client when the page belongs to
// one (`/ops/clients/:clientId/…`, or a page that reports its client, such as a run), else none.
// DECISION (QA, 2026-11-22): the picker is navigation only. It used to remember the last client
// picked or opened and keep showing it on Runs, Escalations, Sales and search, which list every
// client, so it read as a filter that wasn't one. Those screens have their own client filters
// (Runs' RunFilter, Escalations' `?client=`); the picker opens a client's page and shows which
// client the page you're on belongs to, nothing more. Nothing is remembered between pages.
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useMatch } from "react-router-dom";

interface PickedClient {
  /** The page's own client, from its address or reported by the page; null when it has none. */
  clientId: string | null;
  /** A page saying which client it belongs to (null when it is left). */
  report(id: string | null): void;
}

const PickedClientContext = createContext<PickedClient | null>(null);

/** `/ops/clients/:clientId/...`, except the "new client" page. */
export function useRouteClientId(): string | null {
  const match = useMatch("/ops/clients/:clientId/*");
  const id = match?.params.clientId;
  return id && id !== "new" ? id : null;
}

export function PickedClientProvider({ children }: { children: ReactNode }) {
  const routeClient = useRouteClientId();
  const [reported, setReported] = useState<string | null>(null);
  const pageClientId = routeClient ?? reported;

  // DECISION: picking a client does not empty the store under useApi (docs/audit-plan.md 1.2).
  // An operator session's active client is not in the session (`activeTenantId` is null); each
  // call names its client in the address (`/ops/clients/:id/…`, `?client=`), so one client's
  // answers are keyed apart from another's and never shown on its page.
  const value = useMemo<PickedClient>(
    () => ({ clientId: pageClientId, report: setReported }),
    [pageClientId],
  );
  return <PickedClientContext.Provider value={value}>{children}</PickedClientContext.Provider>;
}

/** The page's client and what the page says about it. Outside the back office: none. */
export function usePickedClient(): PickedClient {
  return (
    useContext(PickedClientContext) ?? {
      clientId: null,
      report: () => {},
    }
  );
}

/**
 * For a page that belongs to one client without it in its address (a run, `/ops/runs/:id`): the
 * picker shows that client while the page is open. `undefined` while the page loads.
 */
export function usePageClient(clientId: string | null | undefined): void {
  const { report } = usePickedClient();
  useEffect(() => {
    if (!clientId) return;
    report(clientId);
    return () => report(null);
  }, [clientId, report]);
}
