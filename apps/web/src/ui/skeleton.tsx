// Placeholders the size of the content (docs/audit-plan.md 1.3, "The rules for every screen" 3):
// while a screen's data is on its way, grey shapes hold its place so nothing jumps when it arrives.
// The shapes are `aria-hidden`; `Skeleton` around them is the one status a screen reader hears
// ("Loading…", or the caller's words). Styles in ./page.css (`ui-skel*`), tokens only.
import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "../i18n/i18n";
import { cx } from "./cx";

/**
 * The one status around a placeholder: a visually hidden "Loading…" (or `label`) for screen
 * readers, and the shapes, hidden from them. `Loaded` and `Loading` wrap theirs in it; a screen
 * that draws its own skeleton does the same.
 */
export function Skeleton({
  children,
  label,
  className,
  testId,
}: {
  children: ReactNode;
  label?: string | undefined;
  className?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <div role="status" className={cx("ui-skel-wrap", className)} data-testid={testId}>
      <span className="sr-only">{label ?? t("common.loading")}</span>
      {children}
    </div>
  );
}

/** How wide a line of text runs: the whole column, most of it, half, or a word or two. */
export type SkeletonWidth = "full" | "long" | "half" | "short";

const WIDTH: Record<SkeletonWidth, string> = {
  full: "100%",
  long: "80%",
  half: "50%",
  short: "28%",
};

/**
 * One line of text: `text` (body, 14px), `small` (a muted line), `heading` (a section heading)
 * or `title` (a page title). Its box is the line's height, so a line of words takes its place.
 */
export function SkeletonLine({
  width = "full",
  size = "text",
  className,
}: {
  width?: SkeletonWidth | number;
  size?: "small" | "text" | "heading" | "title";
  className?: string;
}) {
  const style: CSSProperties = { width: typeof width === "number" ? width : WIDTH[width] };
  return (
    <span aria-hidden className={cx("ui-skel-line", `ui-skel-line--${size}`, className)}>
      <span className="ui-skel" style={style} />
    </span>
  );
}

/** A few lines of text, the last one shorter, as a paragraph runs. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span aria-hidden className="ui-skel-text">
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonLine
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder lines.
          key={i}
          width={i === lines - 1 && lines > 1 ? "half" : i % 2 ? "long" : "full"}
        />
      ))}
    </span>
  );
}

/** A plain shape of a given height: a chart, a picture, a field. */
export function SkeletonBlock({ height, className }: { height: number; className?: string }) {
  return <span aria-hidden className={cx("ui-skel ui-skel-block", className)} style={{ height }} />;
}

/** A card (`Card` with `pad`): an optional title line, then a few lines of text. */
export function SkeletonCard({ lines = 3, title = true }: { lines?: number; title?: boolean }) {
  return (
    <div aria-hidden className="ds-card ui-skel-card">
      <div className="ui-card__body ui-skel-text">
        {title ? <SkeletonLine width="short" size="heading" /> : null}
        <SkeletonText lines={lines} />
      </div>
    </div>
  );
}

/** A `StatTile`: its label, its figure and its note, the same height as the tile. */
export function SkeletonStat() {
  return (
    <div aria-hidden className="ds-card ui-stat ui-skel-card">
      <SkeletonLine width="half" size="small" />
      <span className="ui-skel-stat__value">
        <span className="ui-skel" />
      </span>
      <SkeletonLine width="long" size="small" />
    </div>
  );
}

/** A `KpiStrip` of `count` stat tiles. */
export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div aria-hidden className="ui-kpis">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder tiles.
        <SkeletonStat key={i} />
      ))}
    </div>
  );
}

/**
 * Table rows in a card: `rows` rows of `columns` cells, each a row's height (`--row-h`), the
 * first column wider, as a name leads a row.
 */
export function SkeletonRows({ rows = 5, columns = 3 }: { rows?: number; columns?: number }) {
  return (
    <div aria-hidden className="ds-card ui-skel-card">
      {Array.from({ length: rows }, (_, r) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder rows.
          key={r}
          className="ui-skel-row"
          style={{ gridTemplateColumns: `2fr repeat(${Math.max(columns - 1, 0)}, 1fr)` }}
        >
          {Array.from({ length: columns }, (_, c) => (
            <SkeletonLine
              // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder cells.
              key={c}
              width={c === 0 ? (r % 2 ? "half" : "long") : "half"}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A page's body while its first load is out: a heading line and a few cards. What `Loaded`
 * shows when the screen gives no skeleton of its own.
 */
export function SkeletonPage({ cards = 2 }: { cards?: number }) {
  return (
    <div aria-hidden className="ui-skel-page">
      <SkeletonLine width="short" size="heading" />
      {Array.from({ length: cards }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder cards.
        <SkeletonCard key={i} title={false} lines={i === 0 ? 3 : 2} />
      ))}
    </div>
  );
}
