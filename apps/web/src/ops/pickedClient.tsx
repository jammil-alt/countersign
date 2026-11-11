// The client the back office's top-bar picker shows (the one way to choose a client). It is the
// page's own client when the page belongs to one (`/ops/clients/:clientId/…`, or a page that
// reports its client, such as a run), else the last client picked or opened in this tab's session.
// Picking "All clients" forgets it.
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMatch } from "react-router-dom";

const STORAGE_KEY = "mezonas.ops.client";

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (a private window): the pick lasts until the page reloads.
  }
}

interface PickedClient {
  /** The client the picker shows, or null for all clients. */
  clientId: string | null;
  /** The page's own client, from its address or reported by the page; null when it has none. */
  pageClientId: string | null;
  /** Remembers a pick (null: all clients). */
  remember(id: string | null): void;
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
  const [remembered, setRemembered] = useState<string | null>(readStored);
  const pageClientId = routeClient ?? reported;

  // DECISION: opening a client's page (or a page of one, like its run) counts as picking it, so
  // the picker still shows it on the next page that has no client of its own.
  useEffect(() => {
    if (pageClientId && pageClientId !== remembered) {
      setRemembered(pageClientId);
      writeStored(pageClientId);
    }
  }, [pageClientId, remembered]);

  // DECISION: picking a client does not empty the store under useApi (docs/audit-plan.md 1.2).
  // An operator session's active client is not in the session (`activeTenantId` is null); each
  // call names its client in the address (`/ops/clients/:id/…`, `?client=`), so one client's
  // answers are keyed apart from another's and never shown on its page. Emptying on a pick would
  // only ask the frame's names and counts again.
  const remember = useCallback((id: string | null) => {
    setRemembered(id);
    writeStored(id);
  }, []);

  const value = useMemo<PickedClient>(
    () => ({
      clientId: pageClientId ?? remembered,
      pageClientId,
      remember,
      report: setReported,
    }),
    [pageClientId, remembered, remember],
  );
  return <PickedClientContext.Provider value={value}>{children}</PickedClientContext.Provider>;
}

/** The picker's client and what the page says about it. Outside the back office: all clients. */
export function usePickedClient(): PickedClient {
  return (
    useContext(PickedClientContext) ?? {
      clientId: null,
      pageClientId: null,
      remember: () => {},
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
