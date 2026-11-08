// A row's price history as the design system's sparkline (TableAnalytical: `dt-spark`, a 1.5px
// `data-line` polyline with an end dot ringed in surface). Only the mark wears a data colour; the
// label is text, for screen readers too, in the reader's words (the caller writes it). Prices are
// decimal strings: the chart's scale is the one place they become numbers, and only to place points.

export function Sparkline({
  points,
  label,
  title,
  width = 120,
  height = 24,
}: {
  points: { on: string; price: string }[];
  /** What a screen reader says: the item, how many prices and their days. */
  label: string;
  /** The hover text. */
  title: string;
  width?: number;
  height?: number;
}) {
  if (points.length === 0) return <span className="text-ink-muted">–</span>;
  const values = points.map((p) => Number(p.price));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const dx = points.length > 1 ? (width - 6) / (points.length - 1) : 0;
  const y = (v: number) => height - 3 - ((v - min) / (max - min || 1)) * (height - 6);
  const xy = values.map((v, i) => [3 + i * dx, y(v)] as const);
  const last = xy.at(-1) ?? [3, height / 2];
  return (
    <svg
      className="dt-spark"
      width={width}
      height={height}
      role="img"
      aria-label={label}
      data-testid="materials-sparkline"
    >
      <title>{title}</title>
      {points.length > 1 ? (
        <polyline
          className="ln"
          points={xy.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`).join(" ")}
        />
      ) : null}
      <circle className="dot" cx={last[0]} cy={last[1]} r={3} />
    </svg>
  );
}
