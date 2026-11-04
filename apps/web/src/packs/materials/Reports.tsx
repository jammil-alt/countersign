// The Materials pack's client reports (ARCHITECTURE §12.2, §15): Price watch (item × vendor with
// the last price, its change on the price before and a 90-day sparkline; alerts with the invoices
// behind them) and Catalog, each with CSV export. The portal shows the client's own; the back
// office shows the same views for any client it serves (`clientId`).
import { type CSSProperties, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { money } from "../../portal/documents";
import { Icon } from "../../ui/icons";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { Sparkline } from "./Sparkline";
import {
  ALERT_LABEL,
  CATEGORY_LABEL,
  type CatalogReport,
  type CatalogRow,
  type PriceWatchAlert,
  type PriceWatchReport,
  type PriceWatchRow,
  UNIT_LABEL,
} from "./types";

const PACK = "materials";

/** One report for the portal (no client) or a client in the back office. */
function useReport<T>(report: string, clientId: string | undefined) {
  const portal = useApi(
    apiRoutes.portalPackReport,
    clientId ? null : { params: { pack: PACK, report } },
  );
  const ops = useApi(
    apiRoutes.opsClientPackReport,
    clientId ? { params: { id: clientId, pack: PACK, report } } : null,
  );
  const state = clientId ? ops : portal;
  return { ...state, data: state.data?.report as T | undefined };
}

function csvHref(report: string, clientId: string | undefined): string {
  return clientId
    ? `/api/ops/clients/${clientId}/reports/${PACK}/${report}.csv`
    : `/api/reports/${PACK}/${report}.csv`;
}

function CsvLink({ report, clientId }: { report: string; clientId?: string | undefined }) {
  return (
    <a
      href={csvHref(report, clientId)}
      download
      className={buttonClass("secondary")}
      data-testid={`materials-${report}-csv`}
    >
      <Icon name="upload" size={16} className="ds-icon rotate-180" />
      Download CSV
    </a>
  );
}

const perUnit = (uom: string) => (uom === "each" ? "each" : `/ ${UNIT_LABEL[uom] ?? uom}`);

function Delta({ pct }: { pct: string | null }) {
  if (pct === null) return <span className="text-ink-muted">–</span>;
  const n = Number(pct);
  if (n === 0) return <span className="dt-delta">0%</span>;
  const up = n > 0;
  return (
    <span className="dt-delta">
      <span className={up ? "up" : "down"} aria-hidden="true">
        {up ? "▲" : "▼"}
      </span>
      <span className="sr-only">{up ? "up" : "down"}</span>
      {up ? "+" : "−"}
      {Math.abs(n).toFixed(1)}%
    </span>
  );
}

function Stat({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note: string;
  testId: string;
}) {
  return (
    <Card className="p-5" testId={testId}>
      <p className="eyebrow text-ink-muted">{label}</p>
      <p className="mt-2 text-2xl font-medium tabular-nums text-ink">{value}</p>
      <p className="mt-1 text-sm text-ink-muted">{note}</p>
    </Card>
  );
}

function AlertCard({ alert, clientId }: { alert: PriceWatchAlert; clientId?: string | undefined }) {
  const open = alert.status === "open";
  return (
    <article className="mz-sign" data-testid={`materials-alert-${alert.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Signal means it waits on you, always with a word. */}
          <Badge tone={open ? "warning" : "neutral"}>
            {open
              ? (ALERT_LABEL[alert.kind] ?? "Alert")
              : alert.status === "accepted"
                ? "Accepted"
                : "Dismissed"}
          </Badge>
        </div>
        {alert.dollarImpact && Number(alert.dollarImpact) !== 0 ? (
          <span className="text-sm tabular-nums text-ink" data-testid="materials-alert-impact">
            {money(alert.dollarImpact)} at stake
          </span>
        ) : null}
      </div>
      <h3 className="mz-sign__title text-lg leading-6 font-medium">{alert.title}</h3>
      <p className="text-sm text-ink-muted">{alert.body}</p>
      {alert.documents.length > 0 ? (
        <div className="mz-sign__receipts">
          {alert.documents.map((d) =>
            clientId ? (
              <span key={d.id} className="mz-receipt" data-testid="materials-alert-receipt">
                <Icon name="receipt" size={14} className="ds-icon" />
                {d.label}
              </span>
            ) : (
              <Link
                key={d.id}
                to={`/documents/${d.id}`}
                className="mz-receipt"
                data-testid="materials-alert-receipt"
              >
                <Icon name="receipt" size={14} className="ds-icon" />
                {d.label}
              </Link>
            ),
          )}
        </div>
      ) : null}
    </article>
  );
}

type SortKey = "item" | "change" | "price";

function sortRows(rows: PriceWatchRow[], key: SortKey): PriceWatchRow[] {
  const out = [...rows];
  if (key === "change")
    out.sort((a, b) => Number(b.changePct ?? -1e9) - Number(a.changePct ?? -1e9));
  else if (key === "price") out.sort((a, b) => Number(b.lastPrice) - Number(a.lastPrice));
  else out.sort((a, b) => a.item.localeCompare(b.item) || a.vendor.localeCompare(b.vendor));
  return out;
}

export function PriceWatchView({
  clientId,
  clientName,
}: {
  clientId?: string;
  clientName?: string;
}) {
  const { data, error, loading, reload } = useReport<PriceWatchReport>("prices", clientId);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("item");
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = data?.rows ?? [];
    return sortRows(
      q ? all.filter((r) => `${r.item} ${r.vendor}`.toLowerCase().includes(q)) : all,
      sort,
    );
  }, [data, filter, sort]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const open = data.alerts.filter((a) => a.status === "open");
  const closed = data.alerts.filter((a) => a.status !== "open");
  const sortHeader = (key: SortKey, label: string, numeric = false) => (
    <th
      className={numeric ? "n" : ""}
      aria-sort={sort === key ? (key === "item" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="dt-sort" onClick={() => setSort(key)}>
        {label}
      </button>
    </th>
  );

  return (
    <div data-testid="materials-price-watch">
      <PageHeader
        title="Price watch"
        subtitle={`${clientName ? `${clientName} · ` : ""}What each material cost, by vendor, in one unit. Prices as of ${data.asOf}.`}
        actions={<CsvLink report="prices" clientId={clientId} />}
      />
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat
          label="Open alerts"
          value={String(data.totals.openAlerts)}
          note={
            data.totals.openAlerts === 1 ? "price change to look at" : "price changes to look at"
          }
          testId="materials-stat-alerts"
        />
        <Stat
          label="At stake"
          value={money(data.totals.dollarImpact)}
          note="over the last 90 days' quantities"
          testId="materials-stat-impact"
        />
        <Stat
          label="Watched"
          value={`${data.totals.items} items`}
          note={`from ${data.totals.vendors} vendors`}
          testId="materials-stat-items"
        />
      </div>

      <section className="mb-8" data-testid="materials-alerts">
        <SectionLabel>Alerts</SectionLabel>
        {open.length === 0 ? (
          <EmptyState>No open alerts. We tell you here when a price moves.</EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {open.map((a) => (
              <AlertCard key={a.id} alert={a} clientId={clientId} />
            ))}
          </div>
        )}
        {closed.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-ink-muted">
              {closed.length} closed alerts
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {closed.map((a) => (
                <AlertCard key={a.id} alert={a} clientId={clientId} />
              ))}
            </div>
          </details>
        ) : null}
      </section>

      {data.rows.length === 0 ? (
        <EmptyState>
          No prices yet. They appear here once Pia has read your first invoice.
        </EmptyState>
      ) : (
        <div className="dt dt-ana" style={{ "--dt-max-h": "640px" } as CSSProperties}>
          <div className="dt-bar">
            <span className="dt-title">Prices by item and vendor</span>
            <span className="ds-num text-ink-muted">{rows.length} rows</span>
            <span className="dt-grow" />
            <input
              className="ds-input dt-search"
              placeholder="Filter items or vendors"
              aria-label="Filter items or vendors"
              data-testid="materials-prices-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="dt-scroll">
            <table data-testid="materials-prices-table">
              <thead>
                <tr className="dt-cols">
                  {sortHeader("item", "Item")}
                  <th>Vendor</th>
                  {sortHeader("price", "Last price", true)}
                  {sortHeader("change", "Change", true)}
                  <th>90 days</th>
                  <th className="n">Last bought</th>
                  <th className="n">Alerts</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.catalogItemId}:${r.vendorId}`} data-testid="materials-price-row">
                    <td className="dt-who">
                      <b>{r.item}</b>
                      <span>
                        {CATEGORY_LABEL[r.category] ?? r.category} · {r.purchases90} purchases in 90
                        days
                      </span>
                    </td>
                    <td>{r.vendor}</td>
                    <td className="n">
                      {money(r.lastPrice)}{" "}
                      <span className="text-ink-muted">{perUnit(r.standardUom)}</span>
                    </td>
                    <td className="n">
                      <Delta pct={r.changePct} />
                    </td>
                    <td>
                      <Sparkline points={r.series} label={`${r.item} at ${r.vendor}`} />
                    </td>
                    <td className="n">{r.lastOn}</td>
                    <td className="n">
                      {r.openAlerts > 0 ? (
                        <Badge tone="warning">
                          {r.openAlerts === 1 ? "1 alert" : `${r.openAlerts} alerts`}
                        </Badge>
                      ) : (
                        <span className="text-ink-muted">–</span>
                      )}
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

/**
 * The back office's catalog merge: this item is a duplicate of another in the same category and
 * unit (the only merges the pack allows); its vendor names and price history move there.
 */
function MergeControl({
  clientId,
  item,
  items,
  onDone,
}: {
  clientId: string;
  item: CatalogRow;
  items: CatalogRow[];
  onDone: () => void;
}) {
  const client = useApiClient();
  const options = items.filter(
    (o) => o.id !== item.id && o.category === item.category && o.standardUom === item.standardUom,
  );
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (options.length === 0) return <span className="muted">–</span>;
  return (
    <span className="flex items-center gap-2" data-testid={`materials-merge-${item.id}`}>
      <select
        className="ds-select"
        aria-label={`Merge ${item.name} into`}
        value={into}
        onChange={(e) => setInto(e.target.value)}
      >
        <option value="">Same as…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={!into || busy}
        data-testid="materials-merge-submit"
        onClick={async () => {
          setBusy(true);
          setProblem(null);
          try {
            await client.call(apiRoutes.opsClientPackAction, {
              params: { id: clientId, pack: PACK, action: "merge-items" },
              body: { fromId: item.id, intoId: into },
            });
            onDone();
          } catch {
            setProblem("We couldn't merge these.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Merge
      </Button>
      {problem ? <span className="text-sm text-risk-ink">{problem}</span> : null}
    </span>
  );
}

export function CatalogView({ clientId, clientName }: { clientId?: string; clientName?: string }) {
  const { data, error, loading, reload } = useReport<CatalogReport>("catalog", clientId);
  const [filter, setFilter] = useState("");
  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = data?.items ?? [];
    return q ? all.filter((i) => i.name.toLowerCase().includes(q)) : all;
  }, [data, filter]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  return (
    <div data-testid="materials-catalog">
      <PageHeader
        title="Catalog"
        subtitle={`${clientName ? `${clientName} · ` : ""}${data.items.length} materials your invoice lines are matched to.`}
        actions={<CsvLink report="catalog" clientId={clientId} />}
      />
      {data.items.length === 0 ? (
        <EmptyState>The catalog is empty. Items appear as Pia matches invoice lines.</EmptyState>
      ) : (
        <div className="dt dt-ledger" style={{ "--dt-max-h": "640px" } as CSSProperties}>
          <div className="dt-bar">
            <span className="dt-title">Items</span>
            <span className="ds-num text-ink-muted">{items.length}</span>
            <span className="dt-grow" />
            <input
              className="ds-input dt-search"
              placeholder="Filter items"
              aria-label="Filter items"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="dt-scroll">
            <table data-testid="materials-catalog-table">
              <thead>
                <tr className="dt-cols">
                  <th>Item</th>
                  <th>Category</th>
                  <th>Unit</th>
                  <th>Attributes</th>
                  <th className="n">Vendors</th>
                  <th className="n">Purchases</th>
                  <th className="n">Last price</th>
                  <th className="n">Last bought</th>
                  {clientId ? <th>Merge</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} data-testid="materials-catalog-row">
                    <td>{i.name}</td>
                    <td>{CATEGORY_LABEL[i.category] ?? i.category}</td>
                    <td>{UNIT_LABEL[i.standardUom] ?? i.standardUom}</td>
                    <td className="muted">
                      {Object.entries(i.attributes)
                        .filter(([k]) => !k.endsWith("_mm"))
                        .map(([k, v]) => `${k.replace(/_/g, " ")} ${v.replace(/_/g, " ")}`)
                        .join(" · ")}
                    </td>
                    <td className="n">{i.vendors}</td>
                    <td className="n">{i.purchases}</td>
                    <td className="n">{i.lastPrice ? money(i.lastPrice) : "–"}</td>
                    <td className="n">{i.lastOn ?? "–"}</td>
                    {clientId ? (
                      <td>
                        <MergeControl
                          clientId={clientId}
                          item={i}
                          items={data.items}
                          onDone={reload}
                        />
                      </td>
                    ) : null}
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

/** Links to a pack's reports, for the portal's Reports page and the client page. */
export function PackReportLinks({
  screens,
  base,
}: {
  screens: { route: string; title: string }[];
  base: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {screens.map((s) => (
        <Link key={s.route} to={`${base}${s.route}`} className={buttonClass("secondary")}>
          <Icon name="report" size={16} className="ds-icon" />
          {s.title}
        </Link>
      ))}
    </div>
  );
}
