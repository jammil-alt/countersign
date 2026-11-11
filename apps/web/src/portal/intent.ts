// Fetch on intent (docs/audit-plan.md 1.6): a pointer resting on, or the keyboard reaching, a row
// or a link that opens a detail page asks for that page's first call, so the page opens on what
// the store already holds. The portal's screens are all in the entry chunk, so there is no chunk
// to start here.
import type { RouteSpec } from "@countersign/core";
import type { FocusEvent, PointerEvent } from "react";
import { useMemo } from "react";
import type { CallOptions } from "../api/client";
import { apiRoutes } from "../api/routes";
import type { ApiStore } from "../api/store";
import { useApiStore } from "../api/useApi";
import { pageVisible } from "../runs/usePoll";

/** A page a row or link opens. */
export type IntentTarget =
  | { kind: "run"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "inbox" };

type Call = { route: RouteSpec; options: Omit<CallOptions<RouteSpec>, "signal"> };

/** The call each page starts with: the one its main content waits for. */
// DECISION: documents are not prefetched: a document's answer holds signed links and is never
// stored (`cache: "none"`, docs/plan.md §1.91), so asking early would only be asked again.
export function firstCalls(target: IntentTarget): Call[] {
  switch (target.kind) {
    case "run":
      return [{ route: apiRoutes.portalRun, options: { params: { id: target.id } } }];
    case "agent":
      return [{ route: apiRoutes.portalService, options: { params: { id: target.id } } }];
    case "inbox":
      return [{ route: apiRoutes.portalInbox, options: { query: { status: "open" } } }];
  }
}

// One prefetch per target for as long as the store keeps its answers: an entry is dropped with
// the store's contents (its version moves on every clear: sign-out, another client).
const asked = new WeakMap<ApiStore, { version: number; keys: Set<string> }>();

/** Asks for a target's first calls once, and never in a hidden tab. */
export function prefetchTarget(store: ApiStore, target: IntentTarget): void {
  if (!pageVisible() || !store.signedIn) return;
  let seen = asked.get(store);
  if (!seen || seen.version !== store.version) {
    seen = { version: store.version, keys: new Set() };
    asked.set(store, seen);
  }
  for (const { route, options } of firstCalls(target)) {
    const key = store.key(route, options);
    if (seen.keys.has(key)) continue;
    seen.keys.add(key);
    store.prefetch(route, options);
  }
}

/**
 * The page an address opens, when it is one worth asking for early: a run, an agent (any of its
 * tabs opens on the agent), or the Inbox.
 */
export function targetOf(href: string): IntentTarget | null {
  let path: string;
  try {
    const url = new URL(href, "http://portal.invalid");
    if (url.origin !== "http://portal.invalid") return null;
    path = url.pathname;
  } catch {
    return null;
  }
  const run = path.match(/^\/runs\/([^/]+)$/);
  if (run?.[1]) return { kind: "run", id: decodeURIComponent(run[1]) };
  const agent = path.match(/^\/agents\/([^/]+)(?:\/(?:runs|access))?$/);
  if (agent?.[1]) return { kind: "agent", id: decodeURIComponent(agent[1]) };
  if (path === "/inbox") return { kind: "inbox" };
  return null;
}

/** The address under an event: the nearest link, or a row that names one (`data-intent`). */
function hrefAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest("[data-intent], a[href]");
  return el?.getAttribute("data-intent") ?? el?.getAttribute("href") ?? null;
}

/**
 * Handlers for a part of the page (the portal puts them around every screen): a mouse or pen
 * resting on a link or row that opens a run, an agent or the Inbox, or focus reaching one, asks
 * for that page's first call. A finger scrolling past asks nothing (touch pointers are left out;
 * a tap opens the page at once anyway). A row that is not itself a link names its page in
 * `data-intent`.
 */
// DECISION: one listener around the screens, reading the address under the pointer, rather than
// handlers on each row: every link to a detail page is covered, the shared rows in ../ui need no
// new props, and one prefetch per target is kept by `prefetchTarget`.
export function useIntentZone(): {
  onPointerOver: (e: PointerEvent<HTMLElement>) => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
} {
  const store = useApiStore();
  return useMemo(() => {
    const ask = (href: string | null) => {
      const target = href ? targetOf(href) : null;
      if (target) prefetchTarget(store, target);
    };
    return {
      onPointerOver: (e: PointerEvent<HTMLElement>) => {
        if (e.pointerType === "touch") return;
        ask(hrefAt(e.target));
      },
      onFocus: (e: FocusEvent<HTMLElement>) => ask(hrefAt(e.target)),
    };
  }, [store]);
}
