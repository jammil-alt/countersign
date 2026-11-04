// One record as both surfaces show it (plan §1.16): its kind, its fields and where it came from.
// A transaction with its lines, documents and the raw record it was made from; a raw record as it
// arrived from the client's tool or file, with what was made from it; a vendor with its recent
// transactions. A document's page is the document screen (the screens send it there). Words come
// from the portal's message files (English in the back office); what a tool or file sent (field
// names, values, memos) stays as it arrived.
import type { RecordView } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { connectorName } from "../inbox/change";
import { documentStatus, figure, money } from "../portal/documents";
import { shortTime } from "../runs/format";
import { Badge, Card, EmptyState, PageHeader, SectionLabel, type Tone } from "../ui/primitives";

export interface RecordHrefs {
  record(id: string): string;
  document(id: string): string;
}

const TXN_KIND: Record<string, PlainKey> = {
  purchase: "record.kind.purchase",
  bill: "record.kind.bill",
  vendor_credit: "record.kind.vendor_credit",
};

export const TXN_STATUS: Record<string, { label: PlainKey; tone: Tone }> = {
  // Waiting on a document: signal, with its word.
  needs_doc: { label: "record.status.needs_doc", tone: "warning" },
  doc_requested: { label: "record.status.doc_requested", tone: "warning" },
  doc_found: { label: "record.status.doc_found", tone: "accent" },
  extracted: { label: "record.status.extracted", tone: "accent" },
  processed: { label: "record.status.processed", tone: "positive" },
};

export function txnKind(k: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = TXN_KIND[k];
  return key ? t(key) : k;
}

function txnStatus(s: string, { t }: Pick<I18n, "t">): { label: string; tone: Tone } {
  const known = TXN_STATUS[s];
  return known ? { label: t(known.label), tone: known.tone } : { label: s, tone: "neutral" };
}

/** A calendar day as stored (YYYY-MM-DD) in the reader's format; anything else as it is. */
function day(value: string | null, { fmt }: Pick<I18n, "fmt">): string {
  if (!value) return "–";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? fmt.date(`${value}T12:00:00`) : value;
}

type Transaction = Extract<RecordView, { kind: "transaction" }>;
type Raw = Extract<RecordView, { kind: "raw_record" }>;
type Vendor = Extract<RecordView, { kind: "vendor" }>;
type Brief = Raw["transactions"][number];

export function RecordDetail({ record, hrefs }: { record: RecordView; hrefs: RecordHrefs }) {
  const { t } = useI18n();
  switch (record.kind) {
    case "transaction":
      return <TransactionDetail txn={record} hrefs={hrefs} />;
    case "raw_record":
      return <RawDetail r={record} hrefs={hrefs} />;
    case "vendor":
      return <VendorDetail v={record} hrefs={hrefs} />;
    case "document":
      // The screens open the document page instead; this is the fallback.
      return (
        <PageHeader
          title={
            <Link to={hrefs.document(record.documentId)} className="hover:underline">
              {record.filename}
            </Link>
          }
          subtitle={t("documents.col.document")}
        />
      );
  }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="break-words text-ink">{children}</dd>
    </div>
  );
}

function TransactionDetail({ txn, hrefs }: { txn: Transaction; hrefs: RecordHrefs }) {
  const i18n = useI18n();
  const { t } = i18n;
  const status = txnStatus(txn.status, i18n);
  return (
    <div data-testid="record-transaction">
      <PageHeader
        title={`${txnKind(txn.txnKind, i18n)} · ${money(txn.total, txn.currency, i18n)}`}
        subtitle={[
          txn.vendor?.name,
          txn.txnDate ? day(txn.txnDate, i18n) : null,
          t("record.fromTool", { tool: connectorName(txn.connector) }),
        ]
          .filter(Boolean)
          .join(" · ")}
        badge={
          <Badge tone={status.tone} testId="record-status">
            {status.label}
          </Badge>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <SectionLabel>{t("document.whatItSays")}</SectionLabel>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
            <Fact label={t("document.vendor")}>
              {txn.vendor ? (
                <Link to={hrefs.record(txn.vendor.id)} className="text-link underline">
                  {txn.vendor.name}
                </Link>
              ) : (
                "–"
              )}
            </Fact>
            <Fact label={t("record.date")}>{day(txn.txnDate, i18n)}</Fact>
            <Fact label={t("document.total")}>
              <span className="figures">{money(txn.total, txn.currency, i18n)}</span>
            </Fact>
            <Fact label={t("record.paidWith")}>{txn.paymentType ?? "–"}</Fact>
            <Fact label={t("record.purchaser")}>{txn.purchaserRef ?? "–"}</Fact>
            <Fact label={t("record.memo")}>{txn.memo ?? "–"}</Fact>
          </dl>
        </Card>
        <Card className="p-4" testId="record-origin">
          <SectionLabel>{t("record.whereFrom")}</SectionLabel>
          <p className="text-sm text-ink">
            {connectorName(txn.connector)}
            <span className="ml-2 reference text-ink-muted">{txn.externalId}</span>
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {t("record.recorded", { time: shortTime(txn.createdAt, undefined, i18n) })}
          </p>
          {txn.rawRecordId ? (
            <p className="mt-2 text-sm">
              <Link
                to={hrefs.record(txn.rawRecordId)}
                className="text-link underline"
                data-testid="record-raw-link"
              >
                {t("record.asItArrived")}
              </Link>
            </p>
          ) : null}
        </Card>
      </div>

      <section className="mt-6">
        <SectionLabel>{t("document.lineCount", { count: txn.lines.length })}</SectionLabel>
        {txn.lines.length === 0 ? (
          <EmptyState>{t("record.noLines")}</EmptyState>
        ) : (
          <div className="dt dt-ana">
            <div>
              <table data-testid="record-lines">
                <thead>
                  <tr className="dt-cols">
                    <th className="n">#</th>
                    <th>{t("record.col.item")}</th>
                    <th>{t("document.col.description")}</th>
                    <th className="n">{t("document.col.qty")}</th>
                    <th className="n">{t("document.col.unitPrice")}</th>
                    <th className="n">{t("document.col.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {txn.lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="n text-ink-muted">{l.lineNo}</td>
                      <td>{l.itemRef ?? l.accountRef ?? "–"}</td>
                      <td>{l.description ?? ""}</td>
                      <td className="n">{l.qty === null ? "" : figure(l.qty, i18n)}</td>
                      <td className="n">
                        {l.unitPrice === null ? "" : money(l.unitPrice, txn.currency, i18n)}
                      </td>
                      <td className="n">{money(l.amount, txn.currency, i18n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="mt-6">
        <SectionLabel>{t("record.documents")}</SectionLabel>
        {txn.documents.length === 0 ? (
          <EmptyState>{t("record.noDocuments")}</EmptyState>
        ) : (
          <Card testId="record-documents">
            <ul>
              {txn.documents.map((d) => {
                const s = documentStatus(d.status, i18n);
                return (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <Link
                      to={hrefs.document(d.id)}
                      className="font-medium text-ink hover:underline"
                    >
                      {d.filename}
                    </Link>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

/** A payload's top-level fields as label/value rows; nested values as compact JSON. */
export function payloadRows(payload: unknown, valueLabel = "Value"): [string, string][] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [[valueLabel, JSON.stringify(payload)]];
  }
  return Object.entries(payload as Record<string, unknown>).map(([k, v]) => [
    k,
    typeof v === "string" ? v : JSON.stringify(v, null, 2),
  ]);
}

function RawDetail({ r, hrefs }: { r: Raw; hrefs: RecordHrefs }) {
  const i18n = useI18n();
  const { t } = i18n;
  // A CSV row's cells read best as the file's own columns.
  const cells = (r.payload as { cells?: unknown } | null)?.cells;
  const rows = payloadRows(
    cells && typeof cells === "object" ? cells : r.payload,
    t("record.value"),
  );
  const file = (r.payload as { file?: { filename?: unknown; row?: unknown } } | null)?.file;
  return (
    <div data-testid="record-raw">
      <PageHeader
        title={t("record.rawTitle", { type: r.entityType, tool: connectorName(r.connector) })}
        subtitle={[
          typeof file?.filename === "string"
            ? typeof file.row === "number"
              ? t("record.fileRow", { file: file.filename, row: file.row })
              : file.filename
            : null,
          t("record.received", { time: shortTime(r.syncedAt, undefined, i18n) }),
        ]
          .filter(Boolean)
          .join(" · ")}
        badge={r.isDeleted ? <Badge tone="neutral">{t("record.deletedInTool")}</Badge> : undefined}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2" testId="record-payload">
          <SectionLabel>{t("record.asItArrived")}</SectionLabel>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-muted">{k}</dt>
                <dd className="font-mono text-xs break-words whitespace-pre-wrap text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card className="p-4" testId="record-origin">
          <SectionLabel>{t("record.whereFrom")}</SectionLabel>
          <dl className="flex flex-col gap-2 text-sm">
            <Fact label={t("record.tool")}>{connectorName(r.connector)}</Fact>
            <Fact label={t("record.idThere")}>
              <span className="reference">{r.externalId}</span>
            </Fact>
            {r.externalVersion ? (
              <Fact label={t("record.version")}>
                <span className="reference">{r.externalVersion}</span>
              </Fact>
            ) : null}
          </dl>
        </Card>
      </div>
      <section className="mt-6">
        <SectionLabel>{t("record.madeFrom")}</SectionLabel>
        <BriefList items={r.transactions} hrefs={hrefs} empty={t("record.nothingMade")} />
      </section>
    </div>
  );
}

function VendorDetail({ v, hrefs }: { v: Vendor; hrefs: RecordHrefs }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div data-testid="record-vendor">
      <PageHeader
        title={v.name}
        subtitle={t("record.vendorSince", { time: shortTime(v.createdAt, undefined, i18n) })}
        badge={<Badge tone="neutral">{t("document.vendor")}</Badge>}
      />
      {v.aliases.length > 0 ? (
        <p className="mb-4 text-sm text-ink-muted">
          {t("record.aliases", { names: v.aliases.join(", ") })}
        </p>
      ) : null}
      <SectionLabel>{t("record.recentTransactions")}</SectionLabel>
      <BriefList items={v.transactions} hrefs={hrefs} empty={t("record.noTransactions")} />
    </div>
  );
}

function BriefList({
  items,
  hrefs,
  empty,
}: {
  items: readonly Brief[];
  hrefs: RecordHrefs;
  empty: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (items.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="dt dt-ana">
      <div>
        <table data-testid="record-transactions">
          <thead>
            <tr className="dt-cols">
              <th>{t("record.col.transaction")}</th>
              <th>{t("record.date")}</th>
              <th className="n">{t("document.total")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.id}>
                <td>
                  <Link to={hrefs.record(b.id)} className="font-medium text-ink hover:underline">
                    {txnKind(b.txnKind, i18n)}
                  </Link>
                </td>
                <td className="figures">{day(b.txnDate, i18n)}</td>
                <td className="n figures">{money(b.total, b.currency, i18n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
