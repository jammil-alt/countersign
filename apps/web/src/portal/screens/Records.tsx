// `/records` (v0.12 W1-H, docs/plan.md §1.43): the client's own records, as the back office's
// Records list shows them (transactions, vendors, items; a search; pages), with the same table
// classes. Minimal until the redesign; each row opens the record page.
import type { RecordList, RecordListKind, RecordSource } from "@countersign/core";
import { RECORD_LIST_PAGE } from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { type I18n, useI18n } from "../../i18n/i18n";
import { day, txnKind } from "../../records/RecordDetail";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tabs,
} from "../../ui/primitives";
import { money } from "../documents";

const KINDS = ["transactions", "vendors", "items"] as const satisfies readonly RecordListKind[];

function sourceName(sources: Map<string, RecordSource>, id: string | null): string {
  const s = id ? sources.get(id) : undefined;
  return s ? (s.accountName ?? s.connectorName) : "–";
}

export function PortalRecordsScreen() {
  const i18n = useI18n();
  const { t } = i18n;
  const [params, setParams] = useSearchParams();
  const kind: RecordListKind = KINDS.find((k) => k === params.get("kind")) ?? "transactions";
  const q = params.get("q") ?? "";
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

  const { data, error, loading, reload } = useApi(apiRoutes.portalRecords, {
    query: {
      kind,
      ...(q ? { q } : {}),
      offset: (page - 1) * RECORD_LIST_PAGE,
      limit: RECORD_LIST_PAGE,
    },
  });
  const sources = new Map((data?.sources ?? []).map((s) => [s.id, s]));

  return (
    <div className="max-w-6xl">
      <PageHeader title={t("records.title")} subtitle={t("records.subtitle")} />
      <div className="mb-4">
        <Tabs
          items={KINDS.map((k) => ({
            to: k === "transactions" ? "/records" : `/records?kind=${k}`,
            label: t(`records.kind.${k}`),
            active: k === kind,
            ...(data ? { count: data.counts[k] } : {}),
          }))}
        />
      </div>
      <div className="mb-4">
        <input
          type="search"
          aria-label={t("records.search")}
          placeholder={t("records.search")}
          data-testid="portal-records-search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="ds-input w-80 max-w-full text-sm"
        />
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.page.rows.length === 0 ? (
        <EmptyState>{q ? t("records.noMatch", { q }) : t("records.empty")}</EmptyState>
      ) : null}
      {data && data.page.rows.length > 0 ? (
        <>
          <div className="dt dt-ana">
            <div>
              <RecordsTable data={data} sources={sources} i18n={i18n} />
            </div>
          </div>
          <Pager data={data} page={page} onPage={(p) => set({ page: p === 1 ? "" : String(p) })} />
        </>
      ) : null}
    </div>
  );
}

function RecordsTable({
  data,
  sources,
  i18n,
}: {
  data: RecordList;
  sources: Map<string, RecordSource>;
  i18n: I18n;
}) {
  const { t } = i18n;
  const open = (id: string, label: string) => (
    <Link to={`/records/${id}`} className="font-medium text-ink hover:underline">
      {label}
    </Link>
  );
  const deleted = <Badge className="ml-2">{t("record.deletedInTool")}</Badge>;
  if (data.page.kind === "transactions") {
    return (
      <table data-testid="portal-records-transactions">
        <thead>
          <tr className="dt-cols">
            <th>{t("records.col.date")}</th>
            <th>{t("records.col.type")}</th>
            <th>{t("records.col.vendor")}</th>
            <th>{t("records.col.number")}</th>
            <th className="n">{t("records.col.total")}</th>
            <th>{t("records.col.source")}</th>
          </tr>
        </thead>
        <tbody>
          {data.page.rows.map((r) => (
            <tr key={r.id} data-testid={`portal-records-row-${r.id}`}>
              <td className="text-ink figures">{day(r.txnDate, i18n)}</td>
              <td>
                {open(r.id, txnKind(r.txnKind, i18n))}
                {r.deleted ? deleted : null}
              </td>
              <td className="text-ink">{r.vendor?.name ?? "–"}</td>
              <td className="reference text-ink">{r.docNumber ?? "–"}</td>
              <td className="n text-ink figures">{money(r.total, r.currency, i18n)}</td>
              <td className="text-ink">{sourceName(sources, r.sourceId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (data.page.kind === "vendors") {
    return (
      <table data-testid="portal-records-vendors">
        <thead>
          <tr className="dt-cols">
            <th>{t("records.col.name")}</th>
            <th className="n">{t("records.col.transactions")}</th>
            <th>{t("records.col.source")}</th>
          </tr>
        </thead>
        <tbody>
          {data.page.rows.map((r) => (
            <tr key={r.id} data-testid={`portal-records-row-${r.id}`}>
              <td>{open(r.id, r.name)}</td>
              <td className="n text-ink figures">{i18n.fmt.number(r.transactions)}</td>
              <td className="text-ink">{sourceName(sources, r.sourceId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  // The API lists receivables too (docs/plan.md §1.43); their table waits for the owner's screens.
  if (data.page.kind !== "items") return null;
  return (
    <table data-testid="portal-records-items">
      <thead>
        <tr className="dt-cols">
          <th>{t("records.col.name")}</th>
          <th>{t("records.col.description")}</th>
          <th>{t("records.col.source")}</th>
        </tr>
      </thead>
      <tbody>
        {data.page.rows.map((r) => (
          <tr key={r.id} data-testid={`portal-records-row-${r.id}`}>
            <td>
              {open(r.id, r.name)}
              {r.deleted ? deleted : null}
            </td>
            <td className="text-ink">{r.description ?? "–"}</td>
            <td className="text-ink">{sourceName(sources, r.sourceId)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const { t, fmt } = useI18n();
  const to = data.offset + data.page.rows.length;
  if (data.total <= data.limit && data.offset === 0) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-sm text-ink-muted">
      <span className="figures">
        {t("records.range", {
          from: fmt.number(data.offset + 1),
          to: fmt.number(to),
          total: fmt.number(data.total),
        })}
      </span>
      <span className="flex gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t("records.previous")}
        </Button>
        <Button size="sm" disabled={to >= data.total} onClick={() => onPage(page + 1)}>
          {t("records.next")}
        </Button>
      </span>
    </div>
  );
}
