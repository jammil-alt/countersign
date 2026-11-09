// R-1 (docs/plan.md §1.80): the Reconciliations screen. Each bank or card account checked against
// QuickBooks (or a deposit against its payout statement): the two balances, the difference, what
// isn't explained, the result and whether a person signed it off. The portal shows the client's
// own; the back office the same for a client it serves. Nothing here names an agent, a prompt or a
// cost.
import type { CSSProperties } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { Badge, EmptyState, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import {
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RECON_STATUS_LABEL,
  type ReconciliationsReport,
} from "./types";

const PACK = "bookkeeping";
const REPORT = "reconciliations";

export function ReconciliationsView({ clientId }: { clientId?: string }) {
  const { t, fmt, intl } = useI18n();
  const portal = useApi(
    apiRoutes.portalPackReport,
    clientId ? null : { params: { pack: PACK, report: REPORT } },
  );
  const ops = useApi(
    apiRoutes.opsClientPackReport,
    clientId ? { params: { id: clientId, pack: PACK, report: REPORT } } : null,
  );
  const { data, error, loading, reload } = clientId ? ops : portal;
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const report = (data?.report ?? { reconciliations: [] }) as unknown as ReconciliationsReport;
  const open = report.reconciliations.filter(
    (r) => r.status === "open" && r.outcome !== "balanced",
  ).length;
  return (
    <div className="flex flex-col gap-6" data-testid="bookkeeping-reconciliations">
      <PageHeader
        title={t("bookkeeping.recons.title")}
        subtitle={t("bookkeeping.recons.description")}
      />
      {open > 0 ? (
        <div>
          <Badge tone="warning">{t("bookkeeping.recons.waiting", { count: open })}</Badge>
        </div>
      ) : null}
      {report.reconciliations.length === 0 ? (
        <EmptyState>{t("bookkeeping.recons.empty")}</EmptyState>
      ) : (
        <div className="dt dt-ana" style={{ "--dt-max-h": "640px" } as CSSProperties}>
          <div className="dt-scroll">
            <table data-testid="bookkeeping-reconciliations-table">
              <thead>
                <tr className="dt-cols">
                  <th>{t("bookkeeping.recons.asOf")}</th>
                  <th>{t("bookkeeping.recons.compared")}</th>
                  <th className="n">{t("bookkeeping.recon.difference")}</th>
                  <th className="n">{t("bookkeeping.recons.unexplained")}</th>
                  <th>{t("bookkeeping.recons.result")}</th>
                  <th>{t("bookkeeping.recons.status")}</th>
                </tr>
              </thead>
              <tbody>
                {report.reconciliations.map((r) => (
                  <tr key={r.id} data-testid="bookkeeping-reconciliation-row">
                    <td>{dayLabel(r.asOf, intl)}</td>
                    <td className="dt-who">
                      <b>{r.aLabel}</b> {fmt.money(r.aClosing, r.currency)} · <b>{r.bLabel}</b>{" "}
                      {fmt.money(r.bClosing, r.currency)}
                    </td>
                    <td className="n ds-num">{fmt.money(r.difference, r.currency)}</td>
                    <td className="n ds-num">{fmt.money(r.residual, r.currency)}</td>
                    <td>
                      <Badge tone={OUTCOME_TONE[r.outcome]}>{t(OUTCOME_LABEL[r.outcome])}</Badge>
                    </td>
                    <td>
                      <Badge tone={r.status === "signed_off" ? "person" : "neutral"}>
                        {t(RECON_STATUS_LABEL[r.status])}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
