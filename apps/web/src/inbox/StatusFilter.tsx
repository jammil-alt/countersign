// A segmented filter (the Mezonas Segmented, ds-seg: open / resolved, assigned to you / all),
// shared by the inboxes and run lists of both surfaces.
import type { I18n } from "../i18n/i18n";
import { useI18n } from "../i18n/i18n";

/** Open / resolved, in the reader's language. */
export function openResolved({ t }: Pick<I18n, "t">): ["open" | "resolved", string][] {
  return [
    ["open", t("inbox.filter.open")],
    ["resolved", t("inbox.filter.resolved")],
  ];
}

/** The back office's (English) open / resolved. */
export const OPEN_RESOLVED: ["open" | "resolved", string][] = [
  ["open", "Open"],
  ["resolved", "Resolved"],
];

export function StatusFilter<S extends string>({
  value,
  onChange,
  area,
  options,
  label,
}: {
  value: S;
  onChange: (s: S) => void;
  /** testids are `<area>-filter-<option>`. */
  area: string;
  options: [S, string][];
  label?: string;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="ds-seg m-0">
      <legend className="sr-only">{label ?? t("common.filter")}</legend>
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
