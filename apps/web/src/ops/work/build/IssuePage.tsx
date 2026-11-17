// An issue (docs/plan.md §1.123.1; docs/design/pipelines.html `record()`): the safety hold with
// what waits, the stage stepper, the conversation with the client (replies, internal notes and a
// question on their Desk), its history, and beside it the to-dos, Reggie's read and plan, and the
// details. Notes stay in the back office; the client reads only replies.
import {
  type IssueDetail,
  PIPELINES,
  TARGET_WORDS,
  WORK_WORDS,
  type WorkCauseKind,
  type WorkIssueStage,
  type WorkUrgency,
} from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Page } from "../../../ui/page";
import { Button, Loading } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";
import { Due, StandingPill, shortDate, TodoLine, UrgencyPill } from "../parts";

type Tab = "reply" | "note" | "desk";

const CAUSE_WORDS: Record<WorkCauseKind, string> = {
  setup: "Set-up",
  data: "Data",
  agent: "The agent",
  platform: "Our platform",
  not_a_bug: "Not a bug",
};

const EVENT_WORDS: Record<string, (from: string | null, to: string | null) => string> = {
  created: () => "Opened.",
  stage: (_f, t) => `Moved to ${PIPELINES.issues.stages.find((s) => s.id === t)?.name ?? t}.`,
  urgency: (f, t) => `Urgency ${f} to ${t}.`,
  cause: (_f, t) => `Cause: ${t ? (CAUSE_WORDS[t as WorkCauseKind] ?? t) : "not set"}.`,
  hold: () => "Safety hold placed on the agent.",
  release: () => "Safety hold released.",
  rollback: () => "Rolled the agent back.",
  reply: () => "Replied to the client.",
  note: () => "Added an internal note.",
  link: () => "Linked a record.",
  reggie_read: () => "Reggie read it.",
  assign: () => "Changed the agent it's about.",
  close: () => "Closed.",
  reopen: () => "Opened again.",
  converted: () => "Not a fault: made an ask.",
  moved: () => "Moved in the work order.",
};

export function IssuePage() {
  const { id = "" } = useParams();
  const state = useApi(apiRoutes.opsIssue, { params: { id } });
  return (
    <Page testId="ops-issue">
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {state.loading && !state.data ? <Loading /> : null}
      {state.data ? <IssueView detail={state.data} reload={state.reload} /> : null}
    </Page>
  );
}

function IssueView({ detail, reload }: { detail: IssueDetail; reload: () => void }) {
  const api = useApiClient();
  const navigate = useNavigate();
  const { issue, hold } = detail;
  const [tab, setTab] = useState<Tab>("reply");
  const [text, setText] = useState(issue.reggieRead?.draft?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const stages = PIPELINES.issues.stages;
  const idx = stages.findIndex((s) => s.id === issue.stage);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    run(async () => {
      if (tab === "desk") {
        await api.call(apiRoutes.opsLeadRequestCreate, {
          params: { id: issue.client.id },
          body: { question: text.slice(0, 300) },
        });
      } else {
        await api.call(apiRoutes.opsIssueMessage, {
          params: { id: issue.id },
          body: { text, audience: tab === "reply" ? "client" : "operator" },
        });
      }
      setText("");
    });
  const move = (stage: WorkIssueStage) =>
    run(() =>
      api.call(apiRoutes.opsUpdateIssue, {
        params: { id: issue.id },
        body: { stage: stage as "reported" },
      }),
    );
  const setUrgency = (urgency: WorkUrgency) => {
    const reason = window.prompt("Why does the urgency change?");
    if (!reason) return;
    void run(() =>
      api.call(apiRoutes.opsUpdateIssue, { params: { id: issue.id }, body: { urgency, reason } }),
    );
  };
  const close = () => {
    const note = window.prompt("What fixed it? The client reads this.") ?? undefined;
    void run(() =>
      api.call(apiRoutes.opsCloseIssue, { params: { id: issue.id }, body: note ? { note } : {} }),
    );
  };
  const release = () => {
    if (!hold) return;
    const reason = window.prompt("Why is it safe to release the hold?");
    if (!reason) return;
    void run(() =>
      api.call(apiRoutes.opsReleaseAgent, { params: { id: hold.agent.id }, body: { reason } }),
    );
  };
  const convert = () =>
    run(async () => {
      await api.call(apiRoutes.opsConvertIssue, { params: { id: issue.id }, body: { to: "ask" } });
      navigate(OPS_PATHS.buildTab("enh"));
    });
  const timeline = [
    ...detail.messages.map((m) => ({ at: m.at, key: m.id, m })),
    ...detail.events
      .filter((e) => e.kind !== "reply" && e.kind !== "note")
      .map((e) => ({ at: e.at, key: e.id, e })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const read = issue.reggieRead;
  return (
    <>
      {hold ? (
        <div className="mz-hold mb-4" data-testid="issue-hold">
          <span>
            <b>Safety hold on since {shortDate(hold.since)}.</b> {WORK_WORDS.hold.detail}{" "}
            {hold.held.writes} write
            {hold.held.writes === 1 ? "" : "s"} and {hold.held.messages} message
            {hold.held.messages === 1 ? "" : "s"} held.
          </span>
          <span className="flex flex-wrap gap-2">
            <Link
              className="ds-btn ds-btn--secondary ds-btn--sm"
              to={OPS_PATHS.client(issue.client.id)}
            >
              {WORK_WORDS.hold.review}
            </Link>
            <Link
              className="ds-btn ds-btn--secondary ds-btn--sm"
              to={OPS_PATHS.client(issue.client.id)}
            >
              {WORK_WORDS.hold.rollBack}
            </Link>
            <Button
              variant="primary"
              size="sm"
              onClick={release}
              disabled={busy}
              data-testid="issue-release"
            >
              {WORK_WORDS.hold.release}
            </Button>
          </span>
        </div>
      ) : null}
      <div className="ui-crumbs mb-2 text-sm">
        <Link to={OPS_PATHS.buildWork}>Build</Link> ›{" "}
        <Link to={OPS_PATHS.buildTab("issues")}>Issues</Link> ›{" "}
        <Link to={OPS_PATHS.client(issue.client.id)}>{issue.client.name}</Link>
      </div>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="type-title text-ink">
            #{issue.number} {issue.title}
          </h1>
          {issue.description ? <p className="mt-1 text-ink-muted">{issue.description}</p> : null}
          <p className="mt-1 flex flex-wrap gap-3 text-sm text-ink-muted">
            <Link to={OPS_PATHS.client(issue.client.id)}>{issue.client.name}</Link>
            <span>
              Fix by <Due iso={issue.fixBy} done={issue.standing === "done"} />
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <UrgencyPill urgency={issue.urgency} />
          <StandingPill standing={issue.standing} line={issue.statusLine} />
          {issue.stage === "closed" ? (
            <Button
              size="sm"
              onClick={() =>
                void run(() => api.call(apiRoutes.opsReopenIssue, { params: { id: issue.id } }))
              }
            >
              Reopen
            </Button>
          ) : (
            <Button size="sm" onClick={close} disabled={busy} data-testid="issue-close">
              Close
            </Button>
          )}
        </div>
      </header>
      {error ? <ErrorNotice error={error} /> : null}
      <fieldset className="stages m-0 mb-4 flex flex-wrap gap-1 border-0 p-0" aria-label="Stage">
        {stages.map((s, n) => (
          <button
            key={s.id}
            type="button"
            className={`ds-btn ds-btn--sm ${n === idx ? "ds-btn--primary" : "ds-btn--ghost"}`}
            aria-current={n === idx ? "step" : undefined}
            disabled={busy || s.id === "closed" || issue.stage === "closed"}
            onClick={() => void move(s.id as WorkIssueStage)}
          >
            {s.name}
          </button>
        ))}
      </fieldset>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="ds-card p-4" data-testid="issue-composer">
            <div className="ds-tabs mb-2" role="tablist">
              {(
                [
                  ["reply", "Reply to the client"],
                  ["note", "Internal note"],
                  ["desk", "Ask on their Desk"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <textarea
              className="ds-textarea w-full"
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Message"
              data-testid="issue-compose"
            />
            {read?.draft && tab === "reply" ? (
              <div className="ds-aiblock mt-2">
                <span className="ds-ai">
                  <i />
                  Reggie drafted this
                </span>
              </div>
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-ink-muted">
                {tab === "note"
                  ? "Only the back office sees notes."
                  : "Goes on the timeline as activity."}
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !text.trim()}
                onClick={() => void send()}
                data-testid="issue-send"
              >
                {tab === "note" ? "Add note" : "Send"}
              </Button>
            </div>
          </section>
          <ol className="flex flex-col gap-3" data-testid="issue-timeline">
            {timeline.map((t) =>
              "m" in t && t.m ? (
                <li
                  key={t.key}
                  className={`ds-card p-3 ${t.m.audience === "operator" ? "border-l-2 border-copper" : ""}`}
                  data-testid={t.m.audience === "operator" ? "issue-note" : "issue-message"}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <b>{t.m.who.name}</b>
                    {t.m.audience === "operator" ? (
                      <span className="ds-pill ds-pill--person ds-pill--sm">Internal note</span>
                    ) : null}
                    <span className="text-ink-muted">{shortDate(t.m.at)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap">{t.m.text}</p>
                </li>
              ) : "e" in t && t.e ? (
                <li key={t.key} className="text-sm text-ink-muted">
                  {(EVENT_WORDS[t.e.kind] ?? (() => t.e.kind))(t.e.from, t.e.to)}{" "}
                  {t.e.who ? `${t.e.who} · ` : ""}
                  {shortDate(t.e.at)}
                  {t.e.reason ? ` · ${t.e.reason}` : ""}
                </li>
              ) : null,
            )}
          </ol>
        </div>
        <aside className="flex flex-col gap-4">
          <section className="ds-card p-4" data-testid="issue-todos">
            <div className="eyebrow mb-2 text-ink-muted">To-dos on this issue</div>
            {detail.todos.length ? (
              detail.todos.map((t) => (
                <TodoLine key={t.id} title={t.title} owner={t.owner} due={t.dueAt} />
              ))
            ) : (
              <p className="text-sm text-ink-muted">None open.</p>
            )}
          </section>
          <section className="ds-card p-4" data-testid="issue-read">
            <div className="mb-2">
              <span className="ds-ai">
                <i />
                Reggie's read
              </span>
            </div>
            {read ? (
              <>
                <p className="text-sm">{read.read}</p>
                {read.found.length ? (
                  <ul className="found mt-2 list-disc pl-5 text-sm">
                    {read.found.map((f) => (
                      <li key={f.text}>{f.text}</li>
                    ))}
                  </ul>
                ) : null}
                {read.plan.length ? (
                  <>
                    <div className="eyebrow mt-3 text-ink-muted">Plan</div>
                    <ol className="mt-1 flex flex-col gap-1 text-sm">
                      {read.plan.map((p, n) => (
                        <li key={p.text}>
                          {n + 1}. {p.text} <small className="text-ink-muted">{p.detail}</small>{" "}
                          {p.mode === "approve" ? (
                            <span className="ds-pill ds-pill--warning ds-pill--sm">Yours</span>
                          ) : p.mode === "draft" ? (
                            <span className="ds-pill ds-pill--neutral ds-pill--sm">Drafted</span>
                          ) : (
                            <span className="mz-agentline">Reggie</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : null}
                {read.sure ? <p className="mt-2 text-xs text-ink-muted">{read.sure}</p> : null}
              </>
            ) : (
              <p className="text-sm text-ink-muted">{WORK_WORDS.readNotYet}</p>
            )}
          </section>
          <section className="ds-card p-4" data-testid="issue-details">
            <div className="eyebrow mb-2 text-ink-muted">Details</div>
            <dl className="facts grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt>Client</dt>
              <dd>{issue.client.name}</dd>
              <dt>Agent</dt>
              <dd>{issue.agent?.name ?? "None named"}</dd>
              <dt>Urgency</dt>
              <dd>
                <select
                  aria-label="Urgency"
                  value={issue.urgency}
                  onChange={(e) => setUrgency(e.target.value as WorkUrgency)}
                  disabled={busy || issue.stage === "closed"}
                >
                  {(["critical", "high", "normal", "low"] as const).map((u) => (
                    <option key={u} value={u}>
                      {u[0]?.toUpperCase()}
                      {u.slice(1)}
                    </option>
                  ))}
                </select>
              </dd>
              <dt>Hold</dt>
              <dd>
                {hold
                  ? `On since ${shortDate(hold.since)}, by ${hold.by === "reggie" ? "Reggie" : "you"}`
                  : "None"}
              </dd>
              <dt>Raised by</dt>
              <dd>{issue.raisedBy?.name ?? "Mezonas"}</dd>
              <dt>First reply</dt>
              <dd>{issue.firstReplyAt ? shortDate(issue.firstReplyAt) : "Not yet"}</dd>
              <dt>Fix target</dt>
              <dd>{TARGET_WORDS[issue.urgency].fix}</dd>
              <dt>Cause</dt>
              <dd>{issue.causeKind ? CAUSE_WORDS[issue.causeKind] : "Not found yet"}</dd>
            </dl>
            {issue.stage !== "closed" ? (
              <Button size="sm" className="mt-3" onClick={() => void convert()} disabled={busy}>
                It isn't a fault: make it an ask
              </Button>
            ) : null}
          </section>
        </aside>
      </div>
    </>
  );
}
