// What a page already knows before its own answer comes (docs/audit-plan.md 1.4): the run row
// that was clicked in a list, the agent as the frame's overview lists it. A page draws its title,
// back link and tabs from these at once and fills in the rest when its answer arrives.
//
// The rows live beside the store under `useApi`, in memory only, and go when it is emptied
// (sign-out, another client): never `localStorage`, `sessionStorage` or history state, since they
// are client data.
import type { ServiceSummary } from "@countersign/core";
import { useEffect } from "react";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import type { ApiStore } from "../api/store";
import { MAX_AGE_MS } from "../api/store";
import { useApi, useApiStore } from "../api/useApi";

/** A run as a list shows it. */
export type KnownRun = ResponseOf<typeof apiRoutes.portalRuns>["runs"][number];

const rows = new WeakMap<
  ApiStore,
  { version: number; runs: Map<string, { run: KnownRun; at: number }> }
>();

function runsOf(store: ApiStore): Map<string, { run: KnownRun; at: number }> {
  let entry = rows.get(store);
  if (!entry || entry.version !== store.version) {
    entry = { version: store.version, runs: new Map() };
    rows.set(store, entry);
  }
  return entry.runs;
}

/** Remembers the runs a list shows, so a run's page can draw its header from its row. */
export function useRememberRuns(runs: readonly KnownRun[] | undefined): void {
  const store = useApiStore();
  useEffect(() => {
    if (!runs) return;
    const map = runsOf(store);
    const at = store.clock();
    for (const run of runs) map.set(run.id, { run, at });
  }, [store, runs]);
}

/**
 * A run as a list last showed it (any list, or the frame's overview), if shown in the last five
 * minutes: the same rule as the store's (nothing older is shown).
 */
export function useKnownRun(id: string): KnownRun | null {
  const store = useApiStore();
  const overview = useApi(apiRoutes.portalOverview);
  const fromOverview = overview.data?.recentRuns.find((r) => r.id === id);
  if (fromOverview) return fromOverview;
  const seen = runsOf(store).get(id);
  if (!seen || store.clock() - seen.at >= MAX_AGE_MS) return null;
  return seen.run;
}

/** An agent as the frame's overview lists it (its name, what it does, its state). */
export function useKnownAgent(id: string): ServiceSummary | null {
  const overview = useApi(apiRoutes.portalOverview);
  return overview.data?.services.find((s) => s.id === id) ?? null;
}
