// `/runs/:id` (C10, docs/ui-plan.md): a run as the client sees it (ARCHITECTURE §10.6), titled by
// what it is about (its invoice or its first change). When it waits on the reader, a call to action
// at the top opens the item in the Inbox. Its client-visible steps on a timeline, with their
// summaries, oversight lines and the records they cite; the changes to the client's tools, with
// before and after for those still waiting for approval; who approved; and the run's audit trail
// (who opened it or its items, who approved). No costs, no instructions, no internal steps: the API
// sends none, and this screen renders only the fields the contracts name. Polls while it goes.
// P-4

import { pickLocalized, type RunAuditEntry, shortRunId } from "@countersign/core";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { ChangeTables } from "../../inbox/ChangePanel";
import { changeHeading, connectorName, connectorOf } from "../../inbox/change";
import { SourceLinks } from "../../records/SourceLinks";
// P-6
import { ConversationControls } from "../../runs/ConversationControls";
import { shortTime, stepStatusLabel } from "../../runs/format";
import { subjectTitle } from "../../runs/subject";
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
import { StatusChip } from "../../ui/status";
import { type StepItem, StepList, type StepState } from "../../ui/steps";
import { Transcript } from "../../ui/transcript";
import { PORTAL_PATHS } from "../paths";
import { runChip, runOpen, runState, workedMs } from "../status";
import { msDuration, TookCell } from "./runsParts";

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
  usePoll(reload, data ? runOpen(data.run) : false, 2_000, loading);

  return (
    <Page testId="portal-run-page">
      <Loaded state={state}>{(d) => <RunPage data={d} onChanged={reload} />}</Loaded>
    </Page>
  );
}

type RunData = NonNullable<ReturnType<typeof useApi<typeof apiRoutes.portalRun>>["data"]>;

function RunPage({ data, onChanged }: { data: RunData; onChanged: () => void }) {
  const api = useApiClient();
  const i18n = useI18n();
  const { t, locale } = i18n;
  const time = (iso: string | null) => shortTime(iso, undefined, i18n);
  // P-6: "we" when it was us (portal voice); the client's own people by name.
  type Actor = { us: boolean; name: string | null };
  const editedWords = (by: Actor) =>
    by.us
      ? t("run.conversation.editedByUs")
      : t("run.conversation.editedBy", { who: by.name ?? "" });
  const eventWords = (kind: string, by: Actor) =>
    kind === "taken_over"
      ? by.us
        ? t("run.conversation.takenOverByUs")
        : t("run.conversation.takenOver", { who: by.name ?? "" })
      : by.us
        ? t("run.conversation.endedByUs")
        : t("run.conversation.ended", { who: by.name ?? "" });
  const { run } = data;
  const short = shortRunId(run.id);
  const openApprovals = data.approvals.filter((a) => a.status === "open");
  const [copied, setCopied] = useState(false);
  // What waits on the reader: their own open Inbox items for this run (the Inbox's filter).
  const waits = runState(run) === "waiting" || openApprovals.length > 0;
  const inbox = useApi(apiRoutes.portalInbox, waits ? { query: { status: "open" } } : null);
  const mine = (inbox.data?.items ?? [])
    .filter((i) => i.runId === run.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = mine[0];
  const title = subjectTitle(run.subject, i18n);

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
        {/* P-4: the client's side of a conversation: what was said and when (§1.66). */}
        {s.conversation ? (
          <Transcript
            testId="portal-run-step-conversation"
            lines={[
              ...s.conversation.messages.map((m, k) => ({
                key: `${k}`,
                direction: m.direction,
                who:
                  m.direction === "out" ? t("run.conversation.sent") : t("run.conversation.reply"),
                text: m.text,
                when: m.at ? time(m.at) : null,
                // P-6: changed before it went, and by whom (§1.68).
                meta: m.edited ? editedWords(m.edited.by) : null,
                metaPerson: !!m.edited,
              })),
              // P-6: who took it over or ended it, and why.
              ...(s.conversation.events ?? []).map((e, k) => ({
                key: `event-${k}`,
                direction: "out" as const,
                who: eventWords(e.kind, e.by),
                person: true,
                text: e.reason ?? "",
                when: time(e.at),
              })),
            ]}
          />
        ) : null}
        {s.conversation?.mayControl ? (
          <ConversationControls
            testId="portal-run-step-conversation-control"
            reasonRequired={false}
            words={{
              takeOver: t("run.conversation.takeOver"),
              end: t("run.conversation.end"),
              reason: t("run.conversation.reason"),
              hint: t("run.conversation.controlHint"),
            }}
            onAct={async (action, reason) => {
              await api.call(apiRoutes.portalConversationControl, {
                params: { id: run.id, stepRunId: s.id },
                body: { action, ...(reason ? { reason } : {}) },
              });
              onChanged();
            }}
          />
        ) : null}
        <SourceLinks
          ids={s.sources}
          href={(rid) => `/records/${rid}`}
          testId="portal-run-step-sources"
          names={data.sourceNames}
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
        leading={<AgentBadge name={run.service.name} seed={run.service.id} size="lg" />}
        title={title ?? run.service.name}
        badge={
          <StatusChip state={runChip(run, t).state} testId="portal-run-status">
            {runChip(run, t).label}
          </StatusChip>
        }
        subtitle={[
          title ? run.service.name : null,
          t("runDetail.run", { id: short }),
          run.startedAt ? t("run.started", { time: time(run.startedAt) }) : t("run.notStarted"),
          // QA round 1: the time it worked, without the time it waited on you.
          workedMs(run) !== null
            ? t("run.took", { duration: msDuration(workedMs(run) ?? 0, i18n) })
            : null,
          (run.waitedMs ?? 0) >= 60_000
            ? t("runs.waitedOnYou", { duration: msDuration(run.waitedMs ?? 0, i18n) })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <Button onClick={() => void copyLink()} data-testid="portal-run-copy">
            {copied ? t("common.copied") : t("runDetail.copyLink")}
          </Button>
        }
      />
      {first ? (
        <Card pad testId="portal-run-approve">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-ink">
                {t("runDetail.waitingSince", { time: time(first.createdAt) })}
              </p>
              <p className="text-sm text-ink-muted">
                {t("runDetail.waitingItems", { count: mine.length })}
              </p>
            </div>
            <Link
              to={`${PORTAL_PATHS.desk}?item=${first.id}`}
              className={buttonClass("primary")}
              data-testid="portal-run-review"
            >
              {t("runDetail.review")}
            </Link>
          </div>
        </Card>
      ) : null}
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

        <WaitingChanges items={mine.filter((i) => i.kind === "external_action")} />

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
            <dt>{t("runs.col.took")}</dt>
            <dd className="figures" data-testid="portal-run-took">
              <TookCell run={run} />
            </dd>
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
              end={<StatusChip state={runChip(r, t).state}>{runChip(r, t).label}</StatusChip>}
            >
              {shortTime(r.startedAt, undefined, i18n)}
            </ActivityRow>
          ));
        })()
      )}
    </Card>
  );
}

type InboxItem = NonNullable<
  ReturnType<typeof useApi<typeof apiRoutes.portalInbox>>["data"]
>["items"][number];

/**
 * Changes of this run waiting for the reader's approval, with their before and after: their Inbox
 * items for this run (`GET /api/inbox`), approved in the Inbox.
 */
function WaitingChanges({ items }: { items: InboxItem[] }) {
  const { t, locale } = useI18n();
  const first = items[0];
  if (!first) return null;
  return (
    <Card
      title={t("runDetail.waitingChanges")}
      meta={<StatusChip state="waiting">{t("common.waitingOnYou")}</StatusChip>}
      footer={
        <Link
          to={`${PORTAL_PATHS.desk}?item=${first.id}`}
          className={buttonClass("primary", undefined, "sm")}
        >
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
