// A quiet segmented filter (open / resolved, assigned to you / all), shared by the inboxes and
// run lists of both surfaces.
import { cx } from "../ui/primitives";

export const OPEN_RESOLVED: ["open" | "resolved", string][] = [
  ["open", "Open"],
  ["resolved", "Resolved"],
];

export function StatusFilter<S extends string>({
  value,
  onChange,
  area,
  options,
  label = "Filter",
}: {
  value: S;
  onChange: (s: S) => void;
  /** testids are `<area>-filter-<option>`. */
  area: string;
  options: [S, string][];
  label?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex rounded-md border border-control bg-card p-0.5"
    >
      {options.map(([s, text]) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={value === s}
          data-testid={`${area}-filter-${s}`}
          onClick={() => onChange(s)}
          className={cx(
            "rounded-sm px-3 py-1 text-sm",
            value === s ? "bg-selected font-medium text-selected-ink" : "text-body hover:bg-subtle",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
