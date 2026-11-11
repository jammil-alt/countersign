// The vendor catalog (docs/plan.md §1.88), in the back office and the portal's Purchasing reports:
// every vendor with items in a client's catalog, one vendor's items (its SKU, wording, pack and
// unit, last price with its date and source, list price, preferred, status) with a search, and a
// master item's page with its vendors side by side in its standard unit, the preferred one first.
//
// The portal reads it (it is the client's data) and changes nothing. The back office also marks a
// preferred vendor item and discontinues one (the pack's actions, operator only, audited); those
// controls are back office only, so their words are English, as on the other back-office screens.
// Every other word comes from the message catalog (`materials.vendors.*`, `materials.item.*`) and
// numbers, money and days go through the reader's locale. The vendor's wording and the master
// item's attributes are data and show as written.
import { type CSSProperties, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import { CATEGORY_LABEL, UNIT_LABEL } from "./types";

const PACK = "materials";

export interface VendorCatalogVendor {
  vendorId: string;
  name: string;
  items: number;
  discontinued: number;
  preferred: number;
  lastPriceOn: string | null;
}

export interface VendorItemRow {
  id: string;
  vendorId: string;
  catalogItemId: string;
  catalogItemName: string | null;
  standardUom: string | null;
  sku: string | null;
  name: string;
  packSize: string | null;
  vendorUom: string | null;
  stdPerVendorUom: string | null;
  leadTimeDays: number | null;
  listPrice: string | null;
  listPriceOn: string | null;
  lastPrice: string | null;
  lastPriceStd: string | null;
  lastPriceOn: string | null;
  lastPriceSource: string | null;
  currency: string;
  preferred: boolean;
  status: "active" | "discontinued";
  vendorName?: string;
}

export interface MasterVendorsReport {
  item: {
    id: string;
    name: string;
    category: string;
    standardUom: string;
    attributes: Record<string, string>;
  };
  vendors: VendorItemRow[];
}

/** Where the last price came from, in the reader's words (`last_price_source`). */
const SOURCE_LABEL: Record<string, PlainKey> = {
  invoice: "materials.vendors.source.invoice",
  quote: "materials.vendors.source.quote",
  qbo_bill: "materials.vendors.source.qbo_bill",
  import: "materials.vendors.source.import",
  person: "materials.vendors.source.person",
};

/** The portal's paths, or a client's in the back office. */
export const vendorCatalogPath = (clientId?: string, vendorId?: string) =>
  `${clientId ? `/ops/clients/${clientId}` : ""}/reports/${PACK}/vendor-catalog${vendorId ? `/${vendorId}` : ""}`;
export const masterItemPath = (catalogItemId: string, clientId?: string) =>
  `${clientId ? `/ops/clients/${clientId}` : ""}/reports/${PACK}/catalog/${catalogItemId}`;

const day = (on: string | null, intl: string) => (on ? dayLabel(on, intl) : "–");

const unitWord = (uom: string | null, { t }: Pick<I18n, "t">) => {
  if (!uom) return "–";
  const key = UNIT_LABEL[uom];
  return key ? t(key) : uom.replace(/_/g, " ");
};

/** "bundle", and what it holds in the master item's unit when the vendor item says ("5 × sheet"). */
function UnitCell({ item, i18n }: { item: VendorItemRow; i18n: I18n }) {
  const { t, fmt } = i18n;
  const holds =
    item.stdPerVendorUom &&
    item.standardUom &&
    item.vendorUom &&
    item.vendorUom !== item.standardUom
      ? t("materials.vendors.holds", {
          qty: fmt.figure(item.stdPerVendorUom),
          unit: unitWord(item.standardUom, i18n),
        })
      : null;
  return (
    <>
      {unitWord(item.vendorUom, i18n)}
      {holds ? <span className="muted">{` (${holds})`}</span> : null}
    </>
  );
}

/** Preferred and discontinued, each with its word; an active item that isn't preferred: "Active". */
function StatusCell({ item }: { item: VendorItemRow }) {
  const { t } = useI18n();
  if (item.status === "discontinued") return <Badge>{t("materials.vendors.discontinued")}</Badge>;
  if (item.preferred) return <Badge tone="accent">{t("materials.vendors.preferred")}</Badge>;
  return <span className="muted">{t("materials.vendors.active")}</span>;
}

/** One report for the portal (no client) or a client in the back office. */
function useVendorReport(report: string, clientId: string | undefined, itemId?: string) {
  const portalList = useApi(
    apiRoutes.portalPackReport,
    !clientId && !itemId ? { params: { pack: PACK, report } } : null,
  );
  const portalItem = useApi(
    apiRoutes.portalPackReportItem,
    !clientId && itemId ? { params: { pack: PACK, report, itemId } } : null,
  );
  const opsList = useApi(
    apiRoutes.opsClientPackReport,
    clientId && !itemId ? { params: { id: clientId, pack: PACK, report } } : null,
  );
  const opsItem = useApi(
    apiRoutes.opsClientPackReportItem,
    clientId && itemId ? { params: { id: clientId, pack: PACK, report, itemId } } : null,
  );
  const state = clientId ? (itemId ? opsItem : opsList) : itemId ? portalItem : portalList;
  return { ...state, report: state.data?.report as Record<string, unknown> | undefined };
}

/** A vendor item's back-office actions: mark it preferred, or discontinued. */
function ItemActions({
  clientId,
  item,
  onDone,
}: {
  clientId: string;
  item: VendorItemRow;
  onDone: () => void;
}) {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  if (item.status !== "active") return <span className="muted">–</span>;
  const act = async (action: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await client.call(apiRoutes.opsClientPackAction, {
        params: { id: clientId, pack: PACK, action },
        body: { vendorItemId: item.id },
      });
      onDone();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span
      className="flex flex-wrap items-center gap-2"
      data-testid={`vendor-item-actions-${item.id}`}
    >
      {item.preferred ? null : (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          data-testid="vendor-item-prefer"
          onClick={() => act("vendor-item-preferred")}
        >
          Make preferred
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        data-testid="vendor-item-discontinue"
        onClick={() => act("vendor-item-discontinue")}
      >
        Discontinue
      </Button>
      {problem ? <ErrorNotice error={problem} /> : null}
    </span>
  );
}

/**
 * A master item's vendors, preferred first, then active before discontinued (the API's order
 * within each: the lowest price per standard unit, a price with no conversion last).
 */
// DECISION (§1.88 web): the page sorts again, stably, so the preferred vendor leads and a
// discontinued one trails whatever order a report answers in.
export function preferredFirst(rows: readonly VendorItemRow[]): VendorItemRow[] {
  const rank = (v: VendorItemRow) => (v.preferred ? 0 : v.status === "active" ? 1 : 2);
  return rows
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
    .map(({ v }) => v);
}

/** A master item's page: what it is, and its vendors side by side per its standard unit. */
export function MasterItemView({ clientId }: { clientId?: string }) {
  const { id = "" } = useParams();
  const i18n = useI18n();
  const { t, fmt, intl } = i18n;
  const { report, error, loading, reload } = useVendorReport("master-vendors", clientId, id);
  if (loading && !report) return <Loading label={t("materials.item.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const data = report as MasterVendorsReport | undefined;
  if (!data?.item) return null;
  const { item } = data;
  const unit = unitWord(item.standardUom, i18n);
  const category = CATEGORY_LABEL[item.category];
  const attributes = Object.entries(item.attributes ?? {})
    .filter(([k]) => !k.endsWith("_mm"))
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${String(v).replace(/_/g, " ")}`);
  const vendors = preferredFirst(data.vendors);
  return (
    <div data-testid="materials-master-item" className="flex flex-col gap-6">
      <div>
        <Link
          to={`${clientId ? `/ops/clients/${clientId}` : ""}/reports/${PACK}/catalog`}
          className="text-sm text-ink-muted"
          data-testid="materials-master-item-back"
        >
          {t("materials.item.back")}
        </Link>
        <PageHeader
          title={item.name}
          subtitle={[category ? t(category) : item.category, unit].join(" · ")}
        />
        {attributes.length > 0 ? (
          <p
            className="-mt-4 text-sm text-ink-muted"
            data-testid="materials-master-item-attributes"
          >
            {attributes.join(" · ")}
          </p>
        ) : null}
      </div>
      <section>
        <SectionLabel>{t("materials.item.vendors", { unit })}</SectionLabel>
        {vendors.length === 0 ? (
          <EmptyState>{t("materials.item.noVendors")}</EmptyState>
        ) : (
          <>
            <p className="mb-3 text-sm text-ink-muted">
              {t("materials.item.vendorsNote", { unit })}
            </p>
            <div className="dt dt-ledger">
              <div className="dt-scroll">
                <table data-testid="vendor-catalog-master-table">
                  <thead>
                    <tr className="dt-cols">
                      <th>{t("materials.col.vendor")}</th>
                      <th>{t("materials.vendors.col.sku")}</th>
                      <th>{t("materials.vendors.col.theirName")}</th>
                      <th>{t("materials.vendors.col.pack")}</th>
                      <th>{t("materials.col.unit")}</th>
                      <th className="n">{t("materials.vendors.col.perUnit", { unit })}</th>
                      <th className="n">{t("materials.col.lastPrice")}</th>
                      <th className="n">{t("materials.vendors.col.on")}</th>
                      <th className="n">{t("materials.vendors.col.listPrice")}</th>
                      <th>{t("materials.vendors.col.status")}</th>
                      {clientId ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {vendors.map((v) => (
                      <tr key={v.id} data-testid="vendor-catalog-master-row">
                        <td>
                          <Link
                            to={vendorCatalogPath(clientId, v.vendorId)}
                            className="text-ink hover:underline"
                          >
                            {v.vendorName}
                          </Link>
                        </td>
                        <td className="reference">{v.sku ?? "–"}</td>
                        <td>{v.name}</td>
                        <td className="muted">{v.packSize ?? "–"}</td>
                        <td>
                          <UnitCell item={v} i18n={i18n} />
                        </td>
                        {/* No conversion to the standard unit: never compared (invariant 7). */}
                        <td className="n">
                          {v.lastPriceStd ? fmt.unitPrice(v.lastPriceStd, v.currency) : "–"}
                        </td>
                        <td className="n">
                          {v.lastPrice ? fmt.unitPrice(v.lastPrice, v.currency) : "–"}
                        </td>
                        <td className="n">{day(v.lastPriceOn, intl)}</td>
                        <td className="n">
                          {v.listPrice ? fmt.unitPrice(v.listPrice, v.currency) : "–"}
                        </td>
                        <td>
                          <StatusCell item={v} />
                        </td>
                        {clientId ? (
                          <td>
                            <ItemActions clientId={clientId} item={v} onDone={reload} />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** Whether a vendor item matches the search: its SKU, its name, its master item or its pack. */
function matchesSearch(v: VendorItemRow, q: string, intl: string): boolean {
  if (!q) return true;
  return [v.sku, v.name, v.catalogItemName, v.packSize].some((s) =>
    s?.toLocaleLowerCase(intl).includes(q),
  );
}

/** One vendor's catalog, searchable; the back office adds its actions. */
function OneVendor({ clientId, vendorId }: { clientId?: string | undefined; vendorId: string }) {
  const i18n = useI18n();
  const { t, fmt, intl } = i18n;
  const { report, error, loading, reload } = useVendorReport("vendor-catalog", clientId, vendorId);
  const [search, setSearch] = useState("");
  const data = report as
    | { vendor: { id: string; name: string }; items: VendorItemRow[] }
    | undefined;
  const items = useMemo(() => {
    const q = search.trim().toLocaleLowerCase(intl);
    return (data?.items ?? []).filter((v) => matchesSearch(v, q, intl));
  }, [data, search, intl]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data?.vendor) return null;
  if (data.items.length === 0) {
    return <EmptyState>{t("materials.vendors.none", { vendor: data.vendor.name })}</EmptyState>;
  }
  return (
    <section data-testid="vendor-catalog-vendor">
      <div className="dt dt-ledger" style={{ "--dt-max-h": "560px" } as CSSProperties}>
        <div className="dt-bar">
          <span className="dt-title">{data.vendor.name}</span>
          <span className="ds-num text-ink-muted" data-testid="vendor-catalog-count">
            {fmt.number(items.length)}
          </span>
          <span className="dt-grow" />
          <input
            className="ds-input dt-search"
            type="search"
            placeholder={t("materials.vendors.search")}
            aria-label={t("materials.vendors.search")}
            data-testid="vendor-catalog-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {items.length === 0 ? (
          <div className="p-4">
            <EmptyState>{t("materials.vendors.noMatch")}</EmptyState>
          </div>
        ) : (
          <div className="dt-scroll">
            <table data-testid="vendor-catalog-table">
              <thead>
                <tr className="dt-cols">
                  <th>{t("materials.vendors.col.sku")}</th>
                  <th>{t("materials.vendors.col.theirName")}</th>
                  <th>{t("materials.col.item")}</th>
                  <th>{t("materials.vendors.col.pack")}</th>
                  <th>{t("materials.col.unit")}</th>
                  <th className="n">{t("materials.col.lastPrice")}</th>
                  <th className="n">{t("materials.vendors.col.on")}</th>
                  <th>{t("materials.vendors.col.from")}</th>
                  <th className="n">{t("materials.vendors.col.listPrice")}</th>
                  <th>{t("materials.vendors.col.status")}</th>
                  {clientId ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((v) => {
                  const source = v.lastPriceSource ? SOURCE_LABEL[v.lastPriceSource] : undefined;
                  return (
                    <tr key={v.id} data-testid="vendor-catalog-row">
                      <td className="reference">{v.sku ?? "–"}</td>
                      <td>{v.name}</td>
                      <td>
                        <Link
                          to={masterItemPath(v.catalogItemId, clientId)}
                          className="text-ink hover:underline"
                          data-testid="vendor-catalog-master-link"
                        >
                          {v.catalogItemName ?? v.catalogItemId}
                        </Link>
                      </td>
                      <td className="muted">{v.packSize ?? "–"}</td>
                      <td>
                        <UnitCell item={v} i18n={i18n} />
                      </td>
                      <td className="n">
                        {v.lastPrice ? fmt.unitPrice(v.lastPrice, v.currency) : "–"}
                      </td>
                      <td className="n">{day(v.lastPriceOn, intl)}</td>
                      <td className="muted">{source ? t(source) : (v.lastPriceSource ?? "–")}</td>
                      <td className="n">
                        {v.listPrice ? (
                          <span
                            title={
                              v.listPriceOn
                                ? t("materials.vendors.listedOn", {
                                    date: day(v.listPriceOn, intl),
                                  })
                                : undefined
                            }
                          >
                            {fmt.unitPrice(v.listPrice, v.currency)}
                          </span>
                        ) : (
                          "–"
                        )}
                      </td>
                      <td>
                        <StatusCell item={v} />
                      </td>
                      {clientId ? (
                        <td>
                          <ItemActions clientId={clientId} item={v} onDone={reload} />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The vendor catalog: the client's vendors, then one vendor's items. The vendor is in the path
 * (`…/vendor-catalog/<vendor id>`), else the first.
 */
export function VendorCatalogView({ clientId }: { clientId?: string }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, intl } = useI18n();
  const { report, error, loading, reload } = useVendorReport("vendor-catalog", clientId);
  if (loading && !report) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const vendors = ((report as { vendors?: VendorCatalogVendor[] } | undefined)?.vendors ??
    []) as VendorCatalogVendor[];
  const chosen =
    (id && vendors.some((v) => v.vendorId === id) ? id : null) ?? vendors[0]?.vendorId ?? null;
  const current = vendors.find((v) => v.vendorId === chosen);
  return (
    <div data-testid="vendor-catalog">
      <PageHeader
        title={t("materials.vendors.title")}
        subtitle={t("materials.vendors.subtitle", { count: vendors.length })}
      />
      {vendors.length === 0 ? (
        <EmptyState>{t("materials.vendors.empty")}</EmptyState>
      ) : (
        <>
          <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
            <select
              className="ds-select w-full sm:w-auto"
              aria-label={t("materials.vendors.pick")}
              data-testid="vendor-catalog-pick"
              value={chosen ?? ""}
              onChange={(e) =>
                navigate(vendorCatalogPath(clientId, e.target.value), { replace: true })
              }
            >
              {vendors.map((v) => (
                <option key={v.vendorId} value={v.vendorId}>
                  {t("materials.vendors.option", { name: v.name, count: v.items })}
                </option>
              ))}
            </select>
            {current?.lastPriceOn ? (
              <span className="text-sm text-ink-muted">
                {t("materials.vendors.lastPriced", { date: day(current.lastPriceOn, intl) })}
              </span>
            ) : null}
          </Card>
          {chosen ? <OneVendor key={chosen} clientId={clientId} vendorId={chosen} /> : null}
        </>
      )}
    </div>
  );
}
