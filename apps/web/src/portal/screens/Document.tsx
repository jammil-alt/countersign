// `/documents/:id`: one document as we read it: what was printed (vendor, invoice number, dates, PO),
// the lines and the totals, whether the totals add up, and a 5-minute link to the original. No
// model, cost or prompt reaches this page (invariant 11).
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { shortTime } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
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
import { bytes, documentStatus, figure, money, sourceLabel } from "../documents";

export function PortalDocumentScreen() {
  const { id = "" } = useParams();
  const api = useApiClient();
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.portalDocument, { params: { id } });
  const reading = data?.document.status === "stored" || data?.document.status === "extracting";
  usePoll(reload, reading, 3_000);

  async function openOriginal() {
    // The link lasts 5 minutes: ask for a fresh one each time.
    const fresh = await api.call(apiRoutes.portalDocument, { params: { id } });
    window.open(fresh.url, "_blank", "noopener,noreferrer");
  }

  const doc = data?.document;
  const x = data?.extraction;
  const status = doc ? documentStatus(doc.status, i18n) : null;
  const email = (doc?.meta as { email?: { from?: string; subject?: string } } | undefined)?.email;
  /** A date as printed (YYYY-MM-DD) in the reader's format; anything else as it was printed. */
  const printedDate = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? fmt.date(`${value}T12:00:00`) : value;

  return (
    <div className="max-w-6xl">
      <p className="mb-2 text-sm">
        <Link to="/connections" className="text-ink-muted hover:underline">
          {t("nav.connections")}
        </Link>
      </p>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {doc && status ? (
        <>
          <PageHeader
            title={
              x
                ? t("document.title", { vendor: x.vendorName, number: x.invoiceNumber })
                : doc.filename
            }
            subtitle={`${
              email?.from
                ? t("document.receivedFrom", {
                    source: sourceLabel(doc.source, i18n),
                    time: shortTime(doc.receivedAt, undefined, i18n),
                    from: email.from,
                  })
                : t("document.received", {
                    source: sourceLabel(doc.source, i18n),
                    time: shortTime(doc.receivedAt, undefined, i18n),
                  })
            } · ${doc.filename} · ${bytes(doc.sizeBytes, i18n)}`}
            badge={
              <Badge tone={status.tone} testId="portal-document-status">
                {status.label}
              </Badge>
            }
            actions={
              <Button data-testid="portal-document-original" onClick={() => void openOriginal()}>
                {t("document.openOriginal")}
              </Button>
            }
          />
          {!x ? (
            <EmptyState>
              {reading
                ? t("document.reading")
                : doc.status === "failed"
                  ? t("document.failed")
                  : t("document.notRead")}
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-6">
              {!x.totalsMatch ? (
                // Waiting on a person, not an error: signal, with its word (brand book).
                <div
                  role="status"
                  data-testid="portal-document-problems"
                  className="rounded-sm border border-signal-tint bg-signal-tint px-3.5 py-3 text-sm text-signal-ink"
                >
                  <p className="font-medium">{t("document.totalsOff")}</p>
                  <ul className="mt-1 list-disc pl-5">
                    {x.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Card className="p-4 lg:col-span-2">
                  <SectionLabel>{t("document.whatItSays")}</SectionLabel>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
                    <Fact label={t("document.vendor")} value={x.vendorName} />
                    <Fact label={t("document.invoice")} value={x.invoiceNumber} />
                    <Fact label={t("document.invoiceDate")} value={printedDate(x.invoiceDate)} />
                    <Fact
                      label={t("document.due")}
                      value={x.dueDate ? printedDate(x.dueDate) : "–"}
                    />
                    <Fact label={t("document.po")} value={x.poNumber ?? "–"} />
                    <Fact
                      label={t("document.pages")}
                      value={doc.pageCount ? fmt.number(doc.pageCount) : "–"}
                    />
                  </dl>
                  {doc.transactionId ? (
                    <p className="mt-3 text-sm text-ink-muted">{t("document.matched")}</p>
                  ) : null}
                </Card>
                <Card className="p-4" testId="portal-document-totals">
                  <SectionLabel>{t("document.totals")}</SectionLabel>
                  <dl className="flex flex-col gap-1.5 text-sm figures">
                    <Amount
                      label={t("document.lines")}
                      value={money(x.linesSum, x.currency, i18n)}
                    />
                    <Amount
                      label={t("document.subtotal")}
                      value={money(x.subtotal, x.currency, i18n)}
                    />
                    <Amount
                      label={t("document.freight")}
                      value={money(x.freight, x.currency, i18n)}
                    />
                    {x.surcharges.map((s) => (
                      // Surcharge labels are printed on the invoice: they stay as printed.
                      <Amount
                        key={s.label}
                        label={s.label}
                        value={money(s.amount, x.currency, i18n)}
                      />
                    ))}
                    <Amount label={t("document.tax")} value={money(x.tax, x.currency, i18n)} />
                    <div className="mt-1 border-t border-line pt-1.5">
                      <Amount
                        label={t("document.total")}
                        value={money(x.total, x.currency, i18n)}
                        strong
                      />
                    </div>
                  </dl>
                </Card>
              </div>
              <section>
                <SectionLabel>{t("document.lineCount", { count: x.lines.length })}</SectionLabel>
                <div className="dt dt-ana">
                  <div>
                    <table data-testid="portal-document-lines">
                      <thead>
                        <tr className="dt-cols">
                          <th className="n">#</th>
                          <th>{t("document.col.item")}</th>
                          <th>{t("document.col.description")}</th>
                          <th className="n">{t("document.col.qty")}</th>
                          <th>{t("document.col.unit")}</th>
                          <th className="n">{t("document.col.unitPrice")}</th>
                          <th className="n">{t("document.col.amount")}</th>
                          <th className="n">{t("document.col.page")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {x.lines.map((l) => (
                          <tr key={l.lineNo}>
                            <td className="n text-ink-muted">{l.lineNo}</td>
                            <td>{l.vendorSku ?? "–"}</td>
                            <td>{l.description}</td>
                            <td className="n">{figure(l.qty, i18n)}</td>
                            <td>{l.uom ?? ""}</td>
                            <td className="n">{fmt.unitPrice(l.unitPrice, x.currency)}</td>
                            <td className="n">{money(l.extPrice, x.currency, i18n)}</td>
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
      ) : null}
    </div>
  );
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
