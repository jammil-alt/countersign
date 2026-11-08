// P-9: the Purchasing area's Requests screen (docs/plan.md §1.71): the client's purchase requests,
// newest first, then one request's page: what was asked, the quotes as they came in, the
// comparison, the vendor picked, the orders and the documents (the RFQ and purchase order PDFs).
// The portal shows the client's own; the back office shows the same for a client it serves
// (`clientId`). Words come from the message catalog; item and vendor names are the pack's data and
// show as written. Nothing here names an agent, a prompt or a cost.
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  type Tone,
} from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import { CompareTable } from "./CompareTable";
import {
  QUOTE_STATUS_LABEL,
  type QuoteStatus,
  REQUEST_STATUS_LABEL,
  type RequestPage,
  type RequestStatus,
  type RequestsReportRow,
} from "./types";

const PACK = "materials";
const REPORT = "requests";

export const REQUEST_TONE: Record<RequestStatus, Tone> = {
  open: "neutral",
  quoting: "accent",
  quoted: "warning",
  ordered: "positive",
  cancelled: "neutral",
  closed: "positive",
};

const QUOTE_TONE: Record<QuoteStatus, Tone> = {
  draft: "neutral",
  sent: "accent",
  received: "positive",
  declined: "neutral",
  expired: "neutral",
};

const requestsPath = (clientId?: string) =>
  clientId ? `/ops/clients/${clientId}/reports/${PACK}/${REPORT}` : `/reports/${PACK}/${REPORT}`;

/** The request's quantity and unit, or a question when nobody said how many. */
function useQty() {
  const { t, fmt } = useI18n();
  return (qty: string | null, unit: string | null) =>
    qty === null
      ? t("materials.request.howMany")
      : [fmt.figure(qty), unit].filter(Boolean).join(" ");
}

export function RequestsView({ clientId }: { clientId?: string }) {
  const { t, intl } = useI18n();
  const portal = useApi(
    apiRoutes.portalPackReport,
    clientId ? null : { params: { pack: PACK, report: REPORT } },
  );
  const ops = useApi(
    apiRoutes.opsClientPackReport,
    clientId ? { params: { id: clientId, pack: PACK, report: REPORT } } : null,
  );
  const { data, error, loading, reload } = clientId ? ops : portal;
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const rows = ((data?.report as { requests?: RequestsReportRow[] } | undefined)?.requests ??
    []) as RequestsReportRow[];
  return (
    <div data-testid="materials-requests">
      <PageHeader
        title={t("materials.requests.title")}
        subtitle={t("materials.requests.description")}
      />
      {rows.length === 0 ? (
        <EmptyState>{t("materials.requests.empty")}</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
          {rows.map((r) => (
            <li key={r.id} data-testid="materials-request-row">
              <Link
                to={`${requestsPath(clientId)}/${r.id}`}
                className="flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    {r.lines
                      .slice(0, 3)
                      .map((l) => l.description)
                      .join(", ")}
                    {r.lines.length > 3 ? "…" : ""}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {[
                      t("materials.requests.asked", {
                        date: dayLabel(r.createdAt.slice(0, 10), intl),
                      }),
                      t("materials.requests.items", { count: r.lines.length }),
                      r.quotes.length > 0
                        ? t("materials.requests.quotes", {
                            received: r.quotes.filter((q) => q.status === "received").length,
                            count: r.quotes.length,
                          })
                        : null,
                      r.neededBy
                        ? t("materials.requests.neededBy", { date: dayLabel(r.neededBy, intl) })
                        : null,
                      r.order ? t("materials.requests.order", { ref: r.order }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Badge tone={REQUEST_TONE[r.status]} testId="materials-request-status">
                  {t(REQUEST_STATUS_LABEL[r.status])}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One request's page; the id comes from the route. */
export function RequestView({ clientId }: { clientId?: string }) {
  const { id = "" } = useParams();
  const { t, intl, fmt } = useI18n();
  const qty = useQty();
  const portal = useApi(
    apiRoutes.portalPackReportItem,
    clientId ? null : { params: { pack: PACK, report: REPORT, itemId: id } },
  );
  const ops = useApi(
    apiRoutes.opsClientPackReportItem,
    clientId ? { params: { id: clientId, pack: PACK, report: REPORT, itemId: id } } : null,
  );
  const { data, error, loading, reload } = clientId ? ops : portal;
  if (loading && !data) return <Loading label={t("materials.request.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const r = (data?.report as { request?: RequestPage } | undefined)?.request;
  if (!r) return null;
  const vendorOf = (quoteRequestId: string | null) =>
    r.quotes.find((q) => q.id === quoteRequestId)?.vendorName ?? "";
  const docHref = (docId: string) =>
    clientId ? `/ops/clients/${clientId}/documents/${docId}` : `/documents/${docId}`;
  const s = r.comparison?.suggestion;
  return (
    <div data-testid="materials-request" className="flex flex-col gap-6">
      <div>
        <Link to={requestsPath(clientId)} className="text-sm text-ink-muted">
          {t("materials.request.back")}
        </Link>
        <PageHeader
          title={t("materials.requests.asked", { date: dayLabel(r.createdAt.slice(0, 10), intl) })}
          subtitle={[
            r.neededBy
              ? t("materials.requests.neededBy", { date: dayLabel(r.neededBy, intl) })
              : null,
            r.fulfillment === "pickup"
              ? t("materials.request.pickup")
              : r.fulfillment === "delivery" && r.deliverTo
                ? t("materials.request.deliver", { place: r.deliverTo })
                : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <Badge tone={REQUEST_TONE[r.status]} testId="materials-request-status">
          {t(REQUEST_STATUS_LABEL[r.status])}
        </Badge>
      </div>

      <section>
        <SectionLabel>{t("materials.request.lines")}</SectionLabel>
        <Card className="p-0">
          <ul className="flex flex-col divide-y divide-line">
            {r.lines.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-start justify-between gap-3 p-4"
                data-testid="materials-request-line"
              >
                <div className="min-w-0">
                  <p className="font-medium text-ink">{l.description}</p>
                  <p className="text-sm text-ink-muted">
                    {l.catalogItemName ?? t("materials.request.unmatched")}
                  </p>
                </div>
                <span className="ds-num">{qty(l.qty, l.unit)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {r.quotes.length > 0 ? (
        <section>
          <SectionLabel>{t("materials.request.quotes")}</SectionLabel>
          <Card className="p-0">
            <ul className="flex flex-col divide-y divide-line">
              {r.quotes.map((q) => (
                <li
                  key={q.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                  data-testid="materials-request-quote"
                >
                  <span className="font-medium text-ink">{q.vendorName}</span>
                  <Badge tone={QUOTE_TONE[q.status]}>{t(QUOTE_STATUS_LABEL[q.status])}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {r.comparison && r.comparison.vendors.length > 0 ? (
        <section>
          <SectionLabel>{t("materials.request.compare")}</SectionLabel>
          {r.choice ? (
            <p className="mb-2 text-sm text-ink" data-testid="materials-request-choice">
              {r.choice.kind === "single"
                ? t("materials.request.chosen", { vendor: vendorOf(r.choice.quoteRequestId) })
                : t("materials.request.chosenSplit")}
            </p>
          ) : s && s.kind === "single" && s.total ? (
            <p className="mb-2 text-sm text-ink">
              {t("materials.request.suggested", {
                vendor: vendorOf(s.quoteRequestId),
                total: fmt.money(s.total, s.currency ?? undefined),
              })}
            </p>
          ) : s && s.kind === "split" ? (
            <p className="mb-2 text-sm text-ink">{t("materials.request.suggestedSplit")}</p>
          ) : null}
          <CompareTable comparison={r.comparison} />
        </section>
      ) : null}

      {r.orders.length > 0 ? (
        <section>
          <SectionLabel>{t("materials.request.orders")}</SectionLabel>
          <ul className="flex flex-col gap-1" data-testid="materials-request-orders">
            {r.orders.map((o) => (
              <li key={`${o.connector}:${o.externalId}`} className="text-sm text-ink">
                {t("materials.requests.order", { ref: o.externalId })}
                {o.quoteRequestId ? ` · ${vendorOf(o.quoteRequestId)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {r.documents.length > 0 ? (
        <section>
          <SectionLabel>{t("materials.request.documents")}</SectionLabel>
          <ul className="flex flex-col gap-1">
            {r.documents.map((d) => (
              <li key={d.id} data-testid="materials-request-document">
                <Link to={docHref(d.id)} className="text-sm text-ink underline">
                  {t(
                    d.kind === "purchase_order"
                      ? "materials.request.doc.purchase_order"
                      : d.kind === "rfq"
                        ? "materials.request.doc.rfq"
                        : "materials.request.doc.other",
                  )}
                  : {d.filename}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
