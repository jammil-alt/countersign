// Two layout helpers for rows of tiles and chips (staging QA, 2026-11-22): KPI tiles that wrapped
// 4+1 (4+2 on Sales and Build), and filter chips cut off at the row's end with nothing to say more
// were there.
import { useEffect, useLayoutEffect, useState } from "react";

/** The design system's narrowest KPI tile (`.ds-kpis`, `minmax(176px, 1fr)`). */
export const KPI_MIN_PX = 176;

/**
 * How many columns `n` tiles take in `width` so the rows come out even: all in one row when they
 * fit, else the fewest rows, shared out as evenly as they go (5 in four places: 3 + 2, 6: 3 + 3,
 * never 4 + 1 or 4 + 2). Never under two columns for two tiles or more, as the design system's
 * phone layout has it.
 */
export function evenColumns(n: number, width: number, min = KPI_MIN_PX, gap = 12): number {
  if (n <= 1) return 1;
  const fit = Math.max(2, Math.floor((width + gap) / (min + gap)));
  if (fit >= n) return n;
  const rows = Math.ceil(n / fit);
  return Math.ceil(n / rows);
}

// DECISION: measured in the browser (a ResizeObserver on the row), not CSS alone: the grid's
// `auto-fit` cannot balance its rows, and the column count depends on how many tiles there are.
// Without a ResizeObserver (tests, old browsers) the design system's own auto-fit grid stays.
/** The `gridTemplateColumns` that lays `n` tiles out evenly in the element, once it is measured. */
export function useEvenColumns(
  ref: { current: HTMLElement | null },
  n: number,
): { gridTemplateColumns: string } | undefined {
  const [cols, setCols] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 12;
      setCols(evenColumns(n, width, KPI_MIN_PX, gap));
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [ref, n]);
  return cols === null ? undefined : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
}

/**
 * Which ends of a row that scrolls sideways have more past them: `"start"`, `"end"`, both
 * (`"start end"`) or none (undefined), for a fade at that edge. Read on scroll and on resize.
 */
export function useScrollEdges(ref: { current: HTMLElement | null }): string | undefined {
  const [edges, setEdges] = useState<string | undefined>(undefined);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges(start && end ? "start end" : start ? "start" : end ? "end" : undefined);
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const seen = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    seen?.observe(el);
    for (const child of el.children) seen?.observe(child);
    return () => {
      el.removeEventListener("scroll", read);
      seen?.disconnect();
    };
  }, [ref]);
  return edges;
}
