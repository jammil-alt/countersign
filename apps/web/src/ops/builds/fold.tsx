// The Builds page is long (owner, 2026-11-19: "a lot happening, hard to manage"). Two ways to make
// it shorter without a scroll inside a scroll: a section's title folds it (kept for this browser),
// and a long list shows its first rows with "Show all" under them.

import { type ReactNode, useState } from "react";
import { Button } from "../../ui/primitives";

const FOLD_KEY = "mezonas.build.folded";

function readFolds(): Record<string, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export interface Fold {
  open: boolean;
  onToggle(): void;
  /** Opens it (a jump to the section). */
  reveal(): void;
  /** Keeps it as it is now for this visit, whatever its default becomes. */
  hold(): void;
  testId: string;
}

/**
 * Whether a section is open: the operator's last choice for it in this browser, else `fallback`
 * (read on every render, so it can follow the build once it loads), until `hold` keeps it as it
 * is for this visit. For Card's `fold`.
 */
// DECISION (owner, 2026-11-21): with decisions closed out on their rows, a default read on every
// render shut the card the moment its last check was done. A row's action holds it where it is
// for this visit, without keeping a choice for the browser.
export function useFold(section: string, fallback = true): Fold {
  const [chosen, setChosen] = useState<boolean | undefined>(() => readFolds()[section]);
  const [held, setHeld] = useState<boolean | undefined>(undefined);
  const open = chosen ?? held ?? fallback;
  const set = (next: boolean) => {
    setChosen(next);
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify({ ...readFolds(), [section]: next }));
    } catch {
      // Folding is a convenience; it just isn't kept.
    }
  };
  return {
    open,
    testId: `build-fold-${section}`,
    onToggle: () => set(!open),
    reveal: () => {
      if (!open) set(true);
    },
    hold: () => {
      if (chosen === undefined && held === undefined) setHeld(open);
    },
  };
}

/** How many rows a long list shows before "Show all". */
export const FIRST_ROWS = 5;

/**
 * The rows to show: the first `first`, plus any row `keep` holds (the one the conversation is on),
 * or all of them once "Show all" is pressed. `more` is the switch to put under the list.
 */
export function useFirstRows<T>(
  rows: readonly T[],
  {
    first = FIRST_ROWS,
    keep,
    noun,
    testId,
  }: { first?: number; keep?: (row: T) => boolean; noun: string; testId: string },
): { shown: readonly T[]; more: ReactNode } {
  const [all, setAll] = useState(false);
  // One or two past the cut aren't worth a click.
  const cut = rows.length > first + 2;
  if (!cut) return { shown: rows, more: null };
  const shown = all ? rows : rows.filter((r, i) => i < first || (keep?.(r) ?? false));
  const hidden = rows.length - shown.length;
  return {
    shown,
    more: (
      <div className="ui-more">
        <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)} data-testid={testId}>
          {all ? "Show fewer" : `Show all ${rows.length} ${noun} (${hidden} more)`}
        </Button>
      </div>
    ),
  };
}
