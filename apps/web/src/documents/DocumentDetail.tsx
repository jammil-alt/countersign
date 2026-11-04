// One document as both surfaces show it: what was printed (vendor, invoice number, dates, PO), the
// lines and the totals, whether the totals add up, the purchase it is matched to, and a button for
// the 5-minute link to the original. No model, cost or prompt reaches it (invariant 11). The portal
// (`/documents/:id`) and the back office (`/ops/clients/:id/documents/:documentId`) wrap it.
import type { DocumentDetail } from "@countersign/core";
import { Link } from "react-router-dom";
import { bytes, documentStatus, figure, money, SOURCE_LABEL } from "../portal/documents";
import { shortTime } from "../runs/format";
import { Badge, Button, Card, EmptyState, PageHeader, SectionLabel } from "../ui/primitives";

export function DocumentDetailView({
  data,
  onOpenOriginal,
  transactionHref,
  surface,
}: {
  data: DocumentDetail;
  onOpenOriginal(): void;
  /** The record page of the purchase it is matched to, in this surface. */
  transactionHref(id: string): string;
  surface: "portal" | "ops";
}) {
  const testPrefix = `${surface}-document`;
  const doc = data.document;
  const x = data.extraction;
  const status = documentStatus(doc.status);
  const reading = doc.status === "stored" || doc.status === "extracting";
  const email = (doc.meta as { email?: { from?: string; subject?: string } }).email;

  return (
    <>
      <PageHeader
        title={x ? `${x.vendorName} · invoice ${x.invoiceNumber}` : doc.filename}
        subtitle={`${SOURCE_LABEL[doc.source] ?? doc.source} ${shortTime(doc.receivedAt)}${
          email?.from ? ` from ${email.from}` : ""
        } · ${doc.filename} · ${bytes(doc.sizeBytes)}`}
        badge={
          <Badge tone={status.tone} testId={`${testPrefix}-status`}>
            {status.label}
          </Badge>
        }
        actions={
          <Button data-testid={`${testPrefix}-original`} onClick={onOpenOriginal}>
            Open the original
          </Button>
        }
      />
      {!x ? (
        <EmptyState>
          {reading
            ? "We're reading this document. It takes a minute or so."
            : doc.status === "failed"
              ? surface === "portal"
                ? "We couldn't read this document. Your team at Mezonas will look at it."
                : "We couldn't read this document. An agent's docs.extract can try again."
              : "Not read yet."}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {!x.totalsMatch ? (
            // Waiting on a person, not an error: signal, with its word (brand book).
            <div
              role="status"
              data-testid={`${testPrefix}-problems`}
              className="rounded-sm border border-signal-tint bg-signal-tint px-3.5 py-3 text-sm text-signal-ink"
            >
              <p className="font-medium">The totals don't add up, so a person will check them.</p>
              <ul className="mt-1 list-disc pl-5">
                {x.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="p-4 lg:col-span-2">
              <SectionLabel>What it says</SectionLabel>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
                <Fact label="Vendor" value={x.vendorName} />
                <Fact label="Invoice" value={x.invoiceNumber} />
                <Fact label="Invoice date" value={x.invoiceDate} />
                <Fact label="Due" value={x.dueDate ?? "–"} />
                <Fact label="PO or job" value={x.poNumber ?? "–"} />
                <Fact label="Pages" value={doc.pageCount ? String(doc.pageCount) : "–"} />
              </dl>
              {doc.transactionId ? (
                <p className="mt-3 text-sm text-ink-muted">
                  Matched to{" "}
                  <Link
                    to={transactionHref(doc.transactionId)}
                    className="text-link underline"
                    data-testid={`${testPrefix}-transaction`}
                  >
                    a purchase
                  </Link>
                  .
                </p>
              ) : null}
            </Card>
            <Card className="p-4" testId={`${testPrefix}-totals`}>
              <SectionLabel>Totals</SectionLabel>
              <dl className="flex flex-col gap-1.5 text-sm figures">
                <Amount label="Lines" value={money(x.linesSum, x.currency)} />
                <Amount label="Subtotal" value={money(x.subtotal, x.currency)} />
                <Amount label="Freight" value={money(x.freight, x.currency)} />
                {x.surcharges.map((s) => (
                  <Amount key={s.label} label={s.label} value={money(s.amount, x.currency)} />
                ))}
                <Amount label="Tax" value={money(x.tax, x.currency)} />
                <div className="mt-1 border-t border-line pt-1.5">
                  <Amount label="Total" value={money(x.total, x.currency)} strong />
                </div>
              </dl>
            </Card>
          </div>
          <section>
            <SectionLabel>
              {x.lines.length} {x.lines.length === 1 ? "line" : "lines"}
            </SectionLabel>
            <div className="dt dt-ana">
              <div>
                <table data-testid={`${testPrefix}-lines`}>
                  <thead>
                    <tr className="dt-cols">
                      <th className="n">#</th>
                      <th>Item</th>
                      <th>Description</th>
                      <th className="n">Qty</th>
                      <th>Unit</th>
                      <th className="n">Unit price</th>
                      <th className="n">Amount</th>
                      <th className="n">Page</th>
                    </tr>
                  </thead>
                  <tbody>
                    {x.lines.map((l) => (
                      <tr key={l.lineNo}>
                        <td className="n text-ink-muted">{l.lineNo}</td>
                        <td>{l.vendorSku ?? "–"}</td>
                        <td>{l.description}</td>
                        <td className="n">{figure(l.qty)}</td>
                        <td>{l.uom ?? ""}</td>
                        <td className="n">{unitPrice(l.unitPrice, x.currency)}</td>
                        <td className="n">{money(l.extPrice, x.currency)}</td>
                        <td className="n">{l.page ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

/** Unit prices keep up to 4 places as printed ($0.0425 a screw); amounts are cents. */
function unitPrice(value: string, currency: string): string {
  const cents = money(value, currency);
  const f = figure(value);
  return f.includes(".") && (f.split(".")[1]?.length ?? 0) > 2
    ? cents.replace(/\.\d+$/, `.${f.split(".")[1]}`)
    : cents;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function Amount({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? "font-medium text-ink" : "text-ink-muted"}>{label}</dt>
      <dd className={strong ? "font-medium text-ink" : "text-ink"}>{value}</dd>
    </div>
  );
}
