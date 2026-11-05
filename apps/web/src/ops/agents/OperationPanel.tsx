// A client agent's operation (ARCHITECTURE §9.3, §14 "Operation"; plan §1.2 "Client agent
// activation"): its service name and description in the portal, the connections it is bound to,
// its approver, and its run status: activate (with every reason it can't yet), pause, retire, and
// the test run activation needs. None of this is a new version: it is the agent row, logged.
import type { AgentBundle } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionSummary } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { isRunGoing } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Loading,
  SectionLabel,
  type Tone,
} from "../../ui/primitives";
import { GrantsPanel } from "./GrantsPanel";
import {
  detailMessages,
  errorText,
  Field,
  Notice,
  notifyAgentsChanged,
  Select,
  TextArea,
  TextInput,
  useAction,
} from "./ui";

type Connection = ResponseOf<typeof apiRoutes.opsClient>["connections"][number];

const RUN_STATUS_TONE: Record<string, Tone> = {
  active: "positive",
  paused: "neutral",
  retired: "neutral",
  draft: "neutral",
};

const APPROVERS: { value: "" | "client_admin" | "operator"; label: string }[] = [
  { value: "", label: "The client's setting" },
  { value: "client_admin", label: "The client's admin" },
  { value: "operator", label: "Us (the operator)" },
];

export function OperationPanel({
  agent,
  connections,
  live,
  liveBundle,
  onChanged,
}: {
  agent: AgentSummary;
  /** The client's connections (GET /api/ops/clients/:id). */
  connections: readonly Connection[];
  live: VersionSummary | null;
  liveBundle: AgentBundle | null;
  onChanged(): void;
}) {
  const activation = useApi(apiRoutes.opsActivation, { params: { id: agent.id } });
  const required = activation.data?.requiredConnectors ?? [];
  // DECISION: while the live version's latest test run is going, the activation check polls every
  // 2 s (the run page's rate, plan §1.2 "Live updates"), so it turns ready when the run passes.
  const testRun = activation.data?.testRun ?? null;
  usePoll(activation.reload, testRun ? isRunGoing(testRun.status) : false, 2_000);
  const [grantsVersion, setGrantsVersion] = useState(0);
  return (
    <div className="flex flex-col gap-5">
      <StatusCard
        agent={agent}
        activation={activation}
        live={live}
        liveBundle={liveBundle}
        onChanged={() => {
          activation.reload();
          onChanged();
        }}
      />
      <ServiceForm
        key={agent.id}
        agent={agent}
        connections={connections}
        required={required}
        onSaved={() => {
          activation.reload();
          onChanged();
          setGrantsVersion((n) => n + 1);
        }}
      />
      {/* Remounted after a binding change, so it lists what the agent is bound to now. */}
      <GrantsPanel key={`${agent.id}:${grantsVersion}`} agentId={agent.id} />
    </div>
  );
}

function StatusCard({
  agent,
  activation,
  live,
  liveBundle,
  onChanged,
}: {
  agent: AgentSummary;
  activation: ApiState<ResponseOf<typeof apiRoutes.opsActivation>>;
  live: VersionSummary | null;
  liveBundle: AgentBundle | null;
  onChanged(): void;
}) {
  const action = useAction();
  const [retiring, setRetiring] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const status = agent.runStatus ?? "draft";

  async function run(kind: "activate" | "pause" | "retire") {
    setRetiring(false);
    const route =
      kind === "activate"
        ? apiRoutes.opsActivate
        : kind === "pause"
          ? apiRoutes.opsPause
          : apiRoutes.opsRetire;
    const res = await action.call(route, { params: { id: agent.id } });
    if (res.ok) {
      setDone(
        kind === "activate"
          ? "Active: its triggers start runs now."
          : kind === "pause"
            ? "Paused: no new runs start; running ones finish."
            : "Retired: it never runs again. Its history stays.",
      );
      notifyAgentsChanged();
      onChanged();
    }
  }

  const problems = activation.data?.problems ?? [];
  const testRun = activation.data?.testRun ?? null;
  const testGoing = testRun ? isRunGoing(testRun.status) : false;
  return (
    <Card className="p-5" testId="agent-operation-status">
      <SectionLabel>
        <span className="flex items-center gap-2">
          Status
          <Badge tone={RUN_STATUS_TONE[status] ?? "neutral"} testId="agent-run-status">
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </Badge>
        </span>
      </SectionLabel>

      {agent.testCopy ? (
        <p className="mb-3 text-ink">
          A template's test copy in this client: it only test-runs, and is never activated. Fork the
          template into the client to run it there.
        </p>
      ) : null}

      {activation.error ? (
        <ErrorNotice error={activation.error} onRetry={activation.reload} />
      ) : null}
      {!activation.data && !activation.error ? <Loading label="Checking activation…" /> : null}
      {testRun && live && status !== "retired" && (testGoing || testRun.status === "failed") ? (
        <p
          className="mb-3 text-ink"
          data-testid={testGoing ? "agent-activation-test-running" : "agent-activation-test-failed"}
        >
          {testGoing
            ? `A test run of v${live.version} is going. We check again when it finishes.`
            : `The last test run of v${live.version} failed.`}{" "}
          <Link to={`/ops/runs/${testRun.id}`} className="text-link underline">
            Open the run
          </Link>
        </p>
      ) : null}
      {activation.data && status !== "active" && status !== "retired" ? (
        problems.length === 0 ? (
          <p className="text-ink" data-testid="agent-activation-ready">
            Ready to activate: connections bound, live version valid and tested on this client.
          </p>
        ) : (
          <div data-testid="agent-activation-problems">
            <p className="mb-1.5 text-ink">Before it can be activated:</p>
            <ul className="list-disc pl-5 text-ink">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      {done ? (
        <div className="mt-3">
          <Notice tone="positive" testId="agent-operation-done">
            {done}
          </Notice>
        </div>
      ) : null}
      {action.error ? (
        <div className="mt-3">
          <Notice tone="warning" testId="agent-operation-error">
            {errorText(action.error)}
            {detailMessages(action.error).length > 1 ? (
              <ul className="mt-2 list-disc pl-5">
                {detailMessages(action.error).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {status === "active" ? (
          <Button data-testid="agent-pause" disabled={action.busy} onClick={() => run("pause")}>
            Pause
          </Button>
        ) : status !== "retired" ? (
          <Button
            variant="primary"
            data-testid="agent-activate"
            disabled={action.busy || !activation.data?.ready || agent.testCopy}
            onClick={() => run("activate")}
          >
            Activate
          </Button>
        ) : null}
        {status !== "retired" ? (
          retiring ? (
            <Button
              data-testid="agent-retire-confirm"
              disabled={action.busy}
              onClick={() => run("retire")}
            >
              Retire for good?
            </Button>
          ) : (
            <Button variant="ghost" data-testid="agent-retire" onClick={() => setRetiring(true)}>
              Retire
            </Button>
          )
        ) : null}
        <Button variant="ghost" data-testid="agent-activation-recheck" onClick={activation.reload}>
          Check again
        </Button>
      </div>

      {status !== "retired" ? (
        <TestRun agent={agent} live={live} liveBundle={liveBundle} onStarted={activation.reload} />
      ) : null}
    </Card>
  );
}

function TestRun({
  agent,
  live,
  liveBundle,
  onStarted,
}: {
  agent: AgentSummary;
  live: VersionSummary | null;
  liveBundle: AgentBundle | null;
  /** The activation check reloads, sees the run and polls it. */
  onStarted(): void;
}) {
  const workflows = liveBundle?.workflows ?? [];
  const [workflow, setWorkflow] = useState(workflows[0]?.slug ?? "");
  const [payload, setPayload] = useState("{}");
  const [started, setStarted] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const action = useAction();

  if (!live || !liveBundle) {
    return (
      <p className="mt-4 text-sm text-ink-muted">
        Publish a version, then test-run it here: activation needs one passing test run of the live
        version on this client.
      </p>
    );
  }
  if (workflows.length === 0) {
    return (
      <p className="mt-4 text-sm text-ink-muted">v{live.version} has no workflows to test-run.</p>
    );
  }

  async function start() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload || "{}");
      setParseError(null);
    } catch {
      setParseError("The input must be JSON, e.g. {}.");
      return;
    }
    if (!live) return;
    const res = await action.call(apiRoutes.opsTestRun, {
      params: { id: agent.id, vid: live.id },
      body: { workflow, payload: parsed },
    });
    if (res.ok) {
      setStarted(res.data.runId);
      onStarted();
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-4" data-testid="agent-test-run">
      <p className="mb-3 text-sm text-ink-muted">
        Test run of the live version v{live.version} on this client's data. It never changes the
        client's tools: what it would do is recorded as proposed.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_1fr_auto] md:items-end">
        <Field label="Workflow">
          <Select
            data-testid="agent-test-run-workflow-select"
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
          >
            {workflows.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Input (JSON)" error={parseError ?? undefined}>
          <TextInput
            data-testid="agent-test-run-payload-input"
            className="font-mono text-sm"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </Field>
        <Button
          data-testid="agent-test-run-start"
          disabled={action.busy || !workflow}
          onClick={start}
        >
          Test-run v{live.version}
        </Button>
      </div>
      {started ? (
        <p className="mt-3 text-sm text-ink" data-testid="agent-test-run-started">
          Started.{" "}
          <Link to={`/ops/runs/${started}`} className="text-link underline">
            Open the run
          </Link>
          . Activation updates when it finishes.
        </p>
      ) : null}
      {action.error ? (
        <div className="mt-3">
          <Notice tone="warning">{errorText(action.error)}</Notice>
        </div>
      ) : null}
    </div>
  );
}

function ServiceForm({
  agent,
  connections,
  required,
  onSaved,
}: {
  agent: AgentSummary;
  connections: readonly Connection[];
  required: readonly string[];
  onSaved(): void;
}) {
  const [serviceName, setServiceName] = useState(agent.serviceName ?? "");
  const [serviceDescription, setServiceDescription] = useState(agent.serviceDescription ?? "");
  const [approver, setApprover] = useState<"" | "client_admin" | "operator">(
    agent.approver === "client_admin" || agent.approver === "operator" ? agent.approver : "",
  );
  const [bindings, setBindings] = useState<Record<string, string>>(agent.bindings);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  // Connections told apart by a site (website logins) bind by `<connector>:<site>`, one row each
  // (docs/plan.md §1.26 "Binding browser sites"); every other connector binds by its id.
  const keyOf = (x: Connection) =>
    typeof x.config.site === "string" ? `${x.connector}:${x.config.site}` : x.connector;
  const connectors = [
    ...new Set([
      ...required.flatMap((c) => {
        const sited = connections.filter((x) => x.connector === c && keyOf(x) !== c);
        return sited.length > 0 ? sited.map(keyOf) : [c];
      }),
      ...Object.keys(agent.bindings),
    ]),
  ].sort();

  async function save() {
    setSaved(false);
    const res = await action.call(apiRoutes.opsOperation, {
      params: { id: agent.id },
      body: {
        serviceName: serviceName.trim() || null,
        serviceDescription: serviceDescription.trim() || null,
        approver: approver || null,
        bindings: Object.fromEntries(Object.entries(bindings).filter(([, id]) => id)),
      },
    });
    if (res.ok) {
      setSaved(true);
      notifyAgentsChanged();
      onSaved();
    }
  }

  return (
    <Card className="p-5" testId="agent-operation">
      <SectionLabel>Operation</SectionLabel>
      <p className="mb-4 text-sm text-ink-muted">
        These apply at once and are not a new version. Every change is logged.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Service name" hint="What the client sees in the portal.">
          <TextInput
            data-testid="agent-operation-service-name-input"
            value={serviceName}
            onChange={(e) => setServiceName(e.target.value)}
          />
        </Field>
        <Field label="Approver" hint="Who approves its steps unless a step names someone.">
          <Select
            data-testid="agent-operation-approver-select"
            value={approver}
            onChange={(e) => setApprover(e.target.value as typeof approver)}
          >
            {APPROVERS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Service description"
          className="md:col-span-2"
          hint="What it does, in plain language, for the portal."
        >
          <TextArea
            data-testid="agent-operation-service-description-input"
            rows={2}
            value={serviceDescription}
            onChange={(e) => setServiceDescription(e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-5">
        <p className="mb-2 text-sm font-medium text-ink">Connections it works in</p>
        {connectors.length === 0 ? (
          <p className="text-sm text-ink-muted">Its live version needs no connections.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {connectors.map((c) => {
              const options = connections.filter((x) => keyOf(x) === c);
              return (
                <div
                  key={c}
                  className="grid grid-cols-1 items-center gap-2 md:grid-cols-[220px_1fr]"
                >
                  <span className="flex items-center gap-2 text-base text-ink">
                    {c}
                    {required.includes(c.split(":")[0] ?? c) ? (
                      <Badge tone="neutral">Needed</Badge>
                    ) : null}
                  </span>
                  <Select
                    data-testid={`agent-operation-binding-${c}-select`}
                    value={bindings[c] ?? ""}
                    onChange={(e) => setBindings((b) => ({ ...b, [c]: e.target.value }))}
                  >
                    <option value="">
                      {options.length ? "Not bound" : "This client has no such connection yet"}
                    </option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.externalAccountId ?? c} · {o.status}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {saved ? (
        <div className="mt-4">
          <Notice tone="positive" testId="agent-operation-saved">
            Saved.
          </Notice>
        </div>
      ) : null}
      {action.error ? (
        <div className="mt-4">
          <Notice tone="warning" testId="agent-operation-save-error">
            {errorText(action.error)}
          </Notice>
        </div>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button
          variant="primary"
          data-testid="agent-operation-save"
          disabled={action.busy}
          onClick={save}
        >
          {action.busy ? "Saving…" : "Save operation"}
        </Button>
      </div>
    </Card>
  );
}
