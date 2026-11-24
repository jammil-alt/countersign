// The client page's Agents › Sandbox (`/ops/clients/:clientId/sandbox`, docs/plan.md §1.243): run
// one of the client's own agents on its real data as a test run that writes nothing (invariant 8),
// today's use, and every sandbox run of the client's, from either side, newest first. A run's page
// (`…/sandbox/:runId`) shows its steps, what it would do and the notices it would send, the same
// view the client has. "Send to me" is ours only in the Sandbox client: in a real client only the
// client's own people send from its tools, and the server says so on each change.
import type { AnyAgentBundle, SandboxRunSummary } from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { EN } from "../../i18n/i18n";
import { usePoll } from "../../runs/usePoll";
import { SandboxRunBody } from "../../sandbox/SandboxRunBody";
import { useShownRun } from "../../sandbox/useShownRun";
import { SANDBOX_CHIP, type SandboxWords, sandboxWords } from "../../sandbox/words";
import { Loaded, Section } from "../../ui/page";
import { Button, Card, EmptyState, ErrorNotice } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { StatusChip } from "../../ui/status";
import {
  JSON_INPUT_PROPS,
  type PayloadSource,
  PayloadSourceSelect,
  parsePayload,
  payloadFor,
  samplePayload,
  triggerEventType,
  useRecentEvents,
} from "../agents/TestPayload";
import { Field, Notice, Select, TextArea } from "../agents/ui";
import { OPS_PATHS } from "../paths";
import { parseAnyBundle } from "../versions";
import { ClientFrame, useClientPage } from "./ClientFrame";

/** How often a running sandbox run, or a list with one, is read again. */
const POLL_MS = 2000;

/**
 * The view's words in English, speaking of the client's tools rather than to the client; the
 * rest are the portal's English words (`EN`).
 */
export const OPS_SANDBOX_WORDS: SandboxWords = {
  ...sandboxWords(EN),
  notWritten: "A test run. Nothing was written to the client's tools and nothing was sent.",
  noChanges: "It wouldn't change anything in the client's tools.",
  sendTo: (channel, to) =>
    channel === "email"
      ? `From the client's mailbox to ${to}, and nobody else.`
      : `From the client's number to ${to}, and nobody else.`,
};

const SIDE_WORDS: Record<SandboxRunSummary["side"], string> = {
  portal: "Portal",
  ops: "Back office",
};

/** The client's own agents that can run in its sandbox: no template test copies, none retired. */
export function sandboxAgents(agents: readonly AgentSummary[]): AgentSummary[] {
  return agents.filter((a) => a.kind === "client" && !a.testCopy && a.status !== "retired");
}

export function OpsClientSandboxScreen() {
  const { clientId = "" } = useParams();
  const view = useApi(apiRoutes.opsSandbox, { params: { id: clientId } });
  const going = view.data?.runs.some((r) => r.status === "running") ?? false;
  usePoll(view.reload, going, POLL_MS, view.loading);
  return (
    <ClientFrame
      clientId={clientId}
      intro="Run one of the client's agents on its real data and see what it would do. Nothing is written to its tools and nothing is sent."
    >
      <Loaded state={view} skeleton={<SkeletonRows rows={5} columns={1} />}>
        {(v) => (
          <div className="flex flex-col gap-8" data-testid="ops-sandbox">
            {v.canSend ? null : (
              <Notice tone="neutral" testId="ops-sandbox-no-send">
                Only the client's own people can send from its tools, so Send to me is theirs here.
                You can read every message as it would arrive.
              </Notice>
            )}
            <StartForm
              clientId={clientId}
              used={v.use.runs}
              max={v.use.maxRuns}
              onStarted={view.reload}
            />
            <RunsTable clientId={clientId} runs={v.runs} />
          </div>
        )}
      </Loaded>
    </ClientFrame>
  );
}

function StartForm({
  clientId,
  used,
  max,
  onStarted,
}: {
  clientId: string;
  used: number;
  max: number;
  onStarted: () => void;
}) {
  const { data } = useClientPage();
  const agents = sandboxAgents(data?.agents ?? []);
  const [agentId, setAgentId] = useState<string>("");
  const chosen = agents.find((a) => a.id === agentId) ?? agents[0];
  const usedUp = used >= max;
  return (
    <Section
      title="Run in the sandbox"
      meta={
        <span data-testid="ops-sandbox-use">
          {used} of {max} runs today{usedUp ? ". That's all for today." : ""}
        </span>
      }
      testId="ops-sandbox-start"
    >
      {!data ? (
        <SkeletonRows rows={2} columns={1} />
      ) : agents.length === 0 || !chosen ? (
        <EmptyState compact line="The client has no agents to run in the sandbox yet." />
      ) : (
        <Card pad>
          <div className="flex flex-col gap-3">
            <Field label="Agent">
              <Select
                data-testid="ops-sandbox-agent"
                value={chosen.id}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.serviceName ?? a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <AgentRunForm
              key={chosen.id}
              clientId={clientId}
              agent={chosen}
              disabled={usedUp}
              onStarted={onStarted}
            />
          </div>
        </Card>
      )}
    </Section>
  );
}

/** The chosen agent's live version (else its latest), a workflow of it and its input. */
function AgentRunForm({
  clientId,
  agent,
  disabled,
  onStarted,
}: {
  clientId: string;
  agent: AgentSummary;
  disabled: boolean;
  onStarted: () => void;
}) {
  const detail = useApi(apiRoutes.opsAgent, { params: { id: agent.id } });
  return (
    <Loaded state={detail} skeleton={<SkeletonRows rows={2} columns={1} />}>
      {(d) => {
        const version = d.live ?? d.latest;
        if (!version) {
          return <p className="text-sm text-ink-muted">This agent has no version to run yet.</p>;
        }
        const parsed = parseAnyBundle(version);
        if (!parsed.ok) return <Notice tone="warning">{parsed.message}</Notice>;
        const workflows = parsed.bundle.workflows ?? [];
        if (workflows.length === 0) {
          return (
            <p className="text-sm text-ink-muted">v{version.version} has no workflows to run.</p>
          );
        }
        return (
          <WorkflowInput
            clientId={clientId}
            agent={agent}
            versionId={version.id}
            versionLabel={`v${version.version}${d.live ? " (live)" : " (latest draft)"}`}
            workflows={workflows}
            disabled={disabled}
            onStarted={onStarted}
          />
        );
      }}
    </Loaded>
  );
}

type Workflows = NonNullable<AnyAgentBundle["workflows"]>;

function WorkflowInput({
  clientId,
  agent,
  versionId,
  versionLabel,
  workflows,
  disabled,
  onStarted,
}: {
  clientId: string;
  agent: AgentSummary;
  versionId: string;
  versionLabel: string;
  workflows: Workflows;
  disabled: boolean;
  onStarted: () => void;
}) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState(workflows[0]?.slug ?? "");
  // Blank means `{}` (the placeholder), as the test run's box.
  const [payload, setPayload] = useState("");
  const [source, setSource] = useState<PayloadSource>("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const parsed = parsePayload(payload);
  const catalog = useApi(apiRoutes.opsEventCatalog, { life: "catalog" });
  const chosen = workflows.find((w) => w.slug === workflow)?.workflow ?? null;
  const eventType = triggerEventType(chosen);
  const sample = chosen && catalog.data ? samplePayload(chosen, catalog.data.events) : undefined;
  const recent = useRecentEvents(clientId, eventType);

  function choose(next: PayloadSource) {
    setSource(next);
    const filled = payloadFor(next, sample, recent.data?.events ?? []);
    if (filled !== null) setPayload(filled);
  }

  async function start() {
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsTestRun, {
        params: { id: agent.id, vid: versionId },
        body: { workflow, payload: parsed.value, sandbox: true },
      });
      onStarted();
      navigate(OPS_PATHS.clientSandboxRun(clientId, out.runId));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="ops-sandbox-form">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_1fr] md:items-end">
        <Field label="Workflow">
          <Select
            data-testid="ops-sandbox-workflow"
            value={workflow}
            onChange={(e) => {
              setWorkflow(e.target.value);
              // Another workflow's trigger: its own sample and events.
              setSource("manual");
              setPayload("");
            }}
          >
            {workflows.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Input from">
          <PayloadSourceSelect
            testId="ops-sandbox-source"
            value={source}
            hasSample={sample !== undefined}
            eventType={eventType}
            recent={recent}
            onChange={choose}
          />
        </Field>
      </div>
      <Field
        label="Input (JSON)"
        error={parsed.ok ? undefined : "The input must be JSON, e.g. {}."}
      >
        <TextArea
          {...JSON_INPUT_PROPS}
          data-testid="ops-sandbox-payload"
          invalid={!parsed.ok}
          className="font-mono text-sm"
          rows={source === "manual" ? 2 : 6}
          value={payload}
          onChange={(e) => {
            setPayload(e.target.value);
            setSource("manual");
          }}
        />
      </Field>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          data-testid="ops-sandbox-start-button"
          disabled={disabled || !workflow || !parsed.ok}
          working={busy}
          onClick={start}
        >
          {busy ? "Starting…" : "Run in the sandbox"}
        </Button>
        <span className="text-sm text-ink-muted">Runs {versionLabel}. It writes nothing.</span>
      </div>
    </div>
  );
}

function RunsTable({ clientId, runs }: { clientId: string; runs: SandboxRunSummary[] }) {
  const words = OPS_SANDBOX_WORDS;
  return (
    <Section
      title="Sandbox runs"
      meta="From the portal and the back office"
      testId="ops-sandbox-runs"
    >
      {runs.length === 0 ? (
        <EmptyState compact line="No sandbox runs yet." />
      ) : (
        <div className="ds-card dt dt-ana overflow-x-auto">
          <table data-testid="ops-sandbox-runs-table">
            <thead>
              <tr className="dt-cols">
                <th>Run</th>
                <th>Agent</th>
                <th>Started by</th>
                <th>Status</th>
                <th>What it would do</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} data-testid={`ops-sandbox-run-${r.runId}`}>
                  <td>
                    <Link
                      to={OPS_PATHS.clientSandboxRun(clientId, r.runId)}
                      className="text-ink hover:underline"
                    >
                      {r.title}
                    </Link>
                  </td>
                  <td>{r.agentName}</td>
                  <td className="text-ink-muted">
                    {[r.byName, SIDE_WORDS[r.side]].filter(Boolean).join(" · ")}
                  </td>
                  <td>
                    <StatusChip state={SANDBOX_CHIP[r.status]}>
                      {words.runStatus[r.status]}
                    </StatusChip>
                  </td>
                  <td className="text-ink-muted">
                    {EN.t("sandbox.changes", { count: r.changes })} ·{" "}
                    {EN.t("sandbox.messages", { count: r.messages })}
                  </td>
                  <td className="text-ink-muted">{EN.fmt.time(r.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ── One run ──────────────────────────────────────────────────────────────────────────────────

export function OpsClientSandboxRunScreen() {
  const { clientId = "", runId = "" } = useParams();
  const api = useApiClient();
  const view = useApi(apiRoutes.opsSandboxRun, { params: { id: clientId, runId } });
  const { run, answered } = useShownRun(view.data?.run);
  usePoll(view.reload, run?.status === "running", POLL_MS, view.loading);
  const words = OPS_SANDBOX_WORDS;

  async function send(changeId: string): Promise<void> {
    const out = await api.call(apiRoutes.opsSandboxSend, {
      params: { id: clientId, runId, changeId },
    });
    answered(out.run);
  }

  return (
    <ClientFrame clientId={clientId}>
      <div className="flex flex-col gap-4" data-testid="ops-sandbox-run">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              to={OPS_PATHS.clientSandbox(clientId)}
              className="text-sm text-link hover:underline"
              data-testid="ops-sandbox-run-back"
            >
              Sandbox
            </Link>
            <h2 className="type-heading text-ink">{run?.title ?? "Sandbox run"}</h2>
            {run ? (
              <p className="text-sm text-ink-muted">
                {[run.agentName, run.byName, SIDE_WORDS[run.side], EN.fmt.time(run.startedAt)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {run ? (
              <StatusChip state={SANDBOX_CHIP[run.status]} testId="ops-sandbox-run-status">
                {words.runStatus[run.status]}
              </StatusChip>
            ) : null}
            {/* The full run, with what only we see. */}
            <Link to={`/ops/runs/${runId}`} className="text-sm text-link hover:underline">
              Open the full run
            </Link>
          </div>
        </div>
        <Loaded state={view} skeleton={<SkeletonRows rows={6} columns={1} />}>
          {() => (run ? <SandboxRunBody run={run} words={words} onSend={send} /> : null)}
        </Loaded>
      </div>
    </ClientFrame>
  );
}
