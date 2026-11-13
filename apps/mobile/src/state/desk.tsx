// What waits on the person, shared by the Desk and the item screen: loaded from GET /api/inbox,
// refreshed on a pull, when the app comes back to the front and when a notification arrives.
import { routes } from "@countersign/core";
import * as Notifications from "expo-notifications";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { isApiError } from "../api/client";
import type { DeskItem } from "../desk/model";
import { useApp } from "./app";
import { FIXTURES } from "./store";

/** The item just signed, for the Desk's "Signed. Goes out in 0:52 · Undo". */
export interface JustSigned {
  id: string;
  title: string;
  decision: "approve" | "reject";
  deliverAfter: string | null;
}

interface DeskValue {
  items: DeskItem[];
  setAside: number;
  loading: boolean;
  error: string | null;
  refresh(byPerson?: boolean): Promise<void>;
  find(id: string): DeskItem | undefined;
  justSigned: JustSigned | null;
  setJustSigned(s: JustSigned | null): void;
  /** Takes an item off the list at once (signed, answered, set aside). */
  drop(id: string): void;
}

const DeskContext = createContext<DeskValue | null>(null);

export function DeskProvider({ children }: { children: ReactNode }) {
  const { api, status } = useApp();
  const [items, setItems] = useState<DeskItem[]>([]);
  const [setAside, setSetAside] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [justSigned, setJustSigned] = useState<JustSigned | null>(null);

  const refresh = useCallback(
    async (byPerson = false) => {
      if (status !== "signedIn") return;
      setLoading(true);
      try {
        const [waiting, snoozed] = await Promise.all([
          api.call(routes.portalInbox, { query: { view: "waiting" }, byPerson }),
          api.call(routes.portalInbox, { query: { view: "snoozed" } }),
        ]);
        setItems(waiting.items);
        setSetAside(snoozed.items.length);
        setError(null);
      } catch (e) {
        setError(
          isApiError(e) && e.code === "network"
            ? "We can't reach Mezonas right now. Pull to try again."
            : "Your Desk didn't load. Pull to try again.",
        );
      } finally {
        setLoading(false);
      }
    },
    [api, status],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") void refresh();
    });
    const received = FIXTURES
      ? null
      : Notifications.addNotificationReceivedListener(() => void refresh());
    return () => {
      app.remove();
      received?.remove();
    };
  }, [refresh]);

  const value: DeskValue = {
    items,
    setAside,
    loading,
    error,
    refresh,
    find: (id) => items.find((i) => i.id === id),
    justSigned,
    setJustSigned,
    drop: (id) => setItems((list) => list.filter((i) => i.id !== id)),
  };
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk(): DeskValue {
  const v = useContext(DeskContext);
  if (!v) throw new Error("useDesk outside DeskProvider");
  return v;
}
