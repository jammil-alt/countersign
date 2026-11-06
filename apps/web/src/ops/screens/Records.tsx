// `/ops/clients/:clientId/records`: what a client's connections brought in (plan §1.16), so the
// operator can see that a sync or a webhook arrived. Transactions, vendors and items, newest first,
// with a search, a source filter and pages; each row opens the record page. The filters live in
// the URL (`?kind=`, `?q=`, `?source=`, `?page=`) so a connection card can link to its own records.
// The portal has its own list (portal/screens/Records.tsx, v0.12 W1-H).
import type {
  RecordList,
  RecordListItem,
  RecordListKind,
  RecordListTransaction,
  RecordListVendor,
  RecordSource,
} from "@countersign/core";
import { RECORD_LIST_PAGE } from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { figure, money } from "../../portal/documents";
import { day, txnKind } from "../../records/RecordDetail";
import { shortTime } from "../../runs/format";
import { Icon } from "../../ui/icons";
import { Badge, Button, EmptyState, ErrorNotice, Loading, Tabs } from "../../ui/primitives";
import { count, plural } from "../../usage/format";
import { Select } from "../agents/ui";
import { ClientFrame } from "../client/ClientFrame";

const KINDS: [RecordListKind, string, string][] = [
  ["transactions", "Transactions", "transaction"],
  ["vendors", "Vendors", "vendor"],
  ["items", "Items", "item"],
];

const EMPTY: Record<RecordListKind, string> = {
  transactions:
    "No transactions yet. Bills, purchases and vendor credits arrive when QuickBooks syncs, and card rows when the client uploads a statement.",
  vendors:
    "No vendors yet. They arrive with QuickBooks, or with the transactions and documents that name them.",
  items: "No items yet. They arrive when QuickBooks syncs the client's products and services.",
  receivables: "No receivables yet. They arrive when QuickBooks syncs the client's invoices.",
};

/** What a person calls a source: the company's name, else the connector's. */
export function sourceName(s: RecordSource): string {
  return s.accountName ?? s.connectorName;
}

/** "312 transactions · 41 vendors · 18 items, last synced 12:41". */
export function countsLine(data: Pick<RecordList, "counts" | "lastSyncAt">): string {
  const parts = KINDS.map(([k, , one]) => plural(data.counts[k], one)).join(" · ");
  return data.lastSyncAt ? `${parts}, last synced ${shortTime(data.lastSyncAt)}` : parts;
}

export function OpsRecordsScreen() {
  const { clientId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const kind = (KINDS.find(([k]) => k === params.get("kind"))?.[0] ??
    "transactions") as RecordListKind;
  const q = params.get("q") ?? "";
  const source = params.get("source") ?? "";
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  // The search box updates the URL once typing pauses.
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `set` reads the current params.
  useEffect(() => {
    if (text.trim() === q) return;
    const timer = setTimeout(() => set({ q: text.trim(), page: "" }), 300);
    return () => clearTimeout(timer);
  }, [text, q]);

  const { data, error, loading, reload } = useApi(apiRoutes.opsClientRecords, {
    params: { id: clientId },
    query: {
      kind,
      ...(q ? { q } : {}),
      ...(source ? { source } : {}),
      offset: (page - 1) * RECORD_LIST_PAGE,
      limit: RECORD_LIST_PAGE,
    },
  });
  const sources = new Map((data?.sources ?? []).map((s) => [s.id, s]));
  const base = `/ops/clients/${clientId}`;
  const tabTo = (k: RecordListKind) => {
    const next = new URLSearchParams();
    if (k !== "transactions") next.set("kind", k);
    if (source) next.set("source", source);
    const s = next.toString();
    return s ? `${base}/records?${s}` : `${base}/records`;
  };

  return (
    <ClientFrame
      clientId={clientId}
      intro="What its connections brought in. Attachments are on the Documents tab."
    >
      {data ? (
        <p className="mb-4 text-ink figures" data-testid="ops-records-counts">
          {countsLine(data)}
        </p>
      ) : null}
      <div className="mb-4">
        <Tabs
          items={KINDS.map(([k, label]) => ({
            to: tabTo(k),
            label,
            active: k === kind,
            ...(data ? { count: data.counts[k] } : {}),
          }))}
        />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="relative w-80 max-w-full">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-muted"
          />
          <input
            type="search"
            aria-label="Search records"
            data-testid="ops-records-search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              kind === "transactions"
                ? "Doc number, memo, vendor or amount"
                : kind === "vendors"
                  ? "Vendor name"
                  : "Name, SKU, description or cost"
            }
            className="ds-input pl-9 text-sm"
          />
        </span>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Select is the label's control. */}
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          Source
          <Select
            data-testid="ops-records-source"
            value={source}
            onChange={(e) => set({ source: e.target.value, page: "" })}
            className="h-8 w-56 text-sm"
          >
            <option value="">All sources</option>
            {(data?.sources ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.accountName ? `${s.accountName} (${s.connectorName})` : s.connectorName}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.page.rows.length === 0 ? (
        <EmptyState>
          {q
            ? `Nothing matches "${q}".`
            : source
              ? `No ${data.page.kind} from this source yet.`
              : EMPTY[data.page.kind]}
        </EmptyState>
      ) : null}
      {data && data.page.rows.length > 0 ? (
        <>
          <div className="dt dt-ana">
            <div>
              {data.page.kind === "transactions" ? (
                <TransactionsTable rows={data.page.rows} sources={sources} base={base} />
              ) : data.page.kind === "vendors" ? (
                <VendorsTable rows={data.page.rows} sources={sources} base={base} />
              ) : data.page.kind === "items" ? (
                <ItemsTable rows={data.page.rows} sources={sources} base={base} />
              ) : null}
            </div>
          </div>
          <Pager data={data} onPage={(p) => set({ page: p === 1 ? "" : String(p) })} page={page} />
        </>
      ) : null}
    </ClientFrame>
  );
}

function Pager({
  data,
  page,
  onPage,
}: {
  data: RecordList;
  page: number;
  onPage: (page: number) => void;
}) {
  const from = data.offset + 1;
  const to = data.offset + data.page.rows.length;
  if (data.total <= data.limit && data.offset === 0) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-sm text-ink-muted">
      <span className="figures" data-testid="ops-records-range">
        {count(from)}–{count(to)} of {count(data.total)}
      </span>
      <span className="flex gap-2">
        <Button
          size="sm"
          data-testid="ops-records-prev"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          data-testid="ops-records-next"
          disabled={to >= data.total}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </span>
    </div>
  );
}

type Sources = Map<string, RecordSource>;

function SourceCell({ id, sources }: { id: string | null; sources: Sources }) {
  const s = id ? sources.get(id) : undefined;
  return <td className="text-ink">{s ? sourceName(s) : "–"}</td>;
}

function TransactionsTable({
  rows,
  sources,
  base,
}: {
  rows: RecordListTransaction[];
  sources: Sources;
  base: string;
}) {
  return (
    <table data-testid="ops-records-transactions">
      <thead>
        <tr className="dt-cols">
          <th>Date</th>
          <th>Type</th>
          <th>Vendor</th>
          <th>Doc number</th>
          <th>Memo</th>
          <th className="n">Total</th>
          <th className="n">Lines</th>
          <th className="n">Attachments</th>
          <th>Synced</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} data-testid={`ops-records-row-${t.id}`}>
            <td className="text-ink figures">{day(t.txnDate)}</td>
            <td>
              <Link to={`${base}/records/${t.id}`} className="font-medium text-ink hover:underline">
                {txnKind(t.txnKind)}
              </Link>
              {t.deleted ? <Badge className="ml-2">Deleted at source</Badge> : null}
            </td>
            <td className="text-ink">{t.vendor?.name ?? "–"}</td>
            <td className="reference text-ink">{t.docNumber ?? "–"}</td>
            <td className="text-ink">{t.memo ?? "–"}</td>
            <td className="n text-ink figures">{money(t.total, t.currency)}</td>
            <td className="n text-ink figures">{count(t.lines)}</td>
            <td className="n text-ink figures">{count(t.attachments)}</td>
            <td className="text-ink figures">{shortTime(t.syncedAt)}</td>
            <SourceCell id={t.sourceId} sources={sources} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VendorsTable({
  rows,
  sources,
  base,
}: {
  rows: RecordListVendor[];
  sources: Sources;
  base: string;
}) {
  return (
    <table data-testid="ops-records-vendors">
      <thead>
        <tr className="dt-cols">
          <th>Vendor</th>
          <th>Other names</th>
          <th className="n">Transactions</th>
          <th>Synced</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.id} data-testid={`ops-records-row-${v.id}`}>
            <td>
              <Link to={`${base}/records/${v.id}`} className="font-medium text-ink hover:underline">
                {v.name}
              </Link>
              {v.externalId ? (
                <span className="block reference text-xs text-ink-muted">Id {v.externalId}</span>
              ) : null}
            </td>
            <td className="text-ink">{v.aliases.length > 0 ? v.aliases.join(", ") : "–"}</td>
            <td className="n text-ink figures">{count(v.transactions)}</td>
            <td className="text-ink figures">
              {v.syncedAt ? shortTime(v.syncedAt) : `Added ${shortTime(v.createdAt)}`}
            </td>
            <SourceCell id={v.sourceId} sources={sources} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemsTable({
  rows,
  sources,
  base,
}: {
  rows: RecordListItem[];
  sources: Sources;
  base: string;
}) {
  return (
    <table data-testid="ops-records-items">
      <thead>
        <tr className="dt-cols">
          <th>Item</th>
          <th>Type</th>
          <th>Description</th>
          <th className="n">Purchase cost</th>
          <th>Status</th>
          <th>Synced</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((i) => (
          <tr key={i.id} data-testid={`ops-records-row-${i.id}`}>
            <td>
              <Link to={`${base}/records/${i.id}`} className="font-medium text-ink hover:underline">
                {i.name}
              </Link>
              {i.sku ? (
                <span className="block reference text-xs text-ink-muted">SKU {i.sku}</span>
              ) : null}
            </td>
            <td className="text-ink">{i.type ?? "–"}</td>
            <td className="text-ink">{i.description ?? "–"}</td>
            <td className="n text-ink figures">{i.purchaseCost ? figure(i.purchaseCost) : "–"}</td>
            <td className="text-ink">
              {i.deleted ? <Badge>Deleted at source</Badge> : i.active ? "Active" : "Inactive"}
            </td>
            <td className="text-ink figures">{shortTime(i.syncedAt)}</td>
            <SourceCell id={i.sourceId} sources={sources} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}
