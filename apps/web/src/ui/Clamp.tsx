// Text cut to a few lines, with its full words in a tooltip that opens at once on hover or focus.
// The browser's own `title` waits about a second and can't be styled, so tables use this instead.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";

const LINES = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
} as const;

/** How long the pointer rests before the tooltip opens: enough to skip a pass across the table. */
const OPEN_MS = 120;
const GAP = 6;

/**
 * Children cut to `lines` lines. The tooltip shows `tip` when given (always, as it says more than
 * the cell, unless `onlyWhenCut`), else the children's own text, only when it was cut. It sits on the page (a portal), so a
 * table's scrolling box never clips it, and closes on leave, blur, scroll or Escape.
 */
export function Clamp({
  lines = 3,
  tip,
  onlyWhenCut = false,
  className,
  testId,
  children,
}: {
  lines?: keyof typeof LINES;
  tip?: string | null | undefined;
  /** Show `tip` only when the text was cut: it words the cell's own text better than the DOM does. */
  onlyWhenCut?: boolean;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();
  const [shown, setShown] = useState<{ text: string; x: number; y: number; above: boolean } | null>(
    null,
  );

  const open = () => {
    const el = ref.current;
    if (!el) return;
    const cut = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    const text = cut || (tip && !onlyWhenCut) ? (tip ?? el.textContent?.trim()) : null;
    if (!text) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const box = el.getBoundingClientRect();
      // Below the cell, or above it near the bottom of the window.
      const above = box.bottom + 80 > window.innerHeight;
      setShown({
        text,
        x: Math.min(box.left, window.innerWidth - 336),
        y: above ? box.top - GAP : box.bottom + GAP,
        above,
      });
    }, OPEN_MS);
  };
  const close = () => {
    window.clearTimeout(timer.current);
    setShown(null);
  };

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [shown]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <>
      <span
        ref={ref}
        className={cx(LINES[lines], className)}
        data-testid={testId}
        data-tip={tip ?? undefined}
        aria-describedby={shown ? id : undefined}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        {children}
      </span>
      {shown
        ? createPortal(
            <span
              id={id}
              role="tooltip"
              className={cx("ds-tooltip ui-tip", shown.above && "ui-tip--above")}
              style={{ left: Math.max(8, shown.x), top: shown.y }}
            >
              {shown.text}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
