// `/ops/runs/:id`, O10 Run detail (docs/design/prototype.html `#O10-RunDetail`; ARCHITECTURE §10.5,
// §10.10, §10.11): the full view of one run. Timeline (each step with its time, cost, tokens and
// models, a failed step with its tool calls), Changes (now / after this change for each action,
// approve or reject where one waits on us), Model calls (with request and answer), Oversight (the
// run oversight's decisions) and Raw (trigger, inputs, outputs, tool calls). Beside it: about this
// run and the same error elsewhere. Retry, cancel and replay. Polls every 2 s while the run is going.
import { errorGroupKey, runErrorCode, runStartedBy, shortRunId, Workflow } from "@countersign/core";
import { type ReactNode, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ChangeTables } from "../../inbox/ChangePanel";
import { changeHeading } from "../../inbox/change";
import { InboxCard, type ResolveInput } from "../../inbox/InboxCard";
import { SourceLinks, sourcesOf } from "../../records/SourceLinks";
import { duration, isRunGoing, shortTime, stepStatusLabel, usd } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { BeforeAfter } from "../../ui/activity";
import { AgentBadge } from "../../ui/badges";
import { Loaded, Page, PageGrid } from "../../ui/page";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tag,
  type Tone,
} from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { type StepItem, StepList, type StepState } from "../../ui/steps";
import { checklistRows, type RunStepRow } from "../run/checklist";
import { ModelCalls, RunControls } from "../run/RunControls";
import {
  OVERSIGHT_ACTION_WORDS,
  OVERSIGHT_CAUSE_WORDS,
  oversightLine,
  plural,
  runChip,
  runErrorParts,
} from "../run/words";
import { type StepNames, stepNames } from "../workflow/describe";
import { operatorMayResolve } from "./Inbox";

type RunDetail = ResponseOf<typeof apiRoutes.opsRun>;
type Action = RunDetail["actions"][number];
type Item = RunDetail["inbox"][number];
type Decision = NonNullable<RunDetail["oversight"]>[number];

const TABS = ["timeline", "changes", "calls", "oversight", "raw"] as const;
type TabId = (typeof TABS)[number];

const STARTED_BY_WORDS: Record<string, string> = {
  schedule: "by schedule",
  event: "by an event",
  webhook: "by a webhook",
  manual: "by hand, by us",
  message: "by a message",
  handoff: "by another agent's run",
  person: "by a person at the client",
};

export function OpsRunScreen() {
  const { id = "" } = useParams();
  const api = useApiClient();
  const session = useSession();
  const state = useApi(apiRoutes.opsRun, { params: { id } });
  const { data, loading, reload } = state;
  const going = data ? isRunGoing(data.run.status) : false;
  usePoll(reload, going, 2_000, loading);
  const calls = useApi(apiRoutes.opsRunModelCalls, { params: { id } });
  usePoll(calls.reload, going, 10_000, calls.loading);
  const [params, setParams] = useSearchParams();

  const workflow = useMemo(() => {
    const parsed = data?.workflow ? Workflow.safeParse(data.workflow.definition) : null;
    return parsed?.success ? parsed.data : null;
  }, [data?.workflow]);

  if (loading && !data) return <Loading />;
  if (!data) return <Loaded state={state}>{() => null}</Loaded>;

  const { run, agent } = data;
  const resolve = async (itemId: string, body: ResolveInput) => {
    await api.call(apiRoutes.opsResolveInbox, { params: { id: itemId }, body });
    reload();
  };
  const names: StepNames = workflow ? stepNames(workflow) : new Map();
  const rows = checklistRows({
    workflow,
    steps: data.steps,
    runStartedAt: run.startedAt,
    runCreatedAt: run.createdAt,
    going,
  });
  const waitingOnYou = data.inbox.filter((i) => i.status === "open" && operatorMayResolve(i));
  const clientName = session.tenants.find((t) => t.id === run.tenantId)?.name ?? "Client";
  const name = agent?.name ?? "Agent";
  const short = shortRunId(run.id);
  const error = runErrorParts(run.error);
  const failedRow =
    run.status === "failed" && error.nodeId
      ? rows.find((r) => data.steps.find((s) => s.id === r.stepRunId)?.nodeId === error.nodeId)
      : undefined;
  const failedIndex = failedRow ? rows.indexOf(failedRow) : -1;
  const chip = runChip(run.status);
  const startedBy = runStartedBy(run.trigger);
  const oversight = data.oversight ?? [];
  const stepNameById = new Map(rows.filter((r) => r.stepRunId).map((r) => [r.stepRunId, r.title]));

  const asked = params.get("tab");
  const tab: TabId = (TABS as readonly string[]).includes(asked ?? "")
    ? (asked as TabId)
    : waitingOnYou.length > 0
      ? "changes"
      : "timeline";
  const tabs: [TabId, string, number | null][] = [
    ["timeline", "Timeline", null],
    ["changes", "Changes", data.actions.length],
    ["calls", "Model calls", calls.data?.modelCalls.length ?? null],
    ["oversight", "Oversight", oversight.length],
    ["raw", "Raw", null],
  ];

  return (
    <Page testId="ops-run">
      <nav className="ds-crumbs flex-wrap" aria-label="Breadcrumb">
        <Link to="/ops/runs" className="text-link hover:underline" data-testid="ops-run-back">
          Runs
        </Link>
        <span aria-hidden>/</span>
        <Link to={`/ops/clients/${run.tenantId}`} className="hover:underline">
          {clientName}
        </Link>
        <span aria-hidden>/</span>
        <b className="reference">{short}</b>
      </nav>
      <div>
        <PageHeader
          leading={<AgentBadge name={name} size="lg" />}
          title={data.workflow?.name ?? run.workflowSlug}
          badge={
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusChip state={chip.state} testId="ops-run-status">
                {chip.words}
                {failedRow ? ` at step ${failedIndex}` : ""}
              </StatusChip>
              {run.mode === "test" ? <Badge>Test run</Badge> : null}
              {waitingOnYou.length > 0 ? (
                <StatusChip state="waiting" testId="ops-run-waiting">
                  Waiting on you · {waitingOnYou.length}
                </StatusChip>
              ) : null}
            </span>
          }
          subtitle={
            <>
              {[clientName, agent ? `${name}${data.version ? ` v${data.version}` : ""}` : null]
                .filter(Boolean)
                .join(" · ")}
              {" · "}
              <span className="reference" data-testid="ops-run-short-id">
                {short}
              </span>
              {` · started ${shortTime(run.startedAt ?? run.createdAt)}`}
              {startedBy ? ` ${STARTED_BY_WORDS[startedBy] ?? ""}` : ""}
            </>
          }
          actions={
            <RunControls
              run={run}
              failedStep={failedRow ? `step ${failedIndex}` : null}
              onChanged={reload}
            />
          }
        />
        <div className="ds-tabs" role="tablist" aria-label="Run">
          {tabs.map(([t, label, count]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              data-testid={`ops-run-tab-${t}`}
              onClick={() => setParams({ tab: t }, { replace: true })}
            >
              {label}
              {count !== null ? <span className="ds-num">· {count}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <PageGrid
        rail={
          <>
            <AboutRun
              data={data}
              clientName={clientName}
              calls={calls.data?.modelCalls.length ?? null}
              startedBy={startedBy}
            />
            {run.status === "failed" ? <NextStep run={run} /> : null}
            {run.status === "failed" ? <SameError run={run} /> : null}
          </>
        }
      >
        {run.status === "failed" && error.reason ? (
          <ErrorNotice error={new Error(failureText(run.error, names) ?? error.reason)} />
        ) : null}
        {tab === "timeline" ? (
          <Timeline data={data} rows={rows} failedNode={error.nodeId} oversight={oversight} />
        ) : null}
        {tab === "changes" ? <Changes data={data} onResolve={resolve} /> : null}
        {tab === "calls" ? (
          <Loaded state={calls}>
            {(c) => <ModelCalls calls={c.modelCalls} names={stepNameById as Map<string, string>} />}
          </Loaded>
        ) : null}
        {tab === "oversight" ? <OversightList decisions={oversight} names={stepNameById} /> : null}
        {tab === "raw" ? <RunLog data={data} names={names} /> : null}
      </PageGrid>
    </Page>
  );
}

// ── Timeline ──

function stepState(row: RunStepRow, nodeType: string | undefined): StepState {
  switch (row.status) {
    case "succeeded":
      return nodeType === "person" ? "person" : "done";
    case "running":
      return "current";
    case "waiting":
      return nodeType === "person" ? "person" : "waiting";
    case "failed":
      return "failed";
    default:
      return "todo";
  }
}

/** "6.1k" for 6,100 tokens. */
function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

function isZero(amount: string | null): boolean {
  return !amount || Number(amount) === 0;
}

function Timeline({
  data,
  rows,
  failedNode,
  oversight,
}: {
  data: RunDetail;
  rows: RunStepRow[];
  failedNode: string | null;
  oversight: Decision[];
}) {
  const { run } = data;
  const steps = new Map(data.steps.map((s) => [s.id, s]));
  const done = rows.filter((r) => r.status === "succeeded").length;
  const items: StepItem[] = rows.map((r, i) => {
    const s = r.stepRunId ? steps.get(r.stepRunId) : undefined;
    const meta = [
      s ? duration(s.startedAt, s.finishedAt) : null,
      isZero(r.costUsd) ? null : usd(r.costUsd),
      s && (s.tokensIn || s.tokensOut)
        ? `${tokens(s.tokensIn)} in / ${tokens(s.tokensOut)} out`
        : null,
    ].filter(Boolean);
    const detail = [
      r.detail,
      s?.models?.length ? `model ${s.models.join(", ")}` : null,
      r.status === "pending" || r.status === "waiting" || r.status === "succeeded"
        ? null
        : stepStatusLabel(r.status),
      r.internal ? "hidden from client" : null,
    ].filter(Boolean);
    const failed = r.status === "failed" || (failedNode !== null && s?.nodeId === failedNode);
    const decisions = s ? oversight.filter((d) => d.stepRunId === s.id) : [];
    return {
      key: r.key,
      testId: `ops-run-step-${r.key}`,
      state: stepState(r, s?.nodeType),
      time: r.at ? shortTime(r.at) : "next",
      title: (
        <span className="ops-step-head">
          <span className="flex flex-wrap items-center gap-2">
            <Tag>{r.kind}</Tag>
            <span className={failed ? "ui-tone-risk" : undefined}>
              {i > 0 ? `${i} · ` : ""}
              {r.title}
            </span>
          </span>
          {meta.length > 0 ? <span className="ops-step-meta">{meta.join(" · ")}</span> : null}
        </span>
      ),
      ...(detail.length > 0 ? { detail: detail.join(" · ") } : {}),
      children: (
        <>
          {r.stepRunId ? (
            <SourceLinks
              ids={sourcesOf(s?.output)}
              href={(id) => `/ops/clients/${run.tenantId}/records/${id}`}
              testId={`ops-run-step-sources-${r.key}`}
            />
          ) : null}
          {decisions.map((d) => (
            <p key={d.id} className="text-sm text-ink">
              Oversight: {oversightLine(d).toLowerCase()}.
            </p>
          ))}
          {failed && s ? (
            <ToolCallsBlock calls={data.toolCalls.filter((c) => c.stepRunId === s.id)} />
          ) : null}
        </>
      ),
    };
  });
  return (
    <Card
      title="What it did"
      meta={
        <span className="figures">
          {done} of {rows.length} steps · {usd(run.costUsd)}
        </span>
      }
      testId="ops-run-checklist"
      pad
    >
      <StepList steps={items} />
    </Card>
  );
}

function compact(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

function ToolCallsBlock({ calls }: { calls: RunDetail["toolCalls"] }) {
  if (calls.length === 0) return null;
  return (
    <pre className="ops-code" data-testid="ops-run-failed-calls">
      {calls
        .map((c) =>
          [
            `tool_call  ${c.tool}   status: ${c.status}${c.durationMs === null ? "" : `   ${c.durationMs} ms`}`,
            `input      ${compact(c.input)}`,
            `output     ${compact(c.output)}`,
            c.externalActionId ? `external_action  ${c.externalActionId}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n")}
    </pre>
  );
}

// ── Rail ──

function AboutRun({
  data,
  clientName,
  calls,
  startedBy,
}: {
  data: RunDetail;
  clientName: string;
  calls: number | null;
  startedBy: string | null;
}) {
  const { run, agent } = data;
  const facts: [string, ReactNode][] = [
    ["Client", clientName],
    [
      "Agent",
      agent ? (
        <Link
          key="agent"
          to={`/ops/clients/${run.tenantId}/agents/${agent.slug}`}
          className="text-link hover:underline"
        >
          {agent.name}
          {data.version ? ` v${data.version}` : ""}
        </Link>
      ) : (
        "—"
      ),
    ],
    ...(agent?.serviceName
      ? ([["Client calls it", agent.serviceName]] as [string, ReactNode][])
      : []),
    [
      "Workflow",
      <span key="workflow" className="reference">
        {run.workflowSlug}
      </span>,
    ],
    ["Mode", run.mode === "test" ? "Test run, never writes" : "Live"],
    [
      "Started",
      `${shortTime(run.startedAt ?? run.createdAt)}${startedBy ? ` ${STARTED_BY_WORDS[startedBy] ?? ""}` : ""}`,
    ],
    ["Duration", run.startedAt ? duration(run.startedAt, run.finishedAt) : "Not started"],
    [
      "Cost",
      `${usd(run.costUsd)}${calls === null ? "" : ` · ${plural(calls, "model call", "model calls")}`}`,
    ],
  ];
  return (
    <Card title="About this run" pad testId="ops-run-about">
      <dl className="ops-facts">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** What fixes a failure we can name: a tool's sign-in the client has to redo. */
function NextStep({ run }: { run: RunDetail["run"] }) {
  const { reason } = runErrorParts(run.error);
  const code = runErrorCode(reason);
  if (code !== "unauthorized" && code !== "forbidden" && code !== "not_released") return null;
  const text =
    code === "not_released"
      ? "A browser login waits for a person at the client to release it."
      : "A tool's sign-in failed. Only the client can sign in again, from their portal. Nothing was written.";
  return (
    <Card pad testId="ops-run-next">
      <p className="text-sm text-ink">{text}</p>
      <Link
        to={`/ops/clients/${run.tenantId}/connections`}
        className="mt-2 inline-block text-sm text-link underline"
      >
        Open the client's connections
      </Link>
    </Card>
  );
}

function SameError({ run }: { run: RunDetail["run"] }) {
  const key = errorGroupKey(run.error);
  const state = useApi(
    apiRoutes.opsRuns,
    key === "unknown"
      ? null
      : { query: { errorKey: key, statuses: "failed", limit: "6" } as never },
  );
  const others = (state.data?.runs ?? []).filter((r) => r.id !== run.id).slice(0, 5);
  if (others.length === 0) return null;
  return (
    <Card
      title="Same error elsewhere"
      meta={<span className="reference">{key}</span>}
      testId="ops-run-same-error"
    >
      {others.map((r) => (
        <Link
          key={r.id}
          to={`/ops/runs/${r.id}`}
          className="ops-row text-sm hover:bg-surface-subtle"
        >
          <span className="reference text-ink">{shortRunId(r.id)}</span>
          <span className="flex-1 text-ink-muted">{shortTime(r.startedAt ?? r.createdAt)}</span>
          <StatusChip state={runChip(r.status).state}>{runChip(r.status).words}</StatusChip>
        </Link>
      ))}
    </Card>
  );
}

// ── Changes ──

function Changes({
  data,
  onResolve,
}: {
  data: RunDetail;
  onResolve: (itemId: string, body: ResolveInput) => Promise<void>;
}) {
  const { run } = data;
  const items = new Map(data.inbox.map((i) => [i.id, i]));
  // Person steps' items (questions, approvals) are answered in place, beside the changes.
  const personItems = data.inbox.filter((i) => i.kind !== "external_action" && i.status === "open");
  return (
    <div className="flex flex-col gap-4" data-testid="ops-run-changes">
      {data.actions.length === 0 ? (
        <EmptyState>This run changed nothing in the client's tools.</EmptyState>
      ) : (
        data.actions.map((a) => (
          <ActionPanel
            key={a.id}
            action={a}
            item={a.inboxItemId ? (items.get(a.inboxItemId) ?? null) : null}
            testRun={run.mode === "test"}
            onResolve={onResolve}
          />
        ))
      )}
      {personItems.map((i) => (
        <InboxCard
          key={i.id}
          item={i}
          testId={`ops-run-item-${i.id}`}
          showToolId
          recordHref={(id) => `/ops/clients/${run.tenantId}/records/${id}`}
          onResolve={operatorMayResolve(i) ? (body) => onResolve(i.id, body) : null}
          waitingOn="Waiting on the client. Only they can answer it."
        />
      ))}
      <p className="text-sm text-ink-muted">
        Every change records which agent, version and step made it, what it looked like before, and
        who approved it.
      </p>
    </div>
  );
}

function actionBadge(a: Action, testRun: boolean): { label: string; tone: Tone } {
  switch (a.status) {
    case "proposed":
      return testRun
        ? { label: "Would have done", tone: "neutral" }
        : { label: "Needs approval", tone: "warning" };
    case "approved":
    case "executing":
      // A person signed it: copper marks a person's touch.
      return { label: "Approved", tone: "person" };
    case "done":
      return {
        label: a.executedAt ? `Done · ${shortTime(a.executedAt)}` : "Done",
        tone: "positive",
      };
    case "rejected":
      return { label: "Rejected", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "risk" };
    default:
      return { label: a.status, tone: "neutral" };
  }
}

function ActionPanel({
  action,
  item,
  testRun,
  onResolve,
}: {
  action: Action;
  item: Item | null;
  testRun: boolean;
  onResolve: (itemId: string, body: ResolveInput) => Promise<void>;
}) {
  const badge = actionBadge(action, testRun);
  const heading = changeHeading(action.display, action.tool, action.before, action.input);
  const waiting = action.status === "proposed" && item?.status === "open";
  const mine = item ? operatorMayResolve(item) : false;
  const failure = action.error as { message?: unknown } | null;
  let text: string;
  if (testRun) text = "Test run: recorded as it would have been made, never written.";
  else if (waiting && !mine) text = "Waiting on the client admin to approve.";
  else if (waiting) text = "Nothing changes in the tool until you sign.";
  else if (action.status === "failed")
    text = `The change failed: ${String(failure?.message ?? "unknown error")}`;
  else if (action.approvedAt)
    text = `Approved ${shortTime(action.approvedAt)}${action.approvedBy ? "" : " automatically"}.`;
  else text = "";
  return (
    <Card testId={`ops-run-action-${action.id}`}>
      <div className="ui-card__head">
        <div className="min-w-0">
          <h3 className="font-medium text-ink">
            {heading.title}
            <span className="ml-2 reference font-normal text-ink-muted">{action.tool}</span>
          </h3>
          {heading.description ? (
            <p className="text-sm text-ink-muted" data-testid="ops-run-action-description">
              {heading.description}
            </p>
          ) : null}
        </div>
        <Badge tone={badge.tone} testId="ops-run-action-status">
          {badge.label}
        </Badge>
      </div>
      <div className="ui-card__body">
        <ChangeTables before={action.before} input={action.input} display={action.display?.tool} />
      </div>
      <div className="ui-card__foot justify-between">
        <p className="text-sm text-ink-muted">{text}</p>
        {waiting && mine && item ? (
          <div className="flex gap-2">
            <Button
              data-testid="ops-run-action-reject"
              variant="ghost"
              onClick={() => void onResolve(item.id, { decision: "reject" })}
            >
              Reject
            </Button>
            <Button
              data-testid="ops-run-action-approve"
              variant="primary"
              onClick={() => void onResolve(item.id, { decision: "approve" })}
            >
              Sign and update {heading.connector}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ── Oversight ──

function OversightList({
  decisions,
  names,
}: {
  decisions: Decision[];
  names: Map<string | null, string>;
}) {
  if (decisions.length === 0) {
    return (
      <EmptyState>
        No oversight decisions. When a step fails or reaches a checkpoint, the run's oversight
        decides what happens next, and it shows here.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="ops-run-oversight">
      {decisions.map((d) => (
        <Card
          key={d.id}
          title={`${OVERSIGHT_ACTION_WORDS[d.action]} ${OVERSIGHT_CAUSE_WORDS[d.cause]}`}
          meta={shortTime(d.createdAt)}
          testId={`ops-run-decision-${d.id}`}
        >
          <div className="ui-card__body flex flex-col gap-2">
            <p className="text-sm text-ink-muted">
              {[
                names.get(d.stepRunId) ?? d.nodeId,
                d.model,
                usd(d.costUsd),
                `${tokens(d.tokensIn)} in / ${tokens(d.tokensOut)} out`,
              ].join(" · ")}
            </p>
            <p className="text-ink">{d.note}</p>
            {d.proposal ? (
              <p className="text-sm text-ink">
                <span className="text-ink-muted">Lasting fix to make in the builder: </span>
                {d.proposal.summary}
              </p>
            ) : null}
            {d.inboxItemId ? (
              <p className="text-sm">
                <Link to="/ops/inbox" className="text-link underline">
                  It asked a person
                </Link>
              </p>
            ) : null}
          </div>
          {d.action === "retry_with" ? (
            <BeforeAfter
              before={<pre className="ops-code">{JSON.stringify(d.inputBefore, null, 2)}</pre>}
              after={<pre className="ops-code">{JSON.stringify(d.inputAfter, null, 2)}</pre>}
              beforeLabel="Input before"
              afterLabel="Corrected input"
            />
          ) : null}
        </Card>
      ))}
    </div>
  );
}

// ── Raw ──

function Json({ value }: { value: unknown }) {
  return (
    <pre className="ops-code">
      {value === null || value === undefined ? "—" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** A step's name for a run node id (`<step>` or `<loop>:<i>:<step>`), when the workflow has it. */
function nodeName(names: StepNames, nodeId: string): string | undefined {
  return names.get(nodeId) ?? names.get(nodeId.split(":").at(-1) ?? nodeId);
}

/** A run's error in words: "Review the record failed: …" rather than the stored JSON. */
export function failureText(error: unknown, names: StepNames): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { message?: unknown; reason?: unknown; nodeId?: unknown };
    const why =
      typeof e.reason === "string" ? e.reason : typeof e.message === "string" ? e.message : null;
    if (why) {
      const step = typeof e.nodeId === "string" ? nodeName(names, e.nodeId) : undefined;
      return step ? `${step} failed: ${why}` : why;
    }
  }
  return JSON.stringify(error);
}

function RunLog({ data, names }: { data: RunDetail; names: StepNames }) {
  return (
    <Card testId="ops-run-log">
      <details className="ops-row block">
        <summary className="cursor-pointer text-ink">Trigger</summary>
        <div className="mt-3">
          <Json value={data.run.trigger} />
        </div>
      </details>
      {data.steps.map((s) => {
        const calls = data.toolCalls.filter((c) => c.stepRunId === s.id);
        return (
          <details key={s.id} className="ops-row block" data-testid={`ops-run-log-${s.id}`}>
            <summary className="cursor-pointer">
              <span className="text-ink">{nodeName(names, s.nodeId) ?? s.nodeId}</span>
              <span className="ml-2 text-sm text-ink-muted">
                {[
                  s.nodeType,
                  s.skillRef,
                  stepStatusLabel(s.status),
                  duration(s.startedAt, s.finishedAt),
                  usd(s.costUsd),
                  s.tokensIn || s.tokensOut ? `${s.tokensIn} in / ${s.tokensOut} out` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div>
                <h4 className="eyebrow mb-1 text-ink-muted">Input</h4>
                <Json value={s.input} />
              </div>
              <div>
                <h4 className="eyebrow mb-1 text-ink-muted">Output</h4>
                <Json value={s.output} />
              </div>
            </div>
            {calls.length > 0 ? (
              <div className="mt-3">
                <h4 className="eyebrow mb-1 text-ink-muted">Tool calls</h4>
                <ul className="flex flex-col gap-2">
                  {calls.map((c) => (
                    <li key={c.id} className="rounded-sm border border-line p-3">
                      <p className="text-sm">
                        <span className="reference text-ink">{c.tool}</span>
                        <span className="ml-2 text-ink-muted">
                          {[c.status, c.durationMs === null ? null : `${c.durationMs} ms`]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </p>
                      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
                        <Json value={c.input} />
                        <Json value={c.output} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </details>
        );
      })}
      {data.run.error ? (
        <details className="ops-row block" open>
          <summary className="cursor-pointer text-ink">Error</summary>
          <div className="mt-3">
            <Json value={data.run.error} />
          </div>
        </details>
      ) : null}
    </Card>
  );
}
