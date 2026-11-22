// Bills to pay (Plan entry §1.233): the AP pack's report screen, a week's approve-to-pay list read
// only (a person decides on the card), with the weeks before it. The portal shows the client's own;
// the back office the same for a client it serves. Nothing here names an agent, a prompt or a cost,
// and nothing is paid. Loaded when opened (scripts/web-size.mjs).
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { ErrorNotice, Loading, PageHeader } from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import { PayListView } from "./PayList";
import type { PayList } from "./types";

const PACK = "ap";
const REPORT = "bills";

interface Report {
  weeks: string[];
  current: string;
  list: PayList;
}

export function BillsToPayView({ clientId }: { clientId?: string }) {
  const { t, intl } = useI18n();
  const [week, setWeek] = useState<string | null>(null);
  const query = week ? { week } : {};
  const portal = useApi(
    apiRoutes.portalPackReport,
    clientId ? null : { params: { pack: PACK, report: REPORT }, query },
  );
  const ops = useApi(
    apiRoutes.opsClientPackReport,
    clientId ? { params: { id: clientId, pack: PACK, report: REPORT }, query } : null,
  );
  const { data, error, loading, reload } = clientId ? ops : portal;
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const report = data?.report as unknown as Report | undefined;
  if (!report) return null;
  const weeks = [...new Set([report.current, ...report.weeks])].sort().reverse();
  return (
    <div className="flex flex-col gap-6" data-testid="ap-bills">
      <PageHeader title={t("ap.bills.title")} subtitle={t("ap.bills.description")} />
      <select
        className="ds-select w-fit"
        aria-label={t("ap.list.week")}
        value={week ?? report.list.week}
        onChange={(e) => setWeek(e.target.value)}
      >
        {weeks.map((w) => (
          <option key={w} value={w}>
            {t("ap.list.weekOf", { day: dayLabel(w, intl) })}
          </option>
        ))}
      </select>
      <PayListView list={report.list} />
    </div>
  );
}

/** The portal's screen (the registry's `/reports/ap/bills`). */
export function PortalBillsToPayScreen() {
  return <BillsToPayView />;
}
