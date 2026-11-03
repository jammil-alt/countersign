// A segmented filter (the Mezonas Segmented, ds-seg: open / resolved, assigned to you / all),
// shared by the inboxes and run lists of both surfaces.

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
    <fieldset className="ds-seg m-0">
      <legend className="sr-only">{label}</legend>
      {options.map(([s, text]) => (
        <button
          key={s}
          type="button"
          aria-pressed={value === s}
          data-testid={`${area}-filter-${s}`}
          onClick={() => onChange(s)}
          className="hover:text-ink"
        >
          {text}
        </button>
      ))}
    </fieldset>
  );
}
