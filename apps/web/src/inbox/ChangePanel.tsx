// The design's "Changes to your tools" panel body (screen 6), as the SignCard's before and after
// (mz-sign__change): NOW on the left, AFTER THIS CHANGE on the right, field by field, with the
// changed values marked.
import { useI18n } from "../i18n/i18n";
import { cx } from "../ui/primitives";
import { type ChangeRow, changeRows, fieldLabel, formatValue, isCreate } from "./change";

export function ChangeTables({ before, input }: { before: unknown; input: unknown }) {
  const { t } = useI18n();
  const rows = changeRows(before, input);
  const create = isCreate(before);
  return (
    <div className="mz-sign__change">
      <Side
        testId="change-now"
        title={t("change.now")}
        rows={rows}
        pick="now"
        empty={create ? t("change.createsIt") : t("change.nothingRecorded")}
        hideAll={create}
      />
      <Side
        testId="change-after"
        title={t("change.after")}
        rows={rows}
        pick="after"
        empty={t("change.noFields")}
      />
    </div>
  );
}

function Side({
  testId,
  title,
  rows,
  pick,
  empty,
  hideAll,
  className,
}: {
  testId: string;
  title: string;
  rows: ChangeRow[];
  pick: "now" | "after";
  empty: string;
  hideAll?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const shown = hideAll ? [] : rows;
  return (
    <section data-testid={testId} aria-label={title} className={cx("mz-sign__side", className)}>
      <h4 className="eyebrow mb-1.5 text-ink-muted">{title}</h4>
      {shown.length === 0 ? (
        <p className="text-sm text-ink-muted">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="px-1 py-1.5 text-left text-xs font-medium text-ink-muted">
                {t("change.field")}
              </th>
              <th className="px-1 py-1.5 text-right text-xs font-medium text-ink-muted">
                {t("change.value")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const marked = pick === "after" && r.changed;
              return (
                <tr
                  key={r.field}
                  data-testid={`${testId}-row-${r.field}`}
                  data-changed={marked ? "true" : undefined}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-1 py-2 align-top text-ink">{fieldLabel(r.field)}</td>
                  <td
                    className={cx(
                      "px-1 py-2 text-right align-top break-words text-ink figures",
                      marked && "bg-slate-tint px-2 font-medium",
                    )}
                  >
                    {formatValue(r[pick])}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
