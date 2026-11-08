// P-9: quotes compared, as a table (docs/plan.md §1.71): a row per line asked, a column per vendor
// with its price per unit and what the line would cost, and each vendor's total. The comparison is
// the pack's, made in code (one unit, one currency); the best offer on a line is in bold. Shared by
// the request page and the vendor choice card.
import type { CSSProperties } from "react";
import { useI18n } from "../../i18n/i18n";
import type { Comparison } from "./types";

export function CompareTable({ comparison }: { comparison: Comparison }) {
  const { t, fmt } = useI18n();
  const vendors = comparison.vendors;
  return (
    <div className="dt dt-ana" style={{ "--dt-max-h": "480px" } as CSSProperties}>
      <div className="dt-scroll">
        <table data-testid="materials-compare-table">
          <thead>
            <tr className="dt-cols">
              <th>{t("materials.request.col.item")}</th>
              <th className="n">{t("materials.request.col.qty")}</th>
              {vendors.map((v) => (
                <th key={v.quoteRequestId} className="n">
                  {v.vendorName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.lines.map((l) => (
              <tr key={l.requestLineId} data-testid="materials-compare-row">
                <td>{l.description}</td>
                <td className="n">{[fmt.figure(l.qty), l.unit].filter(Boolean).join(" ")}</td>
                {vendors.map((v) => {
                  const o = l.offers.find((x) => x.quoteRequestId === v.quoteRequestId);
                  const best = l.best?.quoteRequestId === v.quoteRequestId;
                  return (
                    <td key={v.quoteRequestId} className={best ? "n font-medium" : "n"}>
                      {!o
                        ? t("materials.request.notQuoted")
                        : !o.available
                          ? t("materials.request.unavailable")
                          : [
                              o.unitPrice
                                ? `${fmt.unitPrice(o.unitPrice, o.currency)}${o.unit ? ` / ${o.unit}` : ""}`
                                : null,
                              o.lineTotal ? fmt.money(o.lineTotal, o.currency) : null,
                              o.leadTimeDays !== null
                                ? t("materials.request.lead", { count: o.leadTimeDays })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr data-testid="materials-compare-total">
              <td className="font-medium">{t("materials.request.col.total")}</td>
              <td />
              {vendors.map((v) => (
                <td key={v.quoteRequestId} className="n font-medium">
                  {fmt.money(v.total, v.currency ?? undefined)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
