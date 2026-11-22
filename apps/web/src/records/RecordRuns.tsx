// R3: from a record to its runs (docs/reporting-plan.md §3 R3, docs/plan.md §1.200). The Runs
// panel on a record's page in both surfaces (a transaction, a vendor, a raw record, a document,
// and a person or organization in the directory): the runs about it, newest first, each with what
// it did with the record ("Read", "Matched", "Changed in QuickBooks") and the step's line. The
// portal's answer holds only what its timeline shows (the API reads it so). Words come from the
// portal's message files (English in the back office); a step's line stays as the run wrote it.
import { type RecordRun, type RecordRunRole, shortRunId } from "@countersign/core";
import { Link } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import type { I18n } from "../i18n/i18n";
import { useI18n } from "../i18n/i18n";
import { runChip } from "../portal/status";
import { shortTime } from "../runs/format";
import { connectorLabel } from "../runs/labels";
import { subjectTitle } from "../runs/subject";
import { Badge, Card, cx, EmptyState, ErrorNotice, Loading, SectionLabel } from "../ui/primitives";
import { StatusChip } from "../ui/status";

/** Which surface asks: the portal (its own client) or the back office (one served client). */
export type RecordRunsSource = { surface: "portal" } | { surface: "ops"; clientId: string };

/** What a run did with the record, in the reader's words: "Changed in QuickBooks". */
export function roleWords(r: Pick<RecordRunRole, "role" | "connector">, { t }: Pick<I18n, "t">) {
  switch (r.role) {
    case "read":
      return t("record.runs.role.read");
    // DECISION: a decision about a record reads "Matched", the plan's word for it: an agent
    // decides on a record by matching it (a vendor, a PO, a bill) (docs/plan.md §1.200).
    case "decided":
      return t("record.runs.role.decided");
    case "changed":
      return r.connector
        ? t("record.runs.role.changedIn", { tool: connectorLabel(r.connector) })
        : t("record.runs.role.changed");
  }
}

export function RecordRuns({
  source,
  recordId,
  runHref,
  testId = "record-runs",
}: {
  source: RecordRunsSource;
  recordId: string;
  /** A run's page in this surface. */
  runHref(id: string): string;
  testId?: string;
}) {
  const { t } = useI18n();
  const portal = useApi(
    apiRoutes.portalRecordRuns,
    source.surface === "portal" ? { params: { id: recordId } } : null,
  );
  const ops = useApi(
    apiRoutes.opsClientRecordRuns,
    source.surface === "ops" ? { params: { id: source.clientId, recordId } } : null,
  );
  const { data, error, loading, reload } = source.surface === "portal" ? portal : ops;
  return (
    <section className="mt-6" data-testid={testId}>
      <SectionLabel>{t("record.runs")}</SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.runs.length === 0 ? (
        <EmptyState>
          <span data-testid={`${testId}-empty`}>{t("record.runs.empty")}</span>
        </EmptyState>
      ) : null}
      {data && data.runs.length > 0 ? (
        <Card>
          <ul>
            {data.runs.map((r) => (
              <RunLine key={r.id} run={r} href={runHref(r.id)} testId={`${testId}-${r.id}`} />
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}

function RunLine({ run, href, testId }: { run: RecordRun; href: string; testId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const title = subjectTitle(run.subject, i18n);
  const chip = runChip(run, t);
  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0" data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <Link
            to={href}
            className={cx("font-medium text-ink hover:underline", !title && "font-mono text-sm")}
          >
            {title ?? shortRunId(run.id)}
          </Link>
          <span className="ml-2 text-sm text-ink-muted">
            {[run.service.name, run.startedAt ? shortTime(run.startedAt, undefined, i18n) : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* The back office only: a test run is listed too. */}
          {run.mode === "test" ? <Badge tone="neutral">Test run</Badge> : null}
          <StatusChip state={chip.state}>{chip.label}</StatusChip>
        </div>
      </div>
      {run.roles.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-sm" data-testid={`${testId}-roles`}>
          {run.roles.map((r, i) => (
            // Roles repeat across steps; their order is the run's.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is the run's, never reordered.
            <li key={i}>
              <span className="text-ink">{roleWords(r, i18n)}</span>
              {r.summary ? <span className="text-ink-muted"> · {r.summary}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
