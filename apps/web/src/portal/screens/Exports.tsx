// `/settings/exports` (UI-3a, drafted in the prototype's style; docs/plan.md §1.36): the client
// admin downloads, for a period of whole days (at most a year): the accountant export (each change
// made to your tools, who signed it, its run and documents; a ZIP, or the changes alone as CSV),
// and the audit log as CSV. The files come straight from the API (`Content-Disposition:
// attachment`), so each is a plain link.
import { EXPORT_PERIOD_MAX_DAYS, periodDays } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { Field, TextInput } from "../../ui/forms";
import { Columns, Page } from "../../ui/page";
import { buttonClass, Card, PageHeader, Placeholder } from "../../ui/primitives";
import { isoDay, monthEnd, monthStart } from "../../usage/format";
import { PORTAL_PATHS } from "../paths";

type Format = "zip" | "csv";

/** Last calendar month, the period an accountant usually asks for. */
export function lastMonth(today: Date = new Date()): { from: string; to: string } {
  const from = monthStart(isoDay(today), 1);
  return { from, to: monthEnd(from) };
}

/** What is wrong with a period, as a message key; null when it can be exported. */
function periodProblem(
  from: string,
  to: string,
): "exports.problem.order" | "exports.problem.long" | "exports.problem.missing" | null {
  if (!from || !to) return "exports.problem.missing";
  if (from > to) return "exports.problem.order";
  if (periodDays(from, to) > EXPORT_PERIOD_MAX_DAYS) return "exports.problem.long";
  return null;
}

export function PortalExportsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  if (client?.role !== "client_admin") {
    return <Placeholder title={t("exports.title")}>{t("exports.adminOnly")}</Placeholder>;
  }
  return (
    <Page testId="portal-exports-page">
      <div>
        <p className="eyebrow mb-2 text-ink-muted">
          <Link to={PORTAL_PATHS.settings} className="text-link hover:underline">
            {t("nav.settings")}
          </Link>
        </p>
        <PageHeader title={t("exports.title")} subtitle={t("exports.subtitle")} />
      </div>
      <Columns count={2}>
        <AccountantExport />
        <AuditExport />
      </Columns>
    </Page>
  );
}

/** From and to, two whole days. */
function PeriodFields({
  from,
  to,
  onFrom,
  onTo,
  area,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  area: string;
}) {
  const { t } = useI18n();
  const problem = periodProblem(from, to);
  return (
    <div className="flex flex-wrap gap-3">
      <Field label={t("exports.from")} className="min-w-40 flex-1">
        <TextInput
          type="date"
          data-testid={`${area}-from`}
          value={from}
          max={to || undefined}
          onChange={(e) => onFrom(e.target.value)}
        />
      </Field>
      <Field
        label={t("exports.to")}
        className="min-w-40 flex-1"
        error={
          problem === "exports.problem.long"
            ? t(problem, { days: EXPORT_PERIOD_MAX_DAYS })
            : problem
              ? t(problem)
              : undefined
        }
        testId={`${area}-to`}
      >
        <TextInput
          type="date"
          data-testid={`${area}-to`}
          value={to}
          min={from || undefined}
          invalid={!!problem}
          onChange={(e) => onTo(e.target.value)}
        />
      </Field>
    </div>
  );
}

/** A download link, or the same words greyed out while the period can't be exported. */
function Download({ href, label, testId }: { href: string | null; label: string; testId: string }) {
  if (!href) {
    return (
      <span
        aria-disabled
        className={buttonClass("primary", "self-start opacity-50")}
        data-testid={testId}
      >
        {label}
      </span>
    );
  }
  return (
    <a href={href} download className={buttonClass("primary", "self-start")} data-testid={testId}>
      {label}
    </a>
  );
}

function AccountantExport() {
  const { t } = useI18n();
  const [period, setPeriod] = useState(lastMonth);
  const [format, setFormat] = useState<Format>("zip");
  const ok = periodProblem(period.from, period.to) === null;
  const query = new URLSearchParams({ from: period.from, to: period.to, format });
  return (
    <Card title={t("exports.accountant")} pad testId="portal-export-accountant">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">{t("exports.accountantHelp")}</p>
        <PeriodFields
          area="portal-export-accountant"
          from={period.from}
          to={period.to}
          onFrom={(from) => setPeriod((p) => ({ ...p, from }))}
          onTo={(to) => setPeriod((p) => ({ ...p, to }))}
        />
        <div role="radiogroup" aria-label={t("exports.format")} className="flex flex-col gap-2">
          {(["zip", "csv"] as const).map((f) => (
            // biome-ignore lint/a11y/useSemanticElements: the design system's Radio is a button with role=radio.
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              data-testid={`portal-export-format-${f}`}
              onClick={() => setFormat(f)}
              className="ds-choice items-start text-left"
            >
              <span className="ds-radio mt-0.5" />
              <span>
                <span className="block text-ink">
                  {f === "zip" ? t("exports.format.zip") : t("exports.format.csv")}
                </span>
                <span className="block text-sm text-ink-muted">
                  {f === "zip" ? t("exports.format.zipHelp") : t("exports.format.csvHelp")}
                </span>
              </span>
            </button>
          ))}
        </div>
        <Download
          href={ok ? `/api/exports/accountant?${query}` : null}
          label={t("exports.download")}
          testId="portal-export-accountant-download"
        />
      </div>
    </Card>
  );
}

function AuditExport() {
  const { t } = useI18n();
  const [period, setPeriod] = useState(lastMonth);
  const ok = periodProblem(period.from, period.to) === null;
  const query = new URLSearchParams({ from: period.from, to: period.to });
  return (
    <Card title={t("exports.audit")} pad testId="portal-export-audit">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">{t("exports.auditHelp")}</p>
        <PeriodFields
          area="portal-export-audit"
          from={period.from}
          to={period.to}
          onFrom={(from) => setPeriod((p) => ({ ...p, from }))}
          onTo={(to) => setPeriod((p) => ({ ...p, to }))}
        />
        <Download
          href={ok ? `/api/audit/export.csv?${query}` : null}
          label={t("exports.downloadCsv")}
          testId="portal-export-audit-download"
        />
      </div>
    </Card>
  );
}
