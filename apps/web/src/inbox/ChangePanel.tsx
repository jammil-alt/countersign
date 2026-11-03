// The design's "Changes to your tools" panel body (screen 6): NOW on the left, AFTER THIS CHANGE on
// the right, field by field, with the changed values marked.
import { cx } from "../ui/primitives";
import { type ChangeRow, changeRows, fieldLabel, formatValue, isCreate } from "./change";

export function ChangeTables({ before, input }: { before: unknown; input: unknown }) {
  const rows = changeRows(before, input);
  const create = isCreate(before);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2">
      <Side
        testId="change-now"
        title="Now"
        rows={rows}
        pick="now"
        empty={create ? "Not there yet: this change creates it." : "Nothing recorded."}
        hideAll={create}
        className="md:border-r md:border-edge"
      />
      <Side
        testId="change-after"
        title="After this change"
        rows={rows}
        pick="after"
        empty="No fields."
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
  const shown = hideAll ? [] : rows;
  return (
    <section data-testid={testId} aria-label={title} className={cx("p-4", className)}>
      <h4 className="label-caps mb-2 text-secondary">{title}</h4>
      {shown.length === 0 ? (
        <p className="text-sm text-secondary">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-subtle">
              <th className="label-caps px-2.5 py-1.5 text-left font-medium text-secondary">
                Field
              </th>
              <th className="label-caps px-2.5 py-1.5 text-right font-medium text-secondary">
                Value
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
                  className="border-b border-divider last:border-b-0"
                >
                  <td className="px-2.5 py-2 align-top text-body">{fieldLabel(r.field)}</td>
                  <td
                    className={cx(
                      "px-2.5 py-2 text-right align-top font-mono break-words text-primary",
                      marked && "bg-tone-accent font-medium text-tone-accent-ink",
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
