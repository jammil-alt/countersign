// `/records` (v0.12 W1-H, docs/plan.md §1.43; UI-3a, drafted in the prototype's style): the
// client's own records, as the back office's Records list shows them: transactions, vendors, items
// and receivables (the QuickBooks invoices the client is owed), a search and pages. Each row opens
// its record page, but a receivable's: no route serves one receivable yet, so its row doesn't link.
import type { RecordList, RecordListKind, RecordSource } from "@countersign/core";
import { RECORD_LIST_PAGE } from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import { day, txnKind } from "../../records/RecordDetail";
import { shortTime } from "../../runs/format";
import { Icon } from "../../ui/icons";
import { Loaded, Page } from "../../ui/page";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  PageHeader,
  Tabs,
} from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { money } from "../documents";
import { PORTAL_PATHS } from "../paths";

const KINDS = [
  "transactions",
  "vendors",
  "items",
  "receivables",
] as const satisfies readonly RecordListKind[];

/** A receivable's status as a chip: paid is done; open, void and deleted are plain. */
const RECEIVABLE_STATUS: Record<string, { label: PlainKey; state: ChipState }> = {
  open: { label: "records.receivable.open", state: "idle" },
  paid: { label: "records.receivable.paid", state: "done" },
  void: { label: "records.receivable.void", state: "idle" },
  deleted: { label: "records.receivable.deleted", state: "idle" },
};

/** Today as YYYY-MM-DD on the reader's clock, to tell an open invoice past its due date. */
export function localDay(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

  const state = useApi(apiRoutes.portalRecords, {
    query: {
      kind,
      ...(q ? { q } : {}),
      offset: (page - 1) * RECORD_LIST_PAGE,
      limit: RECORD_LIST_PAGE,
    },
  });
  const { data } = state;
  const sources = new Map((data?.sources ?? []).map((s) => [s.id, s]));

  return (
    <Page testId="portal-records-page">
      <PageHeader
        title={t("records.title")}
        subtitle={
          data?.lastSyncAt
            ? `${t("records.subtitle")} ${t("records.lastSync", {
                time: shortTime(data.lastSyncAt, undefined, i18n),
              })}`
            : t("records.subtitle")
        }
        actions={
          <Link
            to={PORTAL_PATHS.upload}
            className={buttonClass("secondary")}
            data-testid="portal-records-upload"
          >
            {t("records.upload")}
          </Link>
        }
      />
      <div className="overflow-x-auto">
        <Tabs
          items={KINDS.map((k) => ({
            to: k === "transactions" ? "/records" : `/records?kind=${k}`,
            label: t(`records.kind.${k}`),
            active: k === kind,
            ...(data ? { count: data.counts[k] } : {}),
          }))}
        />
      </div>
      <label className="ds-card ui-ask">
        <Icon name="search" className="text-ink-muted" />
        <input
          type="search"
          aria-label={t("records.search")}
          placeholder={t("records.search")}
          data-testid="portal-records-search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="ui-ask__input"
        />
        {data ? (
          <span className="text-sm text-ink-muted figures" data-testid="portal-records-found">
            {t("records.found", { count: data.total })}
          </span>
        ) : null}
      </label>
      <Loaded state={state}>
        {(list) =>
          list.page.rows.length === 0 ? (
            <EmptyState>{q ? t("records.noMatch", { q }) : t("records.empty")}</EmptyState>
          ) : (
            <div className="flex flex-col gap-3">
              {/* One account: named once above the table, not on every row (QA round 1). */}
              {list.sources.length === 1 && list.sources[0] ? (
                <p className="text-sm text-ink-muted" data-testid="portal-records-account">
                  {t("records.fromAccount", { account: sourceName(sources, list.sources[0].id) })}
                </p>
              ) : null}
              <Card>
                <div className="dt dt-ana overflow-x-auto">
                  <RecordsTable
                    data={list}
                    sources={sources}
                    i18n={i18n}
                    showSource={list.sources.length > 1}
                  />
                </div>
              </Card>
              <Pager
                data={list}
                page={page}
                onPage={(p) => set({ page: p === 1 ? "" : String(p) })}
              />
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}

function RecordsTable({
  data,
  sources,
  i18n,
  showSource,
}: {
  data: RecordList;
  sources: Map<string, RecordSource>;
  i18n: I18n;
  /** A source column only when records come from more than one account. */
  showSource: boolean;
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
            {showSource ? <th>{t("records.col.source")}</th> : null}
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
              {showSource ? <td className="text-ink">{sourceName(sources, r.sourceId)}</td> : null}
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
            {showSource ? <th>{t("records.col.source")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {data.page.rows.map((r) => (
            <tr key={r.id} data-testid={`portal-records-row-${r.id}`}>
              <td>{open(r.id, r.name)}</td>
              <td className="n text-ink figures">{i18n.fmt.number(r.transactions)}</td>
              {showSource ? <td className="text-ink">{sourceName(sources, r.sourceId)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (data.page.kind === "receivables") {
    const now = localDay();
    return (
      <table data-testid="portal-records-receivables">
        <thead>
          <tr className="dt-cols">
            <th>{t("records.col.number")}</th>
            <th>{t("records.col.customer")}</th>
            <th>{t("records.col.date")}</th>
            <th>{t("records.col.due")}</th>
            <th className="n">{t("records.col.total")}</th>
            <th className="n">{t("records.col.owed")}</th>
            <th>{t("records.col.status")}</th>
          </tr>
        </thead>
        <tbody>
          {data.page.rows.map((r) => {
            const known = RECEIVABLE_STATUS[r.status];
            const overdue = r.status === "open" && r.dueDate !== null && r.dueDate < now;
            return (
              <tr key={r.id} data-testid={`portal-records-row-${r.id}`}>
                <td className="reference text-ink">{r.docNumber ?? "–"}</td>
                <td className="font-medium text-ink">{r.customer.name}</td>
                <td className="text-ink figures">{day(r.txnDate, i18n)}</td>
                <td className="figures">
                  <span className={overdue ? "text-risk-ink" : "text-ink"}>
                    {day(r.dueDate, i18n)}
                  </span>
                  {overdue ? (
                    <span className="block text-sm text-risk-ink" data-testid="portal-overdue">
                      {t("records.overdue")}
                    </span>
                  ) : null}
                </td>
                <td className="n text-ink figures">{money(r.total, r.currency, i18n)}</td>
                <td className="n font-medium text-ink figures">
                  {money(r.balance, r.currency, i18n)}
                </td>
                <td>
                  <StatusChip state={known?.state ?? "idle"}>
                    {known ? t(known.label) : r.status}
                  </StatusChip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  return (
    <table data-testid="portal-records-items">
      <thead>
        <tr className="dt-cols">
          <th>{t("records.col.name")}</th>
          <th>{t("records.col.description")}</th>
          {showSource ? <th>{t("records.col.source")}</th> : null}
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
            {showSource ? <td className="text-ink">{sourceName(sources, r.sourceId)}</td> : null}
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
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-muted">
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
