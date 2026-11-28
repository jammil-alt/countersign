// Unsaved edits on the step builder (owner, 2026-11-26: a reload, the back button or another tab
// lost them silently). Two guards, no autosave: every save is a version kept for good (invariant 3),
// so saving each edit would bury the history.
// - Leaving: the browser asks before a reload or a close, and a link inside the app asks first.
// - Coming back: the edits are kept in this browser, per agent and workflow, with the version they
//   were made on; opened on that same version, the builder offers them back.
import { canonicalJson } from "@countersign/core";
import { useEffect, useRef } from "react";
import type { Workflow } from "./types";

const PREFIX = "countersign:steps-unsaved:";

export interface KeptEdits {
  /** The version the edits were made on. */
  baseId: string;
  workflow: Workflow;
  /** When they were last kept (ISO). */
  at: string;
}

const keyOf = (agentId: string, slug: string) => `${PREFIX}${agentId}:${slug}`;

export function readKept(agentId: string, slug: string): KeptEdits | null {
  try {
    const raw = window.localStorage.getItem(keyOf(agentId, slug));
    return raw ? (JSON.parse(raw) as KeptEdits) : null;
  } catch {
    return null;
  }
}

export function forgetKept(agentId: string, slug: string): void {
  try {
    window.localStorage.removeItem(keyOf(agentId, slug));
  } catch {
    // Storage may be blocked: nothing was kept.
  }
}

/** Keeps the edits while they are unsaved, and forgets them once saved. */
export function useKeepUnsaved(input: {
  agentId: string;
  slug: string;
  baseId: string;
  workflow: Workflow;
  dirty: boolean;
  /** Off while kept edits are being offered back, so the offer isn't overwritten. */
  enabled: boolean;
}): void {
  const { agentId, slug, baseId, workflow, dirty, enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    try {
      if (dirty) {
        const kept: KeptEdits = { baseId, workflow, at: new Date().toISOString() };
        window.localStorage.setItem(keyOf(agentId, slug), JSON.stringify(kept));
      } else forgetKept(agentId, slug);
    } catch {
      // Storage may be blocked or full: the leave guards still hold.
    }
  }, [agentId, slug, baseId, workflow, dirty, enabled]);
}

export const LEAVE_WORDS = "You have changes that aren't saved. Leave anyway?";

/** While `dirty`: the browser asks before a reload or a close; a link in the app asks first. */
export function useLeaveGuard(dirty: boolean): void {
  const on = useRef(dirty);
  on.current = dirty;
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!on.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    // A link inside the app (the router's own anchors): asked in the capture phase, before the
    // router takes it. A link that opens elsewhere (a new tab, a download) leaves this page as is.
    const onClick = (e: MouseEvent) => {
      if (!on.current || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      if (!window.confirm(LEAVE_WORDS)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
}

/** Kept edits worth offering: made on this version, and not what it already holds. */
export function keptToOffer(
  kept: KeptEdits | null,
  baseId: string,
  start: Workflow,
): KeptEdits | null {
  if (!kept || kept.baseId !== baseId) return null;
  return canonicalJson(kept.workflow) === canonicalJson(start) ? null : kept;
}
