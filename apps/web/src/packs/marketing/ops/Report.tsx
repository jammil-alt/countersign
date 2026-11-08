// One weekly report (M47, docs/plan.md §1.77): its summary, what changed with the screens that show
// it, why it probably changed, what the figures can't tell, its three suggested actions each to
// mark Done or Not now (or open again), and the figures it was held to, word for word: every
// number in the report is one of those. The words are the agent's, shown as text, never markup.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApiClient } from "../../../api/useApi";
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import { runMarketingAction, useMarketingItem } from "./api";
import { MarketingLayout, useMarketingClientId } from "./layout";
import { MARKETING_PATHS } from "./paths";
import { weekWords } from "./Reports";

export interface Evidence {
  label: string;
  href: string;
}

export type ActionDecision = "open" | "done" | "not_now";

export interface ReportDetail {
  id: string;
  site: { id: string; domain: string; name: string } | null;
  periodFrom: string;
  periodTo: string;
  searchPeriod: { from: string; to: string } | null;
  createdAt: string | null;
  readAt: string | null;
  readBy: string | null;
  report: {
    summary: string;
    changes: { text: string; evidence: Evidence[] }[];
    causes: { text: string }[];
    unknown: string;
    actions: { text: string; why: string; evidence: Evidence[] }[];
  } | null;
  figures: string[];
  sources: string[];
  runId: string | null;
  actions: {
    id: string;
    idx: number;
    text: string;
    why: string;
    evidence: Evidence[];
    decision: ActionDecision;
    decidedBy: string | null;
    decidedAt: string | null;
  }[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

/** An evidence link: a back-office screen opens here; a page of the site is shown as its path. */
function EvidenceLinks({ evidence, domain }: { evidence: Evidence[]; domain: string | null }) {
  if (evidence.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {evidence.map((e) =>
        e.href.startsWith("/ops/") ? (
          <Link
            key={`${e.label}${e.href}`}
            to={e.href}
            className="text-link hover:underline"
            data-testid="marketing-report-evidence-open"
          >
            {e.label}
          </Link>
        ) : (
          <a
            key={`${e.label}${e.href}`}
            href={domain ? `https://${domain}${e.href}` : e.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-link hover:underline"
          >
            {e.label} ({e.href})
          </a>
        ),
      )}
    </span>
  );
}

function decisionChip(d: ActionDecision) {
  if (d === "done") return <StatusChip state="done">Done</StatusChip>;
  if (d === "not_now") return <StatusChip state="paused">Not now</StatusChip>;
  return <StatusChip state="waiting">Open</StatusChip>;
}

export function MarketingReportScreen() {
  const clientId = useMarketingClientId();
  const { id = "" } = useParams();
  const api = useApiClient();
  const state = useMarketingItem<ReportDetail>(clientId, "reports", id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const data = state.data;
  const run = async (action: string, body: Record<string, unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await runMarketingAction(api, clientId, action, body);
      state.reload();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const domain = data?.site?.domain ?? null;
  return (
    <MarketingLayout
      title={data ? `Week of ${weekWords(data.periodFrom, data.periodTo)}` : "Weekly report"}
      subtitle={
        data?.searchPeriod
          ? `Search figures ${weekWords(data.searchPeriod.from, data.searchPeriod.to)}, as far as the search data runs.`
          : undefined
      }
      testId="marketing-report"
      actions={
        <Link to={MARKETING_PATHS.reports(clientId)} className="text-link hover:underline">
          All reports
        </Link>
      }
    >
      {state.loading && !data ? <Loading /> : null}
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {problem ? (
        <p className="text-sm ui-tone-risk" role="alert">
          {problem}
        </p>
      ) : null}
      {data && !data.report ? (
        <EmptyState testId="marketing-report-unreadable">
          This report can't be shown: its words weren't kept in the form we read.
        </EmptyState>
      ) : null}
      {data?.report ? (
        <div className="flex flex-col gap-6">
          <Card testId="marketing-report-summary" pad>
            <div className="flex flex-col gap-2">
              <p className="text-ink">{data.report.summary}</p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                {data.readAt ? (
                  <span data-testid="marketing-report-read">
                    Read by {data.readBy ?? "someone"}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => run("mark-report-read", { reportId: data.id })}
                    data-testid="marketing-report-read-mark"
                  >
                    Mark as read
                  </Button>
                )}
              </div>
            </div>
          </Card>

          <section data-testid="marketing-report-changes">
            <SectionLabel>What changed</SectionLabel>
            <ul className="flex flex-col gap-2">
              {data.report.changes.map((c) => (
                <li key={c.text} className="flex flex-col gap-1">
                  <span className="text-ink">{c.text}</span>
                  <EvidenceLinks evidence={c.evidence} domain={domain} />
                </li>
              ))}
            </ul>
          </section>

          {data.report.causes.length > 0 ? (
            <section data-testid="marketing-report-causes">
              <SectionLabel>Why it probably changed</SectionLabel>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {data.report.causes.map((c) => (
                  <li key={c.text} className="text-ink">
                    {c.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section data-testid="marketing-report-unknown">
            <SectionLabel>What we can't know</SectionLabel>
            <p className="text-ink">{data.report.unknown}</p>
          </section>

          <section data-testid="marketing-report-actions">
            <SectionLabel>Three suggested actions</SectionLabel>
            <ol className="flex flex-col gap-3">
              {data.actions.map((a) => (
                <li key={a.id}>
                  <Card testId="marketing-report-action" pad>
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="font-medium text-ink">{a.text}</span>
                        {decisionChip(a.decision)}
                      </div>
                      {a.why ? <p className="text-ink-muted">{a.why}</p> : null}
                      <EvidenceLinks evidence={a.evidence} domain={domain} />
                      <div className="flex flex-wrap items-center gap-2">
                        {a.decision === "open" ? (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy}
                              onClick={() =>
                                run("decide-report-action", {
                                  reportId: data.id,
                                  idx: a.idx,
                                  decision: "done",
                                })
                              }
                              data-testid="marketing-report-action-done"
                            >
                              Done
                            </Button>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                run("decide-report-action", {
                                  reportId: data.id,
                                  idx: a.idx,
                                  decision: "not_now",
                                })
                              }
                              data-testid="marketing-report-action-not-now"
                            >
                              Not now
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="text-sm text-ink-muted">
                              {a.decidedBy ? `By ${a.decidedBy}` : null}
                            </span>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                run("decide-report-action", {
                                  reportId: data.id,
                                  idx: a.idx,
                                  decision: "open",
                                })
                              }
                              data-testid="marketing-report-action-reopen"
                            >
                              Open again
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ol>
          </section>

          <details data-testid="marketing-report-figures">
            <summary className="cursor-pointer text-ink">
              The figures this report was held to
            </summary>
            <p className="mt-2 text-sm text-ink-muted">
              Every number in the report is one of these, as written here.
            </p>
            <ul className="mt-2 flex flex-col gap-0.5 font-mono text-sm text-ink">
              {data.figures.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat (e.g. headings) and never reorder.
                <li key={i} className="break-words">
                  {f}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </MarketingLayout>
  );
}
