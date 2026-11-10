// `/ops/runs/:id`, O10 Run detail (docs/design/prototype.html `#O10-RunDetail`; ARCHITECTURE §10.5,
// §10.10, §10.11): the full view of one run, titled by what it is about (its invoice or its first
// change). When it waits, a block at the top says on whom and since when, with Approve and Reject
// where the server lets us resolve the item, else who must approve and where. Tabs: Timeline (each
// step with its time, cost, tokens and models, a failed step with its tool calls), Changes (now /
// after this change for each action) and Details (model calls with request and answer, the run
// oversight's decisions, and the raw trigger, inputs, outputs and tool calls). Beside it: about
// this run and the same error elsewhere. Retry, cancel and replay. Polls every 2 s while it goes.
// P-4

import {
  approvalOf,
  carriedOn,
  checkKindOf,
  conferOf,
  errorGroupKey,
  noAnswerOf,
  processes,
  routeOfRow,
  runErrorCode,
  runStartedBy,
  shortRunId,
  stepNodeOf,
  type TimelineChecks,
  urgentOf,
} from "@countersign/core";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { ChangeTables } from "../../inbox/ChangePanel";
import { changeHeading } from "../../inbox/change";
import { InboxCard, type ResolveInput } from "../../inbox/InboxCard";
import { SourceLinks, sourcesOf } from "../../records/SourceLinks";
// P-6
import { ConversationControls } from "../../runs/ConversationControls";
import { duration, isRunGoing, shortTime, stepStatusLabel, usd } from "../../runs/format";
import { roleLabel, qualifiedToolLabel as toolLabel } from "../../runs/labels";
import { conferTitle, StepChecks } from "../../runs/StepChecks";
import { opsRunTitle } from "../../runs/subject";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { BeforeAfter } from "../../ui/activity";
import { AgentBadge } from "../../ui/badges";
import { Loaded, Page, PageGrid, Section } from "../../ui/page";
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
import { Transcript } from "../../ui/transcript";
import { usePageClient } from "../pickedClient";
import { checklistRows, type RanWorkflow, type RunStepRow, ranWorkflow } from "../run/checklist";
// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the owner's checks, the audit, the export.
import { OwnerCheckLines, RunAuditCard, RunExportCard } from "../run/RunAudit";
import { ModelCalls, RunControls } from "../run/RunControls";
import { type RunWait, runWaiting, waitingOn, waitingWhat } from "../run/waiting";
import {
  NOBODY_TO_ACT_WORDS,
  OVERSIGHT_CAUSE_WORDS,
  OWNER_ACTION_WORDS,
  ownerLine,
  plural,
  runChip,
  runErrorParts,
} from "../run/words";
import { processStepNames, type StepNames, stepNames } from "../workflow/describe";

type RunDetail = ResponseOf<typeof apiRoutes.opsRun>;
type Action = RunDetail["actions"][number];
type Item = RunDetail["inbox"][number];
type Decision = NonNullable<RunDetail["oversight"]>[number];
type Wait = RunWait<Item>;

const TABS = ["timeline", "changes", "details"] as const;
type TabId = (typeof TABS)[number];
/** The tabs Details took in: their old addresses open it. */
const FOLDED_TABS = ["calls", "oversight", "raw"];

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
  // The top bar's client picker shows the run's client.
  usePageClient(data?.run.tenantId);
  const going = data ? isRunGoing(data.run.status) : false;
  usePoll(reload, going, 2_000, loading);
  const calls = useApi(apiRoutes.opsRunModelCalls, { params: { id } });
  usePoll(calls.reload, going, 10_000, calls.loading);
  const [params, setParams] = useSearchParams();

  // R8: the workflow that ran, a stored v3 workflow or a v4 process (§1.86).
  const workflow = useMemo(
    () => (data?.workflow ? ranWorkflow(data.workflow.definition) : null),
    [data?.workflow],
  );

  if (loading && !data) return <Loading />;
  if (!data) return <Loaded state={state}>{() => null}</Loaded>;

  const { run, agent } = data;
  const resolve = async (itemId: string, body: ResolveInput) => {
    await api.call(apiRoutes.opsResolveInbox, { params: { id: itemId }, body });
    reload();
  };
  const names: StepNames = workflow
    ? workflow.schemaVersion === 4
      ? processStepNames(workflow)
      : stepNames(workflow)
    : new Map();
  const rows = checklistRows({
    workflow,
    steps: data.steps,
    runStartedAt: run.startedAt,
    runCreatedAt: run.createdAt,
    going,
  });
  // Who it waits on and since when come from the API's `run.waiting` (core's run state).
  const wait = going ? runWaiting(data.inbox, run.waiting) : null;
  const clientName = session.tenants.find((t) => t.id === run.tenantId)?.name ?? "Client";
  const name = agent?.serviceName ?? agent?.name ?? "Agent";
  const short = shortRunId(run.id);
  const error = runErrorParts(run.error);
  const failedRow =
    run.status === "failed" && error.nodeId
      ? rows.find((r) => data.steps.find((s) => s.id === r.stepRunId)?.nodeId === error.nodeId)
      : undefined;
  const failedIndex = failedRow ? rows.indexOf(failedRow) : -1;
  const chip = wait ? { state: "waiting" as const, words: wait.line } : runChip(run.status);
  const startedBy = runStartedBy(run.trigger);
  const oversight = data.oversight ?? [];
  const stepNameById = new Map(rows.filter((r) => r.stepRunId).map((r) => [r.stepRunId, r.title]));
  const workflowName = data.workflow?.name ?? run.workflowSlug;

  const asked = params.get("tab") ?? "";
  const tab: TabId = (TABS as readonly string[]).includes(asked)
    ? (asked as TabId)
    : FOLDED_TABS.includes(asked)
      ? "details"
      : wait?.mine
        ? "changes"
        : "timeline";
  const tabs: [TabId, string, number | null][] = [
    ["timeline", "Timeline", null],
    ["changes", "Changes", data.actions.length],
    ["details", "Details", null],
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
          leading={<AgentBadge name={name} seed={agent?.id} size="lg" />}
          title={opsRunTitle(run.subject, workflowName)}
          badge={
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusChip state={chip.state} testId="ops-run-status">
                {chip.words}
                {failedRow ? ` at step ${failedIndex}` : ""}
              </StatusChip>
              {run.mode === "test" ? <Badge>Test run</Badge> : null}
            </span>
          }
          subtitle={
            <>
              {[
                clientName,
                agent ? `${name}${data.version ? ` v${data.version}` : ""}` : null,
                workflowName,
              ]
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
        {wait ? (
          <WaitingBlock
            wait={wait}
            data={data}
            onResolve={resolve}
            onAnswer={() => setParams({ tab: "changes" }, { replace: true })}
          />
        ) : null}
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
            {/* Wave 6 review: only live runs are audited (the API refuses a test run's mark). */}
            {run.mode === "live" ? (
              <RunAuditCard runId={run.id} audit={data.audit} finished={!going} onMarked={reload} />
            ) : null}
            <RunExportCard runId={run.id} />
          </>
        }
      >
        {run.status === "failed" && error.reason ? (
          <ErrorNotice error={new Error(failureText(run.error, names) ?? error.reason)} />
        ) : null}
        {tab === "timeline" ? (
          <Timeline
            data={data}
            workflow={workflow}
            rows={rows}
            failedNode={error.nodeId}
            oversight={oversight}
            wait={wait}
            onConversation={async (stepRunId, action, reason) => {
              await api.call(apiRoutes.opsConversationControl, {
                params: { id: run.tenantId, runId: run.id, stepRunId },
                body: { action, reason },
              });
              reload();
            }}
          />
        ) : null}
        {tab === "changes" ? <Changes data={data} onResolve={resolve} /> : null}
        {tab === "details" ? (
          <div className="flex flex-col gap-8" data-testid="ops-run-details">
            <Section
              title="Model calls"
              meta={calls.data ? plural(calls.data.modelCalls.length, "call", "calls") : null}
            >
              <Loaded state={calls}>
                {(c) => (
                  <ModelCalls
                    calls={c.modelCalls}
                    unrecorded={c.unrecorded}
                    names={stepNameById as Map<string, string>}
                  />
                )}
              </Loaded>
            </Section>
            <Section
              title="The owner"
              meta="What the agent's owner did when a step failed or reached a checkpoint"
            >
              <OversightList decisions={oversight} names={stepNameById} />
            </Section>
            <Section title="Raw data" meta="The trigger, each step's input and output, tool calls">
              <RunLog data={data} names={names} />
            </Section>
          </div>
        ) : null}
      </PageGrid>
    </Page>
  );
}

// ── Waiting ──

/**
 * The run's wait, at the top: on whom and since when; Approve and Reject when the server lets us
 * resolve the item (the Sandbox, items delegated to us), else who must and where to see it.
 */
function WaitingBlock({
  wait,
  data,
  onResolve,
  onAnswer,
}: {
  wait: Wait;
  data: RunDetail;
  onResolve: (itemId: string, body: ResolveInput) => Promise<void>;
  onAnswer: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const item = wait.item;
  const action = data.actions.find((a) => a.inboxItemId === item.id);
  const connector = action
    ? changeHeading(action.display, action.tool, action.before, action.input).connector
    : null;
  const approves = item.kind === "external_action" || item.kind === "approval";
  const act = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      await onResolve(item.id, { decision });
    } finally {
      setBusy(false);
    }
  };
  const more = wait.items.length > 1 ? ` · ${plural(wait.items.length, "item", "items")}` : "";
  return (
    <Card pad testId="ops-run-waiting" className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
            <StatusChip state="waiting">{wait.what}</StatusChip>
            <span data-testid="ops-run-waiting-line">
              {wait.who} · since {shortTime(wait.since)} ({wait.waited}){more}
            </span>
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {wait.mine
              ? approves
                ? `Nothing changes${connector ? ` in ${connector}` : ""} until it is approved.`
                : "The run goes on once it is answered."
              : `Only ${wait.who === "client admin" || wait.who === "client's team" ? `the ${wait.who}` : wait.who} can ${approves ? "approve" : "answer"} this. We can't do it for them.`}
          </p>
          {wait.nobodyToAct ? (
            <p className="mt-1 text-sm ui-tone-risk" data-testid="ops-run-waiting-nobody">
              {NOBODY_TO_ACT_WORDS[wait.nobodyToAct]}
            </p>
          ) : null}
        </div>
        {wait.mine && approves ? (
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="ops-run-waiting-reject"
              variant="ghost"
              disabled={busy}
              onClick={() => void act("reject")}
            >
              Reject
            </Button>
            <Button
              data-testid="ops-run-waiting-approve"
              variant="primary"
              disabled={busy}
              onClick={() => void act("approve")}
            >
              {connector ? `Approve and update ${connector}` : "Approve"}
            </Button>
          </div>
        ) : wait.mine ? (
          <Button data-testid="ops-run-waiting-answer" variant="primary" onClick={onAnswer}>
            Answer it
          </Button>
        ) : (
          <Link
            to={`/ops/inbox?assigned=all&client=${data.run.tenantId}`}
            className="text-sm text-link underline"
            data-testid="ops-run-waiting-where"
          >
            See it in Escalations
          </Link>
        )}
      </div>
    </Card>
  );
}

// ── Timeline ──

function stepState(
  row: RunStepRow,
  nodeType: string | undefined,
  checks?: TimelineChecks,
): StepState {
  // R8: a person's answer to a confer is a person's step.
  if (checks?.confer) return checks.confer.reviewer === "person" ? "person" : "done";
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

/**
 * R8: what a step's checks did (core's run-checks over this run's rows and items), for the back
 * office: approvers and conferees by role (the run's answer names no people yet).
 */
function checksFor(
  s: RunDetail["steps"][number],
  data: RunDetail,
  workflow: RanWorkflow | null,
  outcomes: ReadonlyMap<string, NonNullable<TimelineChecks["outcome"]>> = new Map(),
): TimelineChecks {
  const out: TimelineChecks = {};
  const named = (who: string | null) =>
    who && /^[a-z_]+$/.test(who) ? roleLabel(who) : "a named person";
  const confer = conferOf(s);
  if (confer) out.confer = { ...confer, name: confer.who ? named(confer.who) : null };
  const noAnswer = noAnswerOf(s, data.run.error);
  if (noAnswer) out.noAnswer = noAnswer;
  if (!checkKindOf(s.nodeId)) {
    const id = stepNodeOf(s.nodeId).node.split(":").at(-1) ?? s.nodeId;
    const step = workflow?.schemaVersion === 4 ? processes.findStep(workflow, id)?.step : undefined;
    const approval = approvalOf(s, data.inbox, step?.checks?.approval?.mode ?? "in_turn");
    if (approval) {
      out.approval = {
        ...approval,
        approvers: approval.approvers.map((a) => ({
          ...a,
          name: a.role ? roleLabel(a.role) : "a named person",
        })),
      };
    }
    // Wave 5: the route an if took and why (by step name), and a failure the run carried on past.
    if (step && workflow?.schemaVersion === 4) {
      const route = routeOfRow(
        step,
        s,
        (nodeId) => outcomes.get(nodeId),
        (sid) => processes.findStep(workflow, sid)?.step.name,
      );
      if (route) out.route = route;
      if (carriedOn(step, s.outcome)) out.carriedOn = true;
    }
    if (s.outcome) out.outcome = s.outcome;
  }
  const urgent = urgentOf(s, data.inbox);
  if (urgent) out.urgent = urgent;
  return out;
}

function Timeline({
  data,
  workflow,
  rows,
  failedNode,
  oversight,
  wait,
  onConversation,
}: {
  data: RunDetail;
  workflow: RanWorkflow | null;
  rows: RunStepRow[];
  failedNode: string | null;
  oversight: Decision[];
  wait: Wait | null;
  // P-6: take a live conversation over, or end it (§1.68).
  onConversation?: (
    stepRunId: string,
    action: "take_over" | "end",
    reason: string,
  ) => Promise<void>;
}) {
  const { run } = data;
  const i18n = useI18n();
  const steps = new Map(data.steps.map((s) => [s.id, s]));
  // Wave 5: each row's outcome by node id, for the routes the run's ifs took.
  const outcomes = new Map(
    data.steps.flatMap((s) => (s.outcome ? [[s.nodeId, s.outcome] as const] : [])),
  );
  const done = rows.filter((r) => r.status === "succeeded").length;
  const items: StepItem[] = rows.map((r, i) => {
    const s = r.stepRunId ? steps.get(r.stepRunId) : undefined;
    const checks = s ? checksFor(s, data, workflow, outcomes) : {};
    const meta = [
      s ? duration(s.startedAt, s.finishedAt) : null,
      isZero(r.costUsd) ? null : usd(r.costUsd),
      s && (s.tokensIn || s.tokensOut)
        ? `${tokens(s.tokensIn)} in / ${tokens(s.tokensOut)} out`
        : null,
    ].filter(Boolean);
    const detail = [
      // A waiting step says what the top of the page says: "Waiting for approval · client admin".
      r.status === "waiting" && wait ? wait.line : r.detail,
      s?.models?.length ? `model ${s.models.join(", ")}` : null,
      r.status === "pending" || r.status === "waiting" || r.status === "succeeded"
        ? null
        : stepStatusLabel(r.status),
      r.internal ? "hidden from client" : null,
    ].filter(Boolean);
    const failed = r.status === "failed" || (failedNode !== null && s?.nodeId === failedNode);
    const decisions = s ? oversight.filter((d) => d.stepRunId === s.id) : [];
    // Wave 6: the owner's check on each attempt at this step (v4 read, skill and write steps).
    const ownerChecks = s ? (data.ownerChecks ?? []).filter((c) => c.nodeId === s.nodeId) : [];
    return {
      key: r.key,
      testId: `ops-run-step-${r.key}`,
      state: stepState(r, s?.nodeType, checks),
      time: r.at ? shortTime(r.at) : "next",
      title: (
        <span className="ops-step-head">
          <span className="flex flex-wrap items-center gap-2">
            <Tag>{r.kind}</Tag>
            <span className={failed ? "ui-tone-risk" : undefined}>
              {i > 0 ? `${i} · ` : ""}
              {checks.confer ? `${conferTitle(i18n, checks.confer)} · ${r.title}` : r.title}
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
              names={data.sourceNames}
            />
          ) : null}
          {/* R8: what the owner did here (§10.14 "Agents and their owner"). */}
          <StepChecks checks={checks} testId={`ops-run-step-checks-${r.key}`} />
          {decisions.map((d) => (
            <p key={d.id} className="text-sm text-ink" data-testid={`ops-run-owner-${d.id}`}>
              {ownerLine(d)}.
            </p>
          ))}
          <OwnerCheckLines
            checks={ownerChecks}
            runId={run.id}
            testId={`ops-run-owner-checks-${r.key}`}
          />
          {/* P-4: a conversation's transcript, each turn's model and cost (§1.66). */}
          {s?.conversation ? (
            <Transcript
              testId={`ops-run-conversation-${r.key}`}
              lines={[
                ...s.conversation.messages.map((m, k) => ({
                  key: `${m.turn}-${m.direction}-${k}`,
                  direction: m.direction,
                  who:
                    m.direction === "in"
                      ? (s.conversation?.who?.name ?? "Them")
                      : `Agent · message ${m.turn}`,
                  // P-6: an edited message shows the agent's original under what went (§1.68).
                  text: m.edited
                    ? `${m.text}\n\nEdited by ${actorName(m.edited.by)}. The agent wrote: ${m.edited.original ?? "(written when sent)"}`
                    : m.text,
                  when: m.at ? shortTime(m.at) : (CONVERSE_STATUS[m.status] ?? m.status),
                  meta:
                    m.direction === "out"
                      ? [m.model, m.costUsd && !isZero(m.costUsd) ? usd(m.costUsd) : null]
                          .filter(Boolean)
                          .join(" · ") || null
                      : null,
                })),
                // P-6: who took it over or ended it, and why; no model call (§1.68).
                ...(s.conversation.events ?? []).map((e, k) => ({
                  key: `event-${k}`,
                  direction: "out" as const,
                  who: actorName(e.by),
                  text: `${e.kind === "taken_over" ? "Took the conversation over" : "Ended the conversation"}${e.reason ? `: ${e.reason}` : ""}`,
                  when: shortTime(e.at),
                  meta: null,
                  person: true,
                })),
              ]}
            />
          ) : null}
          {s?.conversation &&
          s.conversation.outcome === null &&
          run.mode === "live" &&
          onConversation ? (
            <ConversationControls
              testId={`ops-run-conversation-control-${r.key}`}
              reasonRequired
              words={{
                takeOver: "Take over",
                end: "End conversation",
                reason: "Why (the client sees this)",
                hint: "Take over: the agent sends nothing more and the answer comes to you. End: the step's on-reject applies. Day to day this is the client's; step in only when you must.",
              }}
              onAct={(action, reason) => onConversation(s.id, action, reason)}
            />
          ) : null}
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

// P-4: a conversation message that hasn't gone yet, in plain words.
const CONVERSE_STATUS: Record<string, string> = {
  waiting_for_approval: "waiting for approval",
  held_for_quiet_hours: "held for quiet hours",
  not_approved: "not approved",
  not_sent: "not sent",
  sending: "sending",
  // P-6
  taken_over: "not sent: taken over",
  ended: "not sent: ended",
};

/** P-6: a person on a conversation's transcript: us by name, or the client's person. */
function actorName(by: { us: boolean; name: string | null }): string {
  return by.us ? `${by.name ?? "Mezonas"} (Mezonas)` : (by.name ?? "the client");
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
            `${toolLabel(c.tool)}   status: ${c.status}${c.durationMs === null ? "" : `   ${c.durationMs} ms`}`,
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
    ["Workflow", data.workflow?.name ?? run.workflowSlug],
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

/** "testkit.record.update:unauthorized" → "Testkit: record update · unauthorized". */
function errorKeyWords(key: string): string {
  const [tool = key, code] = key.split(":");
  return code ? `${toolLabel(tool)} · ${code.replace(/_/g, " ")}` : toolLabel(tool);
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
    <Card title="Same error elsewhere" meta={errorKeyWords(key)} testId="ops-run-same-error">
      {others.map((r) => (
        <Link
          key={r.id}
          to={`/ops/runs/${r.id}`}
          className="ops-row text-sm hover:bg-surface-subtle"
        >
          <span className="reference text-ink">{shortRunId(r.id)}</span>
          <span className="flex-1 text-ink-muted">{shortTime(r.startedAt ?? r.createdAt)}</span>
          <StatusChip state={runChip(r).state}>{runChip(r).words}</StatusChip>
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
          recordHref={(id) => `/ops/clients/${run.tenantId}/records/${id}`}
          onResolve={i.resolvableByOperator ? (body) => onResolve(i.id, body) : null}
          waitingOn={`${waitingWhat(i.kind)} · ${waitingOn(i)}. Only they can ${
            i.kind === "approval" ? "approve" : "answer"
          } it.`}
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
  const mine = item ? item.resolvableByOperator : false;
  const failure = action.error as { message?: unknown } | null;
  let text: string;
  if (testRun) text = "Test run: recorded as it would have been made, never written.";
  // The same words as the top of the page and the Timeline: "Waiting for approval · client admin".
  else if (waiting && item && !mine)
    text = `${waitingWhat(item.kind)} · ${waitingOn(item)}. Nothing changes in ${heading.connector} until then.`;
  else if (waiting) text = `Nothing changes in ${heading.connector} until you approve.`;
  else if (action.status === "failed")
    text = `The change failed: ${String(failure?.message ?? "unknown error")}`;
  else if (action.approvedAt)
    text = `Approved ${shortTime(action.approvedAt)}${action.approvedBy ? "" : " automatically"}.`;
  else text = "";
  return (
    <Card testId={`ops-run-action-${action.id}`}>
      <div className="ui-card__head">
        <div className="min-w-0">
          <h3 className="font-medium text-ink">{heading.title}</h3>
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
              Approve and update {heading.connector}
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
        The owner hasn't stepped in. When a step fails or reaches a checkpoint, the agent's owner
        decides what happens next, and it shows here.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="ops-run-oversight">
      {decisions.map((d) => (
        <Card
          key={d.id}
          title={`${OWNER_ACTION_WORDS[d.action]} ${OVERSIGHT_CAUSE_WORDS[d.cause]}`}
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
                  s.skillRef ? toolLabel(s.skillRef) : null,
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
                        <span className="text-ink">{toolLabel(c.tool)}</span>
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
