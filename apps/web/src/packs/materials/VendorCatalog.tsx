// The vendor catalog in the back office (docs/plan.md §1.88): every vendor with items in a client's
// catalog, one vendor's items (its SKU, wording, pack and unit, last price and date, list price,
// preferred), and a master item's vendors side by side in its standard unit. The operator marks a
// preferred vendor item and discontinues one (the pack's actions, audited). Back office only, so
// its words are English, as on the other back-office screens; the vendor's wording is its data and
// shows as written.
import { type CSSProperties, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { type I18n, useI18n } from "../../i18n/i18n";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import { UNIT_LABEL } from "./types";

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

const SOURCE: Record<string, string> = {
  invoice: "invoice",
  quote: "quote",
  qbo_bill: "QuickBooks bill",
  import: "price list",
  person: "a person",
};

const day = (on: string | null, intl: string) => (on ? dayLabel(on, intl) : "–");

const unitWord = (uom: string | null, { t }: Pick<I18n, "t">) => {
  if (!uom) return "–";
  const key = UNIT_LABEL[uom];
  return key ? t(key) : uom.replace(/_/g, " ");
};

/** A vendor item's actions: mark it preferred, or discontinued. */
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
    <span className="flex items-center gap-2" data-testid={`vendor-item-actions-${item.id}`}>
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

/** A master item's vendors side by side, per its standard unit. */
function MasterVendors({ clientId, catalogItemId }: { clientId: string; catalogItemId: string }) {
  const i18n = useI18n();
  const { fmt, intl } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.opsClientPackReportItem, {
    params: { id: clientId, pack: PACK, report: "master-vendors", itemId: catalogItemId },
  });
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const report = data?.report as
    | { item: { id: string; name: string; standardUom: string }; vendors: VendorItemRow[] }
    | undefined;
  if (!report) return null;
  return (
    <section className="mt-6" data-testid="vendor-catalog-master">
      <SectionLabel>{`${report.item.name}: its vendors, per ${unitWord(report.item.standardUom, i18n)}`}</SectionLabel>
      <div className="dt dt-ledger">
        <div className="dt-scroll">
          <table data-testid="vendor-catalog-master-table">
            <thead>
              <tr className="dt-cols">
                <th>Vendor</th>
                <th>SKU</th>
                <th>Their name</th>
                <th>Unit</th>
                <th className="n">Per standard unit</th>
                <th className="n">Last price</th>
                <th className="n">On</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {report.vendors.map((v) => (
                <tr key={v.id} data-testid="vendor-catalog-master-row">
                  <td>{v.vendorName}</td>
                  <td className="reference">{v.sku ?? "–"}</td>
                  <td>{v.name}</td>
                  <td>{unitWord(v.vendorUom, i18n)}</td>
                  {/* No conversion to the standard unit: never compared (invariant 7). */}
                  <td className="n">
                    {v.lastPriceStd ? fmt.unitPrice(v.lastPriceStd, v.currency) : "–"}
                  </td>
                  <td className="n">
                    {v.lastPrice ? fmt.unitPrice(v.lastPrice, v.currency) : "–"}
                  </td>
                  <td className="n">{day(v.lastPriceOn, intl)}</td>
                  <td>
                    {v.preferred ? <Badge tone="accent">Preferred</Badge> : null}
                    {v.status === "discontinued" ? <Badge>Discontinued</Badge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/** One vendor's catalog, with the operator's actions. */
function OneVendor({ clientId, vendorId }: { clientId: string; vendorId: string }) {
  const i18n = useI18n();
  const { fmt, intl } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.opsClientPackReportItem, {
    params: { id: clientId, pack: PACK, report: "vendor-catalog", itemId: vendorId },
  });
  const [master, setMaster] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const report = data?.report as
    | { vendor: { id: string; name: string }; items: VendorItemRow[] }
    | undefined;
  if (!report) return null;
  return (
    <section data-testid="vendor-catalog-vendor">
      {report.items.length === 0 ? (
        <EmptyState>{`${report.vendor.name} has no items in the catalog yet.`}</EmptyState>
      ) : (
        <div className="dt dt-ledger" style={{ "--dt-max-h": "560px" } as CSSProperties}>
          <div className="dt-bar">
            <span className="dt-title">{report.vendor.name}</span>
            <span className="ds-num text-ink-muted">{fmt.number(report.items.length)}</span>
          </div>
          <div className="dt-scroll">
            <table data-testid="vendor-catalog-table">
              <thead>
                <tr className="dt-cols">
                  <th>SKU</th>
                  <th>Their name</th>
                  <th>Master item</th>
                  <th>Pack</th>
                  <th>Unit</th>
                  <th className="n">Last price</th>
                  <th className="n">On</th>
                  <th>From</th>
                  <th className="n">List price</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {report.items.map((v) => (
                  <tr key={v.id} data-testid="vendor-catalog-row">
                    <td className="reference">{v.sku ?? "–"}</td>
                    <td>{v.name}</td>
                    <td>
                      <button
                        type="button"
                        className="text-left text-ink hover:underline"
                        data-testid="vendor-catalog-master-link"
                        onClick={() => setMaster(v.catalogItemId)}
                      >
                        {v.catalogItemName ?? v.catalogItemId}
                      </button>
                    </td>
                    <td className="muted">{v.packSize ?? "–"}</td>
                    <td>{unitWord(v.vendorUom, i18n)}</td>
                    <td className="n">
                      {v.lastPrice ? fmt.unitPrice(v.lastPrice, v.currency) : "–"}
                    </td>
                    <td className="n">{day(v.lastPriceOn, intl)}</td>
                    <td className="muted">
                      {v.lastPriceSource ? (SOURCE[v.lastPriceSource] ?? v.lastPriceSource) : "–"}
                    </td>
                    <td className="n">
                      {v.listPrice ? fmt.unitPrice(v.listPrice, v.currency) : "–"}
                    </td>
                    <td>
                      {v.preferred ? <Badge tone="accent">Preferred</Badge> : null}
                      {v.status === "discontinued" ? <Badge>Discontinued</Badge> : null}
                    </td>
                    <td>
                      <ItemActions clientId={clientId} item={v} onDone={reload} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {master ? <MasterVendors key={master} clientId={clientId} catalogItemId={master} /> : null}
    </section>
  );
}

/** The back office's vendor catalog for a client: its vendors, then one vendor's items. */
export function VendorCatalogView({ clientId }: { clientId: string }) {
  const { intl } = useI18n();
  const { data, error, loading, reload } = useApi(apiRoutes.opsClientPackReport, {
    params: { id: clientId, pack: PACK, report: "vendor-catalog" },
  });
  const [vendorId, setVendorId] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const vendors = ((data?.report as { vendors?: VendorCatalogVendor[] } | undefined)?.vendors ??
    []) as VendorCatalogVendor[];
  const chosen = vendorId ?? vendors[0]?.vendorId ?? null;
  return (
    <div data-testid="vendor-catalog">
      <PageHeader
        title="Vendor catalog"
        subtitle={vendors.length === 1 ? "1 vendor" : `${vendors.length} vendors`}
      />
      {vendors.length === 0 ? (
        <EmptyState>
          No vendor items yet. They are added when an invoice's lines are matched, or from a
          vendor's price list.
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <select
              className="ds-select"
              aria-label="Vendor"
              data-testid="vendor-catalog-pick"
              value={chosen ?? ""}
              onChange={(e) => setVendorId(e.target.value)}
            >
              {vendors.map((v) => (
                <option key={v.vendorId} value={v.vendorId}>
                  {`${v.name} (${v.items} ${v.items === 1 ? "item" : "items"})`}
                </option>
              ))}
            </select>
            {(() => {
              const v = vendors.find((x) => x.vendorId === chosen);
              return v?.lastPriceOn ? (
                <span className="text-sm text-ink-muted">{`Last priced ${day(v.lastPriceOn, intl)}`}</span>
              ) : null;
            })()}
          </div>
          {chosen ? <OneVendor key={chosen} clientId={clientId} vendorId={chosen} /> : null}
        </>
      )}
    </div>
  );
}
