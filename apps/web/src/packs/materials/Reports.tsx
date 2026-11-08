// The Materials pack's client reports (ARCHITECTURE §12.2, §15): Price watch (item × vendor with
// the last price, its change on the price before and a 90-day sparkline; alerts with the invoices
// behind them) and Catalog, each with CSV export. The portal shows the client's own; the back
// office shows the same views for any client it serves (`clientId`).
//
// Words come from the message catalog (`materials.*`), and numbers, money and days go through the
// reader's locale; the back office reads them in English. Item and vendor names, alert texts and
// catalog attributes are the pack's data and show as written. The catalog merge is back office
// only, so its words stay English, as on the other back-office screens.
import { type CSSProperties, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { type I18n, useI18n } from "../../i18n/i18n";
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
import { dayLabel } from "../../usage/format";
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
    ? `/api/ops/clients/${clientId}/reports/${PACK}/${report}/csv`
    : `/api/reports/${PACK}/${report}/csv`;
}

function CsvLink({ report, clientId }: { report: string; clientId?: string | undefined }) {
  const { t } = useI18n();
  return (
    <a
      href={csvHref(report, clientId)}
      download
      className={buttonClass("secondary")}
      data-testid={`materials-${report}-csv`}
    >
      <Icon name="upload" size={16} className="ds-icon rotate-180" />
      {t("materials.downloadCsv")}
    </a>
  );
}

const unitWord = (uom: string, { t }: Pick<I18n, "t">) => {
  const key = UNIT_LABEL[uom];
  return key ? t(key) : uom;
};

const categoryWord = (category: string, { t }: Pick<I18n, "t">) => {
  const key = CATEGORY_LABEL[category];
  return key ? t(key) : category;
};

/** "each", or "/ sheet": what a price is for. */
const perUnit = (uom: string, i18n: Pick<I18n, "t">) =>
  uom === "each"
    ? i18n.t("materials.each")
    : i18n.t("materials.perUnit", { unit: unitWord(uom, i18n) });

/** A `YYYY-MM-DD` day in the reader's locale, or a dash. */
const day = (on: string | null | undefined, intl: string) => (on ? dayLabel(on, intl) : "–");

function Delta({ pct }: { pct: string | null }) {
  const { t, intl } = useI18n();
  if (pct === null) return <span className="text-ink-muted">–</span>;
  // A percentage, not an amount: a number is fine here, formatted in the reader's locale.
  const n = Number(pct);
  const share = (places: number) =>
    new Intl.NumberFormat(intl, {
      style: "percent",
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    });
  if (n === 0) return <span className="dt-delta">{share(0).format(0)}</span>;
  const up = n > 0;
  return (
    <span className="dt-delta">
      <span className={up ? "up" : "down"} aria-hidden="true">
        {up ? "▲" : "▼"}
      </span>
      <span className="sr-only">{t(up ? "materials.change.up" : "materials.change.down")}</span>
      {up ? "+" : "−"}
      {share(1).format(Math.abs(n) / 100)}
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

function alertWord(alert: PriceWatchAlert, { t }: Pick<I18n, "t">): string {
  if (alert.status === "accepted") return t("materials.alert.accepted");
  if (alert.status !== "open") return t("materials.alert.dismissed");
  const key = ALERT_LABEL[alert.kind];
  return key ? t(key) : t("materials.alert.kind.other");
}

function AlertCard({ alert, clientId }: { alert: PriceWatchAlert; clientId?: string | undefined }) {
  const i18n = useI18n();
  const open = alert.status === "open";
  return (
    <article className="mz-sign" data-testid={`materials-alert-${alert.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Signal means it waits on you, always with a word. */}
          <Badge tone={open ? "warning" : "neutral"}>{alertWord(alert, i18n)}</Badge>
        </div>
        {alert.dollarImpact && Number(alert.dollarImpact) !== 0 ? (
          <span className="text-sm tabular-nums text-ink" data-testid="materials-alert-impact">
            {i18n.t("materials.alert.atStake", { amount: i18n.fmt.money(alert.dollarImpact) })}
          </span>
        ) : null}
      </div>
      {/* The alert's own title and body are the pack's text, as written. */}
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

function sortRows(rows: PriceWatchRow[], key: SortKey, intl: string): PriceWatchRow[] {
  const out = [...rows];
  if (key === "change")
    out.sort((a, b) => Number(b.changePct ?? -1e9) - Number(a.changePct ?? -1e9));
  else if (key === "price") out.sort((a, b) => Number(b.lastPrice) - Number(a.lastPrice));
  else
    out.sort(
      (a, b) => a.item.localeCompare(b.item, intl) || a.vendor.localeCompare(b.vendor, intl),
    );
  return out;
}

export function PriceWatchView({
  clientId,
  clientName,
}: {
  clientId?: string;
  clientName?: string;
}) {
  const i18n = useI18n();
  const { t, fmt, intl } = i18n;
  const { data, error, loading, reload } = useReport<PriceWatchReport>("prices", clientId);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("item");
  const rows = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase(intl);
    const all = data?.rows ?? [];
    return sortRows(
      q ? all.filter((r) => `${r.item} ${r.vendor}`.toLocaleLowerCase(intl).includes(q)) : all,
      sort,
      intl,
    );
  }, [data, filter, sort, intl]);

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
  const subtitle = t("materials.prices.subtitle", { date: dayLabel(data.asOf, intl) });

  return (
    <div data-testid="materials-price-watch">
      <PageHeader
        title={t("materials.prices.title")}
        subtitle={clientName ? `${clientName} · ${subtitle}` : subtitle}
        actions={<CsvLink report="prices" clientId={clientId} />}
      />
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat
          label={t("materials.stat.openAlerts")}
          value={fmt.number(data.totals.openAlerts)}
          note={t("materials.stat.openAlertsNote", { count: data.totals.openAlerts })}
          testId="materials-stat-alerts"
        />
        <Stat
          label={t("materials.stat.atStake")}
          value={fmt.money(data.totals.dollarImpact)}
          note={t("materials.stat.atStakeNote")}
          testId="materials-stat-impact"
        />
        <Stat
          label={t("materials.stat.watched")}
          value={t("materials.stat.items", { count: data.totals.items })}
          note={t("materials.stat.vendors", { count: data.totals.vendors })}
          testId="materials-stat-items"
        />
      </div>

      <section className="mb-8" data-testid="materials-alerts">
        <SectionLabel>{t("materials.alerts.title")}</SectionLabel>
        {open.length === 0 ? (
          <EmptyState>{t("materials.alerts.none")}</EmptyState>
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
              {t("materials.alerts.closed", { count: closed.length })}
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
        <EmptyState>{t("materials.prices.none")}</EmptyState>
      ) : (
        <div className="dt dt-ana" style={{ "--dt-max-h": "640px" } as CSSProperties}>
          <div className="dt-bar">
            <span className="dt-title">{t("materials.prices.table")}</span>
            <span className="ds-num text-ink-muted">
              {t("materials.prices.rows", { count: rows.length })}
            </span>
            <span className="dt-grow" />
            <input
              className="ds-input dt-search"
              placeholder={t("materials.prices.filter")}
              aria-label={t("materials.prices.filter")}
              data-testid="materials-prices-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="dt-scroll">
            <table data-testid="materials-prices-table">
              <thead>
                <tr className="dt-cols">
                  {sortHeader("item", t("materials.col.item"))}
                  <th>{t("materials.col.vendor")}</th>
                  {sortHeader("price", t("materials.col.lastPrice"), true)}
                  {sortHeader("change", t("materials.col.change"), true)}
                  <th>{t("materials.col.days90")}</th>
                  <th className="n">{t("materials.col.lastBought")}</th>
                  <th className="n">{t("materials.col.alerts")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const what = t("materials.prices.at", { item: r.item, vendor: r.vendor });
                  const first = r.series[0]?.on;
                  const last = r.series.at(-1)?.on;
                  return (
                    <tr key={`${r.catalogItemId}:${r.vendorId}`} data-testid="materials-price-row">
                      <td className="dt-who">
                        <b>{r.item}</b>
                        <span>
                          {categoryWord(r.category, i18n)} ·{" "}
                          {t("materials.prices.purchases90", { count: r.purchases90 })}
                        </span>
                      </td>
                      <td>{r.vendor}</td>
                      <td className="n">
                        {fmt.unitPrice(r.lastPrice)}{" "}
                        <span className="text-ink-muted">{perUnit(r.standardUom, i18n)}</span>
                      </td>
                      <td className="n">
                        <Delta pct={r.changePct} />
                      </td>
                      <td>
                        <Sparkline
                          points={r.series}
                          label={t("materials.spark.label", {
                            what,
                            count: r.series.length,
                            from: day(first, intl),
                            to: day(last, intl),
                          })}
                          title={t("materials.spark.title", { what, count: r.series.length })}
                        />
                      </td>
                      <td className="n">{day(r.lastOn, intl)}</td>
                      <td className="n">
                        {r.openAlerts > 0 ? (
                          <Badge tone="warning">
                            {t("materials.prices.alerts", { count: r.openAlerts })}
                          </Badge>
                        ) : (
                          <span className="text-ink-muted">–</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
 * unit (the only merges the pack allows); its vendor names and price history move there. Back
 * office only, so in English.
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
  const i18n = useI18n();
  const { t, fmt, intl } = i18n;
  const { data, error, loading, reload } = useReport<CatalogReport>("catalog", clientId);
  const [filter, setFilter] = useState("");
  const items = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase(intl);
    const all = data?.items ?? [];
    return q ? all.filter((i) => i.name.toLocaleLowerCase(intl).includes(q)) : all;
  }, [data, filter, intl]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const subtitle = t("materials.catalog.subtitle", { count: data.items.length });
  return (
    <div data-testid="materials-catalog">
      <PageHeader
        title={t("materials.catalog.title")}
        subtitle={clientName ? `${clientName} · ${subtitle}` : subtitle}
        actions={<CsvLink report="catalog" clientId={clientId} />}
      />
      {data.items.length === 0 ? (
        <EmptyState>{t("materials.catalog.empty")}</EmptyState>
      ) : (
        <div className="dt dt-ledger" style={{ "--dt-max-h": "640px" } as CSSProperties}>
          <div className="dt-bar">
            <span className="dt-title">{t("materials.catalog.items")}</span>
            <span className="ds-num text-ink-muted">{fmt.number(items.length)}</span>
            <span className="dt-grow" />
            <input
              className="ds-input dt-search"
              placeholder={t("materials.catalog.filter")}
              aria-label={t("materials.catalog.filter")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="dt-scroll">
            <table data-testid="materials-catalog-table">
              <thead>
                <tr className="dt-cols">
                  <th>{t("materials.col.item")}</th>
                  <th>{t("materials.col.category")}</th>
                  <th>{t("materials.col.unit")}</th>
                  <th>{t("materials.col.attributes")}</th>
                  <th className="n">{t("materials.col.vendors")}</th>
                  <th className="n">{t("materials.col.purchases")}</th>
                  <th className="n">{t("materials.col.lastPrice")}</th>
                  <th className="n">{t("materials.col.lastBought")}</th>
                  {clientId ? <th>Merge</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} data-testid="materials-catalog-row">
                    <td>{i.name}</td>
                    <td>{categoryWord(i.category, i18n)}</td>
                    <td>{unitWord(i.standardUom, i18n)}</td>
                    {/* The pack's attribute names and values, as it records them. */}
                    <td className="muted">
                      {Object.entries(i.attributes)
                        .filter(([k]) => !k.endsWith("_mm"))
                        .map(([k, v]) => `${k.replace(/_/g, " ")} ${v.replace(/_/g, " ")}`)
                        .join(" · ")}
                    </td>
                    <td className="n">{fmt.number(i.vendors)}</td>
                    <td className="n">{fmt.number(i.purchases)}</td>
                    <td className="n">{i.lastPrice ? fmt.unitPrice(i.lastPrice) : "–"}</td>
                    <td className="n">{day(i.lastOn, intl)}</td>
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

/**
 * Links to a pack's reports on the back office's client page (its Packs tab), titled as the API
 * names the pack's screens.
 */
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
