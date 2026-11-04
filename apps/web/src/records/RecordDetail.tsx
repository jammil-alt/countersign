// One record as both surfaces show it (plan §1.16): its kind, its fields and where it came from.
// A transaction with its lines, documents and the raw record it was made from; a raw record as it
// arrived from the client's tool or file, with what was made from it; a vendor with its recent
// transactions. A document's page is the document screen (the screens send it there).
import type { RecordView } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { connectorName } from "../inbox/change";
import { documentStatus, figure, money } from "../portal/documents";
import { shortTime } from "../runs/format";
import { Badge, Card, EmptyState, PageHeader, SectionLabel, type Tone } from "../ui/primitives";

export interface RecordHrefs {
  record(id: string): string;
  document(id: string): string;
}

const TXN_KIND: Record<string, string> = {
  purchase: "Purchase",
  bill: "Bill",
  vendor_credit: "Vendor credit",
};

export const TXN_STATUS: Record<string, { label: string; tone: Tone }> = {
  // Waiting on a document: signal, with its word.
  needs_doc: { label: "Needs a document", tone: "warning" },
  doc_requested: { label: "Document requested", tone: "warning" },
  doc_found: { label: "Document found", tone: "accent" },
  extracted: { label: "Document read", tone: "accent" },
  processed: { label: "Done", tone: "positive" },
};

export const txnKind = (k: string) => TXN_KIND[k] ?? k;
const txnStatus = (s: string) => TXN_STATUS[s] ?? { label: s, tone: "neutral" as Tone };

type Transaction = Extract<RecordView, { kind: "transaction" }>;
type Raw = Extract<RecordView, { kind: "raw_record" }>;
type Vendor = Extract<RecordView, { kind: "vendor" }>;
type Brief = Raw["transactions"][number];

export function RecordDetail({ record, hrefs }: { record: RecordView; hrefs: RecordHrefs }) {
  switch (record.kind) {
    case "transaction":
      return <TransactionDetail t={record} hrefs={hrefs} />;
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
          subtitle="Document"
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

function TransactionDetail({ t, hrefs }: { t: Transaction; hrefs: RecordHrefs }) {
  const status = txnStatus(t.status);
  return (
    <div data-testid="record-transaction">
      <PageHeader
        title={`${txnKind(t.txnKind)} · ${money(t.total, t.currency)}`}
        subtitle={[t.vendor?.name, t.txnDate, `from ${connectorName(t.connector)}`]
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
          <SectionLabel>What it says</SectionLabel>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
            <Fact label="Vendor">
              {t.vendor ? (
                <Link to={hrefs.record(t.vendor.id)} className="text-link underline">
                  {t.vendor.name}
                </Link>
              ) : (
                "–"
              )}
            </Fact>
            <Fact label="Date">{t.txnDate ?? "–"}</Fact>
            <Fact label="Total">
              <span className="figures">{money(t.total, t.currency)}</span>
            </Fact>
            <Fact label="Paid with">{t.paymentType ?? "–"}</Fact>
            <Fact label="Purchaser">{t.purchaserRef ?? "–"}</Fact>
            <Fact label="Memo">{t.memo ?? "–"}</Fact>
          </dl>
        </Card>
        <Card className="p-4" testId="record-origin">
          <SectionLabel>Where it came from</SectionLabel>
          <p className="text-sm text-ink">
            {connectorName(t.connector)}
            <span className="ml-2 reference text-ink-muted">{t.externalId}</span>
          </p>
          <p className="mt-1 text-sm text-ink-muted">Recorded {shortTime(t.createdAt)}</p>
          {t.rawRecordId ? (
            <p className="mt-2 text-sm">
              <Link
                to={hrefs.record(t.rawRecordId)}
                className="text-link underline"
                data-testid="record-raw-link"
              >
                As it arrived
              </Link>
            </p>
          ) : null}
        </Card>
      </div>

      <section className="mt-6">
        <SectionLabel>
          {t.lines.length} {t.lines.length === 1 ? "line" : "lines"}
        </SectionLabel>
        {t.lines.length === 0 ? (
          <EmptyState>No lines: the total is all we have.</EmptyState>
        ) : (
          <div className="dt dt-ana">
            <div>
              <table data-testid="record-lines">
                <thead>
                  <tr className="dt-cols">
                    <th className="n">#</th>
                    <th>Account or item</th>
                    <th>Description</th>
                    <th className="n">Qty</th>
                    <th className="n">Unit price</th>
                    <th className="n">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {t.lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="n text-ink-muted">{l.lineNo}</td>
                      <td>{l.itemRef ?? l.accountRef ?? "–"}</td>
                      <td>{l.description ?? ""}</td>
                      <td className="n">{l.qty === null ? "" : figure(l.qty)}</td>
                      <td className="n">
                        {l.unitPrice === null ? "" : money(l.unitPrice, t.currency)}
                      </td>
                      <td className="n">{money(l.amount, t.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="mt-6">
        <SectionLabel>Documents</SectionLabel>
        {t.documents.length === 0 ? (
          <EmptyState>No document is linked to it yet.</EmptyState>
        ) : (
          <Card testId="record-documents">
            <ul>
              {t.documents.map((d) => {
                const s = documentStatus(d.status);
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
export function payloadRows(payload: unknown): [string, string][] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [["Value", JSON.stringify(payload)]];
  }
  return Object.entries(payload as Record<string, unknown>).map(([k, v]) => [
    k,
    typeof v === "string" ? v : JSON.stringify(v, null, 2),
  ]);
}

function RawDetail({ r, hrefs }: { r: Raw; hrefs: RecordHrefs }) {
  // A CSV row's cells read best as the file's own columns.
  const cells = (r.payload as { cells?: unknown } | null)?.cells;
  const rows = payloadRows(cells && typeof cells === "object" ? cells : r.payload);
  const file = (r.payload as { file?: { filename?: unknown; row?: unknown } } | null)?.file;
  return (
    <div data-testid="record-raw">
      <PageHeader
        title={`${r.entityType} from ${connectorName(r.connector)}`}
        subtitle={[
          typeof file?.filename === "string"
            ? `${file.filename}${typeof file.row === "number" ? `, row ${file.row}` : ""}`
            : null,
          `received ${shortTime(r.syncedAt)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        badge={r.isDeleted ? <Badge tone="neutral">Deleted in the tool</Badge> : undefined}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2" testId="record-payload">
          <SectionLabel>As it arrived</SectionLabel>
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
          <SectionLabel>Where it came from</SectionLabel>
          <dl className="flex flex-col gap-2 text-sm">
            <Fact label="Tool">{connectorName(r.connector)}</Fact>
            <Fact label="Its id there">
              <span className="reference">{r.externalId}</span>
            </Fact>
            {r.externalVersion ? (
              <Fact label="Version">
                <span className="reference">{r.externalVersion}</span>
              </Fact>
            ) : null}
          </dl>
        </Card>
      </div>
      <section className="mt-6">
        <SectionLabel>Made from it</SectionLabel>
        <BriefList items={r.transactions} hrefs={hrefs} empty="Nothing was made from it." />
      </section>
    </div>
  );
}

function VendorDetail({ v, hrefs }: { v: Vendor; hrefs: RecordHrefs }) {
  return (
    <div data-testid="record-vendor">
      <PageHeader
        title={v.name}
        subtitle={`Vendor · first seen ${shortTime(v.createdAt)}`}
        badge={<Badge tone="neutral">Vendor</Badge>}
      />
      {v.aliases.length > 0 ? (
        <p className="mb-4 text-sm text-ink-muted">Also known as {v.aliases.join(", ")}</p>
      ) : null}
      <SectionLabel>Recent transactions</SectionLabel>
      <BriefList
        items={v.transactions}
        hrefs={hrefs}
        empty="No transactions from this vendor yet."
      />
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
  if (items.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="dt dt-ana">
      <div>
        <table data-testid="record-transactions">
          <thead>
            <tr className="dt-cols">
              <th>Transaction</th>
              <th>Date</th>
              <th className="n">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={hrefs.record(t.id)} className="font-medium text-ink hover:underline">
                    {txnKind(t.txnKind)}
                  </Link>
                </td>
                <td className="figures">{t.txnDate ?? "–"}</td>
                <td className="n figures">{money(t.total, t.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
