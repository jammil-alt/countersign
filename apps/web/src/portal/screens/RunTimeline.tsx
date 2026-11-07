// `/runs/:id` (C10, docs/ui-plan.md): a run as the client sees it (ARCHITECTURE §10.6): its
// client-visible steps on a timeline, with their summaries, oversight lines and the records they
// cite; the changes to the client's tools, with before and after for those still waiting on a
// signature; who signed; and the run's audit trail (who opened it or its items, who signed). No
// costs, no instructions, no internal steps: the API sends none, and this screen renders only the
// fields the contracts name. Polls while the run is going.
import { pickLocalized, type RunAuditEntry, shortRunId } from "@countersign/core";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { ChangeTables } from "../../inbox/ChangePanel";
import { changeHeading, connectorName, connectorOf } from "../../inbox/change";
import { SourceLinks } from "../../records/SourceLinks";
import { duration, isRunGoing, shortTime, stepStatusLabel } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { ActivityRow } from "../../ui/activity";
import { AgentBadge } from "../../ui/badges";
import { Loaded, Page, PageGrid } from "../../ui/page";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  type Tone,
} from "../../ui/primitives";
import { runChipState, StatusChip } from "../../ui/status";
import { type StepItem, StepList, type StepState } from "../../ui/steps";
import { PORTAL_PATHS } from "../paths";
import { runWords } from "./Runs";

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

const AUDIT_WORDS: Record<RunAuditEntry["kind"], PlainKey> = {
  opened_run: "runDetail.audit.opened_run",
  item_edit: "runDetail.audit.item_edit",
  item_snooze: "runDetail.audit.item_snooze",
  item_undo: "runDetail.audit.item_undo",
  signed: "runDetail.audit.signed",
  declined: "runDetail.audit.declined",
  answered: "runDetail.audit.answered",
};

/** A step's status as the timeline's mark. */
function stepState(status: string): StepState {
  switch (status) {
    case "succeeded":
      return "done";
    case "running":
      return "current";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return "todo";
  }
}

export function PortalRunScreen() {
  const { id = "" } = useParams();
  const state = useApi(apiRoutes.portalRun, { params: { id } });
  const { data, loading, reload } = state;
  usePoll(reload, data ? isRunGoing(data.run.status) : false, 2_000, loading);

  return (
    <Page testId="portal-run-page">
      <Loaded state={state}>{(d) => <RunPage data={d} />}</Loaded>
    </Page>
  );
}

type RunData = NonNullable<ReturnType<typeof useApi<typeof apiRoutes.portalRun>>["data"]>;

function RunPage({ data }: { data: RunData }) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const time = (iso: string | null) => shortTime(iso, undefined, i18n);
  const { run } = data;
  const short = shortRunId(run.id);
  const openApprovals = data.approvals.filter((a) => a.status === "open");
  const [copied, setCopied] = useState(false);

  const steps: StepItem[] = data.steps.map((s) => ({
    key: s.id,
    state: stepState(s.status),
    time: s.startedAt ? time(s.startedAt) : "",
    title: s.label,
    detail: s.summary ?? stepStatusLabel(s.status, i18n),
    children: (
      <>
        {s.oversight && s.oversight.length > 0 ? (
          <ul className="text-sm text-ink-muted" data-testid="portal-run-step-oversight">
            {s.oversight.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <SourceLinks
          ids={s.sources}
          href={(rid) => `/records/${rid}`}
          testId="portal-run-step-sources"
        />
      </>
    ),
  }));

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <p className="eyebrow text-ink-muted">
        <Link to={PORTAL_PATHS.runs} className="text-link hover:underline">
          {t("nav.runs")}
        </Link>
        {` / ${short}`}
      </p>
      <PageHeader
        leading={<AgentBadge name={run.service.name} size="lg" />}
        title={run.service.name}
        badge={
          <StatusChip state={runChipState(run.status)} testId="portal-run-status">
            {runWords(run.status, t)}
          </StatusChip>
        }
        subtitle={[
          t("runDetail.run", { id: short }),
          run.startedAt ? t("run.started", { time: time(run.startedAt) }) : t("run.notStarted"),
          run.finishedAt
            ? t("run.took", { duration: duration(run.startedAt, run.finishedAt, undefined, i18n) })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Button onClick={() => void copyLink()} data-testid="portal-run-copy">
              {copied ? t("common.copied") : t("runDetail.copyLink")}
            </Button>
            {openApprovals.length > 0 ? (
              <Link
                to={PORTAL_PATHS.desk}
                className={buttonClass("primary")}
                data-testid="portal-run-review"
              >
                {t("runDetail.review")}
              </Link>
            ) : null}
          </>
        }
      />
      <PageGrid
        rail={
          <>
            <AboutRun data={data} />
            <OtherRuns serviceId={run.service.id} name={run.service.name} current={run.id} />
            <Card pad testId="portal-run-ask-sloan">
              <p className="text-sm text-ink-muted">{t("runDetail.askSloan.prompt")}</p>
              <Link
                to={`${PORTAL_PATHS.sloan}?ask=${encodeURIComponent(t("runDetail.askSloan.text", { id: short }))}`}
                className={cx(buttonClass("secondary", undefined, "sm"), "mt-3")}
              >
                {t("runDetail.askSloan")}
              </Link>
            </Card>
          </>
        }
      >
        <Card
          title={t("run.whatHappened")}
          meta={
            <span className="figures">
              {t("run.stepsDone", {
                done: data.steps.filter((s) => s.status === "succeeded").length,
                count: data.steps.length,
              })}
            </span>
          }
          testId="portal-run-timeline"
        >
          {data.steps.length === 0 ? (
            <p className="ui-card__body text-ink-muted">{t("run.nothingYet")}</p>
          ) : (
            <div className="ui-card__body">
              <StepList steps={steps} />
            </div>
          )}
        </Card>

        <WaitingChanges runId={run.id} open={openApprovals.length > 0} />

        <Card title={t("run.changes")} meta={data.actions.length || null}>
          {data.actions.length === 0 ? (
            <p className="ui-card__body text-ink-muted">{t("run.noChanges")}</p>
          ) : (
            <div data-testid="portal-run-actions">
              {data.actions.map((a) => (
                <ActivityRow
                  key={a.id}
                  time={a.executedAt ? time(a.executedAt) : undefined}
                  end={
                    <Badge tone={ACTION_TONE[a.status] ?? "neutral"}>
                      {ACTION_WORDS[a.status] ? t(ACTION_WORDS[a.status] as PlainKey) : a.status}
                    </Badge>
                  }
                >
                  <span className="font-medium">
                    {a.display?.connectorName ?? connectorName(connectorOf(a.tool))}
                  </span>
                  <span className="block text-sm text-ink-muted">
                    {a.display?.tool?.description
                      ? pickLocalized(a.display.tool.description, locale)
                      : a.description}
                  </span>
                </ActivityRow>
              ))}
            </div>
          )}
        </Card>

        <Card title={t("run.approvals")}>
          {data.approvals.length === 0 ? (
            <p className="ui-card__body text-ink-muted">{t("run.noApprovals")}</p>
          ) : (
            <div data-testid="portal-run-approvals">
              {data.approvals.map((a) => (
                <ActivityRow
                  key={a.id}
                  end={
                    a.status === "open" ? (
                      <StatusChip state="waiting">{t("common.waitingOnYou")}</StatusChip>
                    ) : (
                      // A person's sign-off is copper; a rejection or expiry stays muted.
                      <span
                        className={cx(
                          "text-right text-sm",
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
                      </span>
                    )
                  }
                >
                  {a.title}
                </ActivityRow>
              ))}
            </div>
          )}
        </Card>

        <AuditTrail runId={run.id} />
      </PageGrid>
    </>
  );
}

/** About this run: the facts the run's own answer holds. */
function AboutRun({ data }: { data: RunData }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { run } = data;
  const open = data.approvals.filter((a) => a.status === "open").length;
  const made = data.actions.filter((a) => a.status === "done").length;
  return (
    <Card title={t("runDetail.about")} testId="portal-run-about">
      <dl className="ui-facts ui-card__body">
        <dt>{t("runsPage.col.agent")}</dt>
        <dd>{run.service.name}</dd>
        <dt>{t("runs.col.started")}</dt>
        <dd className="figures">
          {run.startedAt ? shortTime(run.startedAt, undefined, i18n) : t("run.notStarted")}
        </dd>
        {run.startedAt ? (
          <>
            <dt>{run.finishedAt ? t("runs.col.took") : t("runDetail.runningFor")}</dt>
            <dd className="figures">{duration(run.startedAt, run.finishedAt, undefined, i18n)}</dd>
          </>
        ) : null}
        <dt>{t("runDetail.changes")}</dt>
        <dd>{t("runDetail.changesLine", { made, count: data.actions.length })}</dd>
        <dt>{t("runDetail.waiting")}</dt>
        <dd>
          {open > 0 ? (
            <StatusChip state="waiting">{t("runDetail.waitingCount", { count: open })}</StatusChip>
          ) : (
            t("runDetail.nothingWaiting")
          )}
        </dd>
      </dl>
    </Card>
  );
}

/** The agent's other runs, newest first. */
function OtherRuns({
  serviceId,
  name,
  current,
}: {
  serviceId: string;
  name: string;
  current: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const state = useApi(apiRoutes.portalRuns, { query: { agents: serviceId, limit: 6 } });
  return (
    <Card
      title={t("runDetail.otherRuns", { name })}
      meta={
        <Link to={PORTAL_PATHS.runs} className="text-link hover:underline">
          {t("runDetail.allRuns")}
        </Link>
      }
      testId="portal-run-other"
    >
      {state.error ? (
        <div className="ui-card__body">
          <ErrorNotice error={state.error} onRetry={state.reload} />
        </div>
      ) : !state.data ? (
        <div className="ui-card__body">
          <Loading />
        </div>
      ) : (
        (() => {
          const others = state.data.runs.filter((r) => r.id !== current).slice(0, 5);
          if (others.length === 0) {
            return <p className="ui-card__body text-sm text-ink-muted">{t("runDetail.noOther")}</p>;
          }
          return others.map((r) => (
            <ActivityRow
              key={r.id}
              time={<span className="font-mono">{shortRunId(r.id)}</span>}
              to={`${PORTAL_PATHS.runs}/${r.id}`}
              end={<StatusChip state={runChipState(r.status)}>{runWords(r.status, t)}</StatusChip>}
            >
              {shortTime(r.startedAt, undefined, i18n)}
            </ActivityRow>
          ));
        })()
      )}
    </Card>
  );
}

/**
 * Changes of this run still waiting on a signature, with their before and after: the Desk's items
 * for this run (`GET /api/inbox`), signed on the Desk.
 */
function WaitingChanges({ runId, open }: { runId: string; open: boolean }) {
  const { t, locale } = useI18n();
  const state = useApi(apiRoutes.portalInbox, open ? { query: { status: "open" } } : null);
  const items = (state.data?.items ?? []).filter(
    (i) => i.runId === runId && i.kind === "external_action",
  );
  if (!open || items.length === 0) return null;
  return (
    <Card
      title={t("runDetail.waitingChanges")}
      meta={<StatusChip state="waiting">{t("common.waitingOnYou")}</StatusChip>}
      footer={
        <Link to={PORTAL_PATHS.desk} className={buttonClass("primary", undefined, "sm")}>
          {t("runDetail.review")}
        </Link>
      }
      testId="portal-run-waiting"
    >
      {items.map((item) => {
        const tool = typeof item.payload.tool === "string" ? item.payload.tool : "";
        const heading = changeHeading(
          item.display,
          tool,
          item.payload.before,
          item.payload.input,
          locale,
        );
        return (
          <div
            key={item.id}
            className="ui-card__body flex flex-col gap-3 border-b border-line last:border-b-0"
          >
            <div>
              <p className="font-medium text-ink">{heading.title}</p>
              {heading.description ? (
                <p className="text-sm text-ink-muted">{heading.description}</p>
              ) : null}
            </div>
            <ChangeTables
              before={item.payload.before}
              input={item.payload.input}
              display={item.display?.tool ?? null}
              names={item.display?.names}
            />
          </div>
        );
      })}
    </Card>
  );
}

/** Who saw or did what, in order. Our people read as Mezonas, the lead by name (copper). */
function AuditTrail({ runId }: { runId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const state = useApi(apiRoutes.portalRunAudit, { params: { id: runId } });
  return (
    <Card title={t("runDetail.audit")} meta={t("runDetail.audit.meta")} testId="portal-run-audit">
      {state.error ? (
        <div className="ui-card__body">
          <ErrorNotice error={state.error} onRetry={state.reload} />
        </div>
      ) : !state.data ? (
        <div className="ui-card__body">
          <Loading />
        </div>
      ) : state.data.entries.length === 0 ? (
        <div className="ui-card__body">
          <EmptyState>{t("runDetail.audit.empty")}</EmptyState>
        </div>
      ) : (
        state.data.entries.map((e, i) => (
          <ActivityRow
            // biome-ignore lint/suspicious/noArrayIndexKey: entries are in order and never move.
            key={i}
            time={shortTime(e.at, undefined, i18n)}
            end={
              e.times > 1 ? (
                <span className="text-sm text-ink-muted figures">
                  {t("runDetail.audit.times", { count: e.times })}
                </span>
              ) : undefined
            }
          >
            <span className={cx("font-medium", e.side === "mezonas" && "text-copper")}>
              {e.who}
            </span>{" "}
            {t(AUDIT_WORDS[e.kind])}
          </ActivityRow>
        ))
      )}
    </Card>
  );
}
