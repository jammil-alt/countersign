// `/runs/:id`: a run as the client sees it (ARCHITECTURE §10.6): its client-visible steps with
// label, status, time and the one-line summary; the records they cite; who approved what; and the
// changes made in the client's tools. No costs, no instructions, no internal steps: the API sends
// none, and this screen only renders the fields the contract names. Polls while the run is going.
import { pickLocalized } from "@countersign/core";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { connectorName, connectorOf } from "../../inbox/change";
import { SourceLinks } from "../../records/SourceLinks";
import {
  duration,
  isRunGoing,
  runStatusLabel,
  runStatusTone,
  shortTime,
  stepStatusLabel,
} from "../../runs/format";
import { StepMark } from "../../runs/StepMark";
import { usePoll } from "../../runs/usePoll";
import {
  AgentAvatar,
  Badge,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  type Tone,
} from "../../ui/primitives";

const ACTION_WORDS: Record<string, PlainKey> = {
  proposed: "action.status.proposed",
  approved: "action.status.approved",
  executing: "action.status.executing",
  done: "action.status.done",
  rejected: "action.status.rejected",
  failed: "action.status.failed",
};

/** Made = done; waiting = on a person (signal); approved = a person signed (copper); failed = risk. */
const ACTION_TONE: Record<string, Tone> = {
  proposed: "warning",
  approved: "person",
  done: "positive",
  failed: "risk",
};

export function PortalRunScreen() {
  const { id = "" } = useParams();
  const i18n = useI18n();
  const { t, locale } = i18n;
  const time = (iso: string | null) => shortTime(iso, undefined, i18n);
  const { data, error, loading, reload } = useApi(apiRoutes.portalRun, { params: { id } });
  usePoll(reload, data ? isRunGoing(data.run.status) : false, 2_000, loading);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const { run } = data;

  return (
    <div className="max-w-5xl">
      <p className="mb-3 text-sm">
        <Link to="/runs" className="text-link underline">
          {t("nav.runs")}
        </Link>
      </p>
      <PageHeader
        leading={<AgentAvatar name={run.service.name} seed={run.service.id} size="lg" />}
        title={run.service.name}
        badge={
          <Badge tone={runStatusTone(run.status)} testId="portal-run-status">
            {runStatusLabel(run.status, i18n)}
          </Badge>
        }
        subtitle={[
          run.startedAt ? t("run.started", { time: time(run.startedAt) }) : t("run.notStarted"),
          run.finishedAt
            ? t("run.took", {
                duration: duration(run.startedAt, run.finishedAt, undefined, i18n),
              })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section>
          <Card testId="portal-run-timeline" className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="eyebrow text-ink-muted">{t("run.whatHappened")}</h2>
              <span className="text-sm text-ink-muted figures">
                {t("run.stepsDone", {
                  done: data.steps.filter((s) => s.status === "succeeded").length,
                  count: data.steps.length,
                })}
              </span>
            </div>
            {data.steps.length === 0 ? (
              <p className="px-4 py-4 text-ink-muted">{t("run.nothingYet")}</p>
            ) : (
              <ol>
                {data.steps.map((s, i) => (
                  <li
                    key={s.id}
                    data-testid={`portal-run-step-${s.id}`}
                    className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <StepMark status={s.status} n={i + 1} />
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{s.label}</p>
                      <p className="text-sm text-ink">
                        {s.summary ?? stepStatusLabel(s.status, i18n)}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {[time(s.finishedAt ?? s.startedAt), stepStatusLabel(s.status, i18n)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {/* Receipts: the records behind the step, each opening its page. */}
                      <SourceLinks
                        ids={s.sources}
                        href={(id) => `/records/${id}`}
                        testId="portal-run-step-sources"
                      />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </section>
        <section className="flex flex-col gap-6">
          <div>
            <SectionLabel>{t("run.changes")}</SectionLabel>
            {data.actions.length === 0 ? (
              <EmptyState>{t("run.noChanges")}</EmptyState>
            ) : (
              <Card testId="portal-run-actions">
                <ul>
                  {data.actions.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-start justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-ink">
                          {a.display?.connectorName ?? connectorName(connectorOf(a.tool))}
                        </p>
                        <p className="text-sm text-ink">
                          {a.display?.tool?.description
                            ? pickLocalized(a.display.tool.description, locale)
                            : a.description}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge tone={ACTION_TONE[a.status] ?? "neutral"}>
                          {ACTION_WORDS[a.status]
                            ? t(ACTION_WORDS[a.status] as PlainKey)
                            : a.status}
                        </Badge>
                        {a.executedAt ? (
                          <p className="mt-1 text-sm text-ink-muted figures">
                            {time(a.executedAt)}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
          <div>
            <SectionLabel>{t("run.approvals")}</SectionLabel>
            {data.approvals.length === 0 ? (
              <EmptyState>{t("run.noApprovals")}</EmptyState>
            ) : (
              <Card testId="portal-run-approvals">
                <ul>
                  {data.approvals.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-start justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0"
                    >
                      <p className="min-w-0 text-ink">{a.title}</p>
                      {a.status === "open" ? (
                        <Badge tone="warning">{t("common.waiting")}</Badge>
                      ) : (
                        // A person's sign-off is copper; a rejection or expiry stays muted.
                        <p
                          className={cx(
                            "shrink-0 text-right text-sm",
                            a.status !== "expired" && a.approved !== false
                              ? "font-medium text-copper"
                              : "text-ink-muted",
                          )}
                        >
                          {a.status === "expired"
                            ? t("common.expired")
                            : a.by?.name
                              ? t(
                                  a.approved === false
                                    ? "inbox.outcome.rejectedBy"
                                    : "inbox.outcome.approvedBy",
                                  { name: a.by.name },
                                )
                              : t(
                                  a.approved === false
                                    ? "inbox.outcome.rejected"
                                    : "inbox.outcome.approved",
                                )}
                          {a.resolvedAt ? (
                            <span className="font-normal text-ink-muted figures">
                              {` · ${time(a.resolvedAt)}`}
                            </span>
                          ) : null}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {data.approvals.some((a) => a.status === "open") ? (
                  <p className="border-t border-line px-4 py-3 text-sm">
                    <Link to="/inbox" className="text-link underline">
                      {t("run.openInbox")}
                    </Link>
                  </p>
                ) : null}
              </Card>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
