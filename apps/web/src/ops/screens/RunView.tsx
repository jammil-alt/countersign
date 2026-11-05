// `/ops/runs/:id`: the back-office run view (design screen 6; ARCHITECTURE §10.5). "What it did"
// as a checklist of steps with status, summary, time and cost; "Changes to your tools" with now /
// after this change for each action, approve or reject where one waits on the operator; the full
// log (inputs, outputs, tool calls). Polls every 2 s while the run is going.
import { Workflow } from "@countersign/core";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ChangeTables } from "../../inbox/ChangePanel";
import { changeTarget, connectorName, connectorOf } from "../../inbox/change";
import { InboxCard, type ResolveInput } from "../../inbox/InboxCard";
import { SourceLinks, sourcesOf } from "../../records/SourceLinks";
import {
  duration,
  isRunGoing,
  runStatusLabel,
  runStatusTone,
  shortTime,
  stepStatusLabel,
  usd,
} from "../../runs/format";
import { StepMark } from "../../runs/StepMark";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import {
  AgentAvatar,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  Tag,
  type Tone,
} from "../../ui/primitives";
import { checklistRows } from "../run/checklist";
import { type StepNames, stepNames } from "../workflow/describe";
import { operatorMayResolve } from "./Inbox";

type RunDetail = ResponseOf<typeof apiRoutes.opsRun>;
type Action = RunDetail["actions"][number];
type Item = RunDetail["inbox"][number];

export function OpsRunScreen() {
  const { id = "" } = useParams();
  const api = useApiClient();
  const session = useSession();
  const { data, error, loading, reload } = useApi(apiRoutes.opsRun, { params: { id } });
  const going = data ? isRunGoing(data.run.status) : false;
  usePoll(reload, going, 2_000);

  const workflow = useMemo(() => {
    const parsed = data?.workflow ? Workflow.safeParse(data.workflow.definition) : null;
    return parsed?.success ? parsed.data : null;
  }, [data?.workflow]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;

  const { run, agent } = data;
  const resolve = async (itemId: string, body: ResolveInput) => {
    await api.call(apiRoutes.opsResolveInbox, { params: { id: itemId }, body });
    reload();
  };
  const rows = checklistRows({
    workflow,
    steps: data.steps,
    runStartedAt: run.startedAt,
    runCreatedAt: run.createdAt,
    going,
  });
  const done = rows.filter((r) => r.status === "succeeded").length;
  // The records each step's output cites (invariant 10), linked to their pages.
  const sources = new Map(data.steps.map((s) => [s.id, sourcesOf(s.output)]));
  const items = new Map(data.inbox.map((i) => [i.id, i]));
  const waitingOnYou = data.inbox.filter((i) => i.status === "open" && operatorMayResolve(i));
  // Person steps' items (questions, approvals) are answered in place, beside the changes.
  const personItems = data.inbox.filter((i) => i.kind !== "external_action" && i.status === "open");
  const clientName = session.tenants.find((t) => t.id === run.tenantId)?.name ?? "client";
  const name = agent?.name ?? "Agent";
  const names: StepNames = workflow ? stepNames(workflow) : new Map();
  const failure = failureText(run.error, names);

  return (
    <div>
      <p className="mb-3 text-sm">
        <Link to="/ops/runs" className="text-link underline" data-testid="ops-run-back">
          Runs
        </Link>
        {agent?.tenantId ? (
          <>
            {" · "}
            <Link
              to={`/ops/clients/${agent.tenantId}/agents/${agent.slug}`}
              className="text-link underline"
            >
              {name}
            </Link>
          </>
        ) : null}
      </p>
      <PageHeader
        leading={<AgentAvatar name={name} seed={agent?.slug ?? run.agentId} size="lg" />}
        title={name}
        badge={
          <span className="flex items-center gap-1.5">
            <Badge tone={run.mode === "test" ? "neutral" : "positive"}>
              {run.mode === "test" ? "Test" : "Live"}
              {data.version ? ` · v${data.version}` : ""}
            </Badge>
            <Badge tone={runStatusTone(run.status)} testId="ops-run-status">
              {runStatusLabel(run.status)}
            </Badge>
          </span>
        }
        subtitle={[
          data.workflow?.name ?? run.workflowSlug,
          `started ${shortTime(run.startedAt ?? run.createdAt)}`,
          clientName,
          run.finishedAt ? `took ${duration(run.startedAt, run.finishedAt)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          waitingOnYou.length > 0 ? (
            <Badge tone="warning" testId="ops-run-waiting">
              Waiting on you · {waitingOnYou.length}
            </Badge>
          ) : undefined
        }
      />
      {run.status === "failed" && failure ? (
        <div className="mb-4">
          <ErrorNotice error={new Error(failure)} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card testId="ops-run-checklist" className="self-start overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="eyebrow text-ink-muted">What it did</h2>
            <span className="text-sm text-ink-muted figures">
              {done} of {rows.length} steps · {usd(run.costUsd)}
            </span>
          </div>
          <ol>
            {rows.map((r, i) => (
              <li
                key={r.key}
                data-testid={`ops-run-step-${r.key}`}
                className={cx(
                  "flex gap-3 border-b border-line px-4 py-3 last:border-b-0",
                  r.status === "waiting" && "bg-signal-tint",
                  r.status === "pending" && "opacity-60",
                )}
              >
                <StepMark status={r.status} n={i + 1} />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <Tag>{r.kind}</Tag>
                    <span className="text-ink">{r.title}</span>
                  </p>
                  {r.detail ? <p className="mt-1 text-sm text-ink">{r.detail}</p> : null}
                  {r.stepRunId ? (
                    <SourceLinks
                      ids={sources.get(r.stepRunId) ?? []}
                      href={(id) => `/ops/clients/${run.tenantId}/records/${id}`}
                      testId={`ops-run-step-sources-${r.key}`}
                    />
                  ) : null}
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {[
                      shortTime(r.at),
                      stepStatusLabel(r.status),
                      r.costUsd && !/^0*(\.0*)?$/.test(r.costUsd) ? usd(r.costUsd) : null,
                      r.internal ? "hidden from client" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <SectionLabel>Changes to your tools</SectionLabel>
          {data.actions.length === 0 ? (
            <EmptyState>This run changed nothing in the client's tools.</EmptyState>
          ) : (
            data.actions.map((a) => (
              <ActionPanel
                key={a.id}
                action={a}
                item={a.inboxItemId ? (items.get(a.inboxItemId) ?? null) : null}
                testRun={run.mode === "test"}
                onResolve={resolve}
              />
            ))
          )}
          {personItems.length > 0 ? (
            <>
              <SectionLabel>Waiting on a person</SectionLabel>
              {personItems.map((i) => (
                <InboxCard
                  key={i.id}
                  item={i}
                  testId={`ops-run-item-${i.id}`}
                  recordHref={(id) => `/ops/clients/${run.tenantId}/records/${id}`}
                  onResolve={operatorMayResolve(i) ? (body) => resolve(i.id, body) : null}
                  waitingOn="Waiting on the client. Only they can answer it."
                />
              ))}
            </>
          ) : null}
          <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-ink-muted">
            <span>
              Every change records which agent, version and step made it, what it looked like
              before, and who approved it.
            </span>
            <a href="#run-log" className="text-link underline" data-testid="ops-run-log-open">
              Full run log
            </a>
          </Card>
        </div>
      </div>

      <RunLog data={data} names={names} />
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
  const connector = connectorName(connectorOf(action.tool));
  const target = changeTarget(action.before, action.input);
  const waiting = action.status === "proposed" && item?.status === "open";
  const mine = item ? operatorMayResolve(item) : false;
  return (
    <Card testId={`ops-run-action-${action.id}`} className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="font-medium text-ink">
          {connector}
          {target ? ` · ${target}` : ""}
          <span className="ml-2 reference font-normal text-ink-muted">{action.tool}</span>
        </h3>
        <Badge tone={badge.tone} testId="ops-run-action-status">
          {badge.label}
        </Badge>
      </div>
      <div className="p-4">
        <ChangeTables before={action.before} input={action.input} />
      </div>
      <ActionFooter
        action={action}
        item={item}
        testRun={testRun}
        waiting={waiting}
        mine={mine}
        connector={connector}
        onResolve={onResolve}
      />
    </Card>
  );
}

function ActionFooter({
  action,
  item,
  testRun,
  waiting,
  mine,
  connector,
  onResolve,
}: {
  action: Action;
  item: Item | null;
  testRun: boolean;
  waiting: boolean;
  mine: boolean;
  connector: string;
  onResolve: (itemId: string, body: ResolveInput) => Promise<void>;
}) {
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
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
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
            className="font-semibold"
            onClick={() => void onResolve(item.id, { decision: "approve" })}
          >
            Sign and update {connector}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-sm bg-surface-subtle p-3 font-mono text-xs whitespace-pre-wrap break-words text-ink">
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
    <section id="run-log" className="mt-8" data-testid="ops-run-log">
      <SectionLabel>Full run log</SectionLabel>
      <Card className="divide-y divide-line">
        <details className="px-4 py-3">
          <summary className="cursor-pointer text-ink">Trigger</summary>
          <div className="mt-3">
            <Json value={data.run.trigger} />
          </div>
        </details>
        {data.steps.map((s) => {
          const calls = data.toolCalls.filter((c) => c.stepRunId === s.id);
          return (
            <details key={s.id} className="px-4 py-3" data-testid={`ops-run-log-${s.id}`}>
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
          <details className="px-4 py-3" open>
            <summary className="cursor-pointer text-ink">Error</summary>
            <div className="mt-3">
              <Json value={data.run.error} />
            </div>
          </details>
        ) : null}
      </Card>
    </section>
  );
}
