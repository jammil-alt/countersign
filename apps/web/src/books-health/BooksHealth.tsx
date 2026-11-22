// Books health (docs/plan.md §1.216): the one-page report on a client's QuickBooks, sized for its
// owner. Each finding leads with its dollars, says what it is in one sentence, names the area that
// fixes it (and whether it is switched on), and shows a few example transactions. Loaded on its
// own (the first load's budget, scripts/web-size.mjs): the portal at `/books-health`, the back
// office under the client's Data tab (ops/client/ClientBooksHealth.tsx). The checks' own words (summaries, notes) come from the API in
// English, as other server-side words do.
import type { BooksCheckId, BooksFinding, BooksHealthView } from "@countersign/core";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { type I18n, useI18n } from "../i18n/i18n";
import { Loaded, Page } from "../ui/page";
import { Badge, Card, EmptyState, PageHeader } from "../ui/primitives";
import { SkeletonCard } from "../ui/skeleton";

const CHECK_TITLE: Record<BooksCheckId, PlainKey> = {
  unreconciled_accounts: "books.check.unreconciled_accounts",
  uncategorized: "books.check.uncategorized",
  duplicate_vendors: "books.check.duplicate_vendors",
  duplicate_bills: "books.check.duplicate_bills",
  receivables_aging: "books.check.receivables_aging",
  payables_aging: "books.check.payables_aging",
  negative_balances: "books.check.negative_balances",
  undeposited_funds: "books.check.undeposited_funds",
  price_drift: "books.check.price_drift",
};

const AREA: Record<string, PlainKey> = {
  purchasing: "start.area.purchasing",
  sales: "start.area.sales",
  receivables: "start.area.receivables",
  bookkeeping: "start.area.bookkeeping",
  marketing: "start.area.marketing",
};

/** The portal's page: the client admin's own books. */
export function PortalBooksHealthScreen() {
  const { t } = useI18n();
  const state = useApi(apiRoutes.portalBooksHealth);
  return (
    <Page testId="portal-books-health">
      <PageHeader title={t("books.title")} subtitle={t("books.subtitle")} />
      <Loaded state={state} skeleton={<SkeletonCard lines={8} />}>
        {(view) => <BooksHealthReportView view={view} />}
      </Loaded>
    </Page>
  );
}

export function BooksHealthReportView({ view }: { view: BooksHealthView }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { report } = view;
  if (!view.company) return <EmptyState line={t("books.none")} />;
  if (!report) return <EmptyState line={t("books.syncing")} />;
  return (
    <div className="flex flex-col gap-6" data-testid="books-health">
      <p className="type-body text-ink-muted" data-testid="books-health-as-of">
        {[
          view.company.name,
          t("books.asOf", { day: fmt.date(report.asOf) }),
          report.since ? t("books.since", { day: fmt.date(report.since) }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {report.findings.length === 0 ? (
        <EmptyState tone="done" line={t("books.allClean")} testId="books-health-clean" />
      ) : (
        report.findings.map((f, i) => (
          <FindingCard
            key={f.check}
            rank={i + 1}
            finding={f}
            on={f.pack !== null && view.packs.includes(f.pack)}
            i18n={i18n}
          />
        ))
      )}
      {report.findings.length > 0 && report.clean.length > 0 ? (
        <p className="type-body text-ink-muted" data-testid="books-health-clean-list">
          {t("books.clean", { checks: report.clean.map((c) => t(CHECK_TITLE[c])).join(", ") })}
        </p>
      ) : null}
    </div>
  );
}

function FindingCard({
  rank,
  finding: f,
  on,
  i18n,
}: {
  rank: number;
  finding: BooksFinding;
  on: boolean;
  i18n: I18n;
}) {
  const { t, fmt } = i18n;
  const area = AREA[f.area];
  return (
    <Card
      testId={`books-finding-${f.check}`}
      title={`${rank}. ${t(CHECK_TITLE[f.check])}`}
      meta={
        <span className="figures text-ink" data-testid={`books-finding-${f.check}-amount`}>
          {fmt.money(f.amount, f.currency)}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="type-body text-ink">{f.summary}</p>
        <div className="flex flex-wrap items-center gap-2">
          {area ? <Badge>{t("books.fixedBy", { area: t(area) })}</Badge> : null}
          {f.pack ? (
            <Badge tone={on ? "positive" : "neutral"}>{on ? t("books.on") : t("books.off")}</Badge>
          ) : null}
        </div>
        {f.groups.length > 0 ? (
          <table data-testid={`books-finding-${f.check}-groups`}>
            <tbody>
              {f.groups.map((g) => (
                <tr key={g.label}>
                  <td className="text-ink">
                    {g.label}
                    {g.note ? <div className="text-ink-muted">{g.note}</div> : null}
                  </td>
                  <td className="n text-ink figures">{fmt.number(g.count)}</td>
                  <td className="n text-ink figures">{fmt.money(g.amount, f.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {f.examples.length > 0 ? (
          <>
            <h4 className="eyebrow text-ink-muted">{t("books.examples")}</h4>
            <table data-testid={`books-finding-${f.check}-examples`}>
              <tbody>
                {f.examples.map((x) => (
                  <tr key={`${x.entity}-${x.externalId}`}>
                    <td className="text-ink figures">{x.date ? fmt.day(x.date) : "–"}</td>
                    <td className="text-ink">
                      {x.name ?? "–"}
                      {x.note ? <div className="text-ink-muted">{x.note}</div> : null}
                    </td>
                    <td className="reference text-ink">{x.ref ?? "–"}</td>
                    <td className="n text-ink figures">{fmt.money(x.amount, f.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </div>
    </Card>
  );
}
