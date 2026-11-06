// The agent page's Tests tab: the test bench (ARCHITECTURE §9.10, §14 "Tests"; docs/plan.md §1.46).
// A template's cases (shared, and each served client's) run against a version and never write:
// pass rate, precision on label fields and cost per case. A client agent shows its template's
// cases from this client, runs them on the template's live version in this client, and lists its
// own test runs with a form to start one. Cases, results and cost are the back office's only.
import {
  type AgentBundle,
  Matcher,
  type SuiteRunView,
  type TestCaseView,
  testCaseProblems,
} from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionSummary } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { runStatusLabel, runStatusTone, shortTime } from "../../runs/format";
import { ProgressBar } from "../../ui/figures";
import { Loaded } from "../../ui/page";
import { Badge, Button, Card, ErrorNotice, Loading, Tag } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { cost } from "../../usage/format";
import { TestRun } from "./OperationPanel";
import { JSON_INPUT_PROPS, parsePayload } from "./TestPayload";
import { errorText, Field, Notice, plural, Select, TextArea, TextInput, useAction } from "./ui";

type AgentDetail = ResponseOf<typeof apiRoutes.opsAgent>;

/** "97.1%": a share (0..1) as a percentage. */
function percent(share: number): string {
  return `${(Math.round(share * 1000) / 10).toFixed(1)}%`;
}

function suiteChip(run: SuiteRunView): { state: ChipState; words: string } {
  if (run.status === "running") return { state: "running", words: "Running" };
  if (run.status === "failed") return { state: "failed", words: "Didn't finish" };
  return run.failed > 0
    ? { state: "failed", words: `${run.failed} failed` }
    : { state: "done", words: "All pass" };
}

/**
 * A suite run in figures: "42 of 44 pass", a bar, precision on labels and cost per case. The lab
 * and the Tests tab both show it.
 */
export function SuiteSummary({
  cases,
  run,
  testId,
}: {
  cases: number;
  run: SuiteRunView | null;
  testId?: string;
}) {
  if (!run) {
    return (
      <div className="flex flex-col gap-2" data-testid={testId}>
        <p className="text-sm text-ink">
          {cases === 0 ? "No test cases yet." : `${plural(cases, "case")}, not run yet.`}
        </p>
        <p className="text-sm text-ink-muted">Test runs never write to a client's tools.</p>
      </div>
    );
  }
  const precision = run.metrics?.precision ?? null;
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink">
          {run.version ? `v${run.version}` : "A version"} · {shortTime(run.createdAt)}
        </span>
        <b className="figures text-ink">
          {run.status === "running" ? "Running" : `${run.passed} of ${run.total} pass`}
        </b>
      </div>
      <ProgressBar
        value={run.passed}
        max={Math.max(run.total, 1)}
        label={`${run.passed} of ${run.total} cases pass`}
      />
      {precision !== null ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-ink">Precision on labels</span>
          <b className="figures text-ink">{percent(precision)}</b>
        </div>
      ) : null}
      {run.metrics ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-ink">Cost per case</span>
          <b className="figures text-ink">{cost(run.metrics.costPerCase)}</b>
        </div>
      ) : null}
      <p className="text-sm text-ink-muted">Test runs never write to a client's tools.</p>
    </div>
  );
}

export function TestsTab({
  agent,
  detail,
  liveBundle,
  base,
}: {
  agent: AgentSummary;
  detail: AgentDetail;
  /** The live version's bundle, read: what a client agent's test run runs. */
  liveBundle: AgentBundle | null;
  base: string;
}) {
  const templateId = agent.kind === "template" ? agent.id : agent.templateId;
  const clientId = agent.kind === "client" ? (agent.tenantId ?? undefined) : undefined;
  return (
    <div className="flex flex-col gap-6" data-testid="agent-tests">
      {templateId ? (
        <TestBench
          agent={agent}
          templateId={templateId}
          clientId={clientId}
          latest={agent.kind === "template" ? detail.latest : null}
          bundle={(detail.latest ?? detail.live)?.bundle ?? null}
        />
      ) : (
        <Card title="Test bench" pad>
          <p className="text-sm text-ink-muted">
            Test cases belong to a template or a skill. This agent was written for this client from
            no template, so it has none: test it with test runs below, or promote it into a
            template.
          </p>
        </Card>
      )}
      {agent.kind === "client" ? (
        <TestRunsCard agent={agent} detail={detail} liveBundle={liveBundle} base={base} />
      ) : null}
    </div>
  );
}

function TestBench({
  agent,
  templateId,
  clientId,
  latest,
  bundle,
}: {
  agent: AgentSummary;
  templateId: string;
  clientId: string | undefined;
  /** A template's latest version: what Run tests runs. */
  latest: VersionSummary | null;
  /** The workflows a new case can name. */
  bundle: unknown;
}) {
  const tests = useApi(apiRoutes.opsTests, {
    query: { target: `template:${templateId}`, ...(clientId ? { client: clientId } : {}) },
  });
  // A client agent's cases run on its template's live version.
  const template = useApi(
    apiRoutes.opsAgent,
    agent.kind === "client" ? { params: { id: templateId } } : null,
  );
  const version: VersionSummary | null =
    agent.kind === "template" ? latest : (template.data?.live ?? null);
  const caseBundle = agent.kind === "template" ? bundle : (template.data?.live?.bundle ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const run = useAction();

  async function runTests() {
    if (!version) return;
    const res = await run.call(apiRoutes.opsRunTests, {
      body: {
        targetKind: "template",
        targetId: templateId,
        versionId: version.id,
        ...(clientId ? { clientId } : {}),
      },
    });
    if (res.ok) {
      setSelected(res.data.suiteRun.id);
      tests.reload();
    }
  }

  return (
    <Loaded state={tests}>
      {(data) => {
        const cases = data.cases.filter((c) => !c.archivedAt);
        const latestRun = data.runs[0] ?? null;
        return (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
              <Card
                title="Suite runs"
                testId="agent-test-suite-runs"
                meta={
                  <Button
                    size="sm"
                    data-testid="agent-tests-run"
                    disabled={run.busy || !version || cases.length === 0}
                    title={
                      cases.length === 0
                        ? "Add a case first."
                        : !version
                          ? "Publish a version first."
                          : undefined
                    }
                    onClick={runTests}
                  >
                    {run.busy ? "Running…" : version ? `Run v${version.version}` : "Run tests"}
                  </Button>
                }
              >
                {run.error ? (
                  <div className="px-6 pt-4">
                    <Notice tone="warning" testId="agent-tests-run-error">
                      {errorText(run.error)}
                    </Notice>
                  </div>
                ) : null}
                {data.runs.length === 0 ? (
                  <p className="px-6 py-5 text-sm text-ink-muted">
                    No suite runs yet. Each run tries every case on one version and records what it
                    got.
                  </p>
                ) : (
                  <div className="dt dt-ana overflow-x-auto rounded-none border-x-0 border-b-0">
                    <table>
                      <thead>
                        <tr className="dt-cols">
                          <th>Started</th>
                          <th>Version</th>
                          <th>Result</th>
                          <th className="n">Passed</th>
                          <th className="n">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.runs.map((r) => {
                          const chip = suiteChip(r);
                          return (
                            <tr
                              key={r.id}
                              data-testid={`agent-test-suite-${r.id}`}
                              className={r.id === selected ? "[&>td]:bg-slate-tint" : undefined}
                            >
                              <td className="figures">
                                <button
                                  type="button"
                                  className="text-link hover:underline"
                                  onClick={() => setSelected(r.id)}
                                >
                                  {shortTime(r.createdAt)}
                                </button>
                              </td>
                              <td className="figures">{r.version ? `v${r.version}` : "—"}</td>
                              <td>
                                <StatusChip state={chip.state}>{chip.words}</StatusChip>
                              </td>
                              <td className="n figures">
                                {r.passed} of {r.total}
                              </td>
                              <td className="n figures">{cost(r.costUsd)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              <Card title="Latest" pad>
                <SuiteSummary cases={cases.length} run={latestRun} testId="agent-tests-summary" />
              </Card>
            </div>
            {selected ? <SuiteResults id={selected} /> : null}
            <CasesCard
              cases={cases}
              templateId={templateId}
              clientId={clientId}
              bundle={caseBundle}
              onChanged={tests.reload}
            />
          </div>
        );
      }}
    </Loaded>
  );
}

function SuiteResults({ id }: { id: string }) {
  const res = useApi(apiRoutes.opsTestSuiteRun, { params: { id } });
  return (
    <Card title="What each case got" testId="agent-test-results">
      {res.error ? (
        <div className="px-6 py-4">
          <ErrorNotice error={res.error} onRetry={res.reload} />
        </div>
      ) : null}
      {!res.data && !res.error ? (
        <div className="px-6">
          <Loading />
        </div>
      ) : null}
      {res.data ? (
        res.data.results.length === 0 ? (
          <p className="px-6 py-5 text-sm text-ink-muted">No results yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {res.data.results.map((r) => (
              <li
                key={r.id}
                className="px-6 py-3"
                data-testid={`agent-test-result-${r.testCaseId}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-ink">
                    {r.name}
                    {r.required ? null : <Tag>Optional</Tag>}
                  </span>
                  <span className="flex items-center gap-3">
                    {r.runId ? (
                      <Link to={`/ops/runs/${r.runId}`} className="text-sm text-link underline">
                        Open the run
                      </Link>
                    ) : null}
                    <StatusChip
                      state={r.status === "pass" ? "done" : "failed"}
                      testId={`agent-test-result-${r.testCaseId}-status`}
                    >
                      {r.status === "pass" ? "Pass" : r.status === "fail" ? "Fail" : "Error"}
                    </StatusChip>
                  </span>
                </div>
                {r.status !== "pass" && r.diff != null ? (
                  <pre className="mt-2 overflow-x-auto rounded-sm border border-line bg-surface-subtle p-3 reference text-ink">
                    {JSON.stringify(r.diff, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}

function CasesCard({
  cases,
  templateId,
  clientId,
  bundle,
  onChanged,
}: {
  cases: TestCaseView[];
  templateId: string;
  clientId: string | undefined;
  bundle: unknown;
  onChanged(): void;
}) {
  const [adding, setAdding] = useState(false);
  const archive = useAction();
  return (
    <Card
      title={`Cases · ${cases.length}`}
      testId="agent-test-cases"
      meta={
        adding ? null : (
          <Button size="sm" data-testid="agent-test-case-add" onClick={() => setAdding(true)}>
            Add a case
          </Button>
        )
      }
    >
      {adding ? (
        <NewCase
          templateId={templateId}
          clientId={clientId}
          bundle={bundle}
          onDone={(saved) => {
            setAdding(false);
            if (saved) onChanged();
          }}
        />
      ) : null}
      {archive.error ? (
        <div className="px-6 pt-4">
          <Notice tone="warning">{errorText(archive.error)}</Notice>
        </div>
      ) : null}
      {cases.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          No cases yet. A case is a trigger payload and the step outputs it should give.
        </p>
      ) : (
        <div className="dt dt-ana overflow-x-auto rounded-none border-x-0 border-b-0">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Case</th>
                <th>Data</th>
                <th>Made by</th>
                <th>Required</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} data-testid={`agent-test-case-${c.id}`}>
                  <td className="text-ink">{c.name}</td>
                  <td>{c.clientName ?? "Shared (made-up data)"}</td>
                  <td>
                    {c.source === "run"
                      ? "From a run"
                      : c.source === "builder"
                        ? "Builder"
                        : "By hand"}
                  </td>
                  <td>{c.required ? "Yes" : "No"}</td>
                  <td className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`agent-test-case-${c.id}-archive`}
                      disabled={archive.busy}
                      onClick={async () => {
                        const res = await archive.call(apiRoutes.opsArchiveTest, {
                          params: { id: c.id },
                        });
                        if (res.ok) onChanged();
                      }}
                    >
                      Archive
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function workflowsOf(bundle: unknown): { slug: string; name: string }[] {
  const b = bundle as Partial<AgentBundle> | null;
  return Array.isArray(b?.workflows)
    ? b.workflows.map((w) => ({ slug: w.slug, name: w.name }))
    : [];
}

function NewCase({
  templateId,
  clientId,
  bundle,
  onDone,
}: {
  templateId: string;
  clientId: string | undefined;
  bundle: unknown;
  onDone(saved: boolean): void;
}) {
  const workflows = workflowsOf(bundle);
  const [name, setName] = useState("");
  const [workflow, setWorkflow] = useState(workflows[0]?.slug ?? "");
  const [payload, setPayload] = useState("");
  const [expected, setExpected] = useState("");
  const [required, setRequired] = useState(true);
  const [problems, setProblems] = useState<string[]>([]);
  const action = useAction();

  async function save() {
    const p = parsePayload(payload);
    const e = parsePayload(expected);
    const found: string[] = [];
    if (!name.trim()) found.push("Name the case.");
    if (!p.ok) found.push("The payload must be JSON, e.g. {}.");
    if (!e.ok) found.push("The expected outputs must be JSON, by step id.");
    if (p.ok && e.ok) {
      found.push(
        ...testCaseProblems("template", {
          input: { workflow, payload: p.value },
          expected: e.value,
          matcher: Matcher.parse({}),
        }).map((m) => `${m.charAt(0).toUpperCase()}${m.slice(1)}.`),
      );
    }
    setProblems(found);
    if (found.length > 0 || !p.ok || !e.ok) return;
    const res = await action.call(apiRoutes.opsCreateTest, {
      body: {
        targetKind: "template",
        targetId: templateId,
        ...(clientId ? { clientId } : {}),
        name: name.trim(),
        input: { workflow, payload: p.value },
        expected: e.value,
        required,
      },
    });
    if (res.ok) onDone(true);
  }

  return (
    <div
      className="flex flex-col gap-4 border-b border-line px-6 py-5"
      data-testid="agent-test-case-new"
    >
      <p className="text-sm text-ink-muted">
        {clientId
          ? "A case from this client's data: it runs and shows in this client only."
          : "A shared case, on made-up data: it runs for every version of this template."}
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name">
          <TextInput
            data-testid="agent-test-case-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Workflow">
          <Select
            data-testid="agent-test-case-workflow-select"
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
        <Field label="Trigger payload (JSON)" hint="Blank means {}.">
          <TextArea
            {...JSON_INPUT_PROPS}
            data-testid="agent-test-case-payload-input"
            className="font-mono text-sm"
            rows={5}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </Field>
        <Field
          label="Expected step outputs (JSON)"
          hint='By step id: {"match": {"verdict": "same"}}.'
        >
          <TextArea
            {...JSON_INPUT_PROPS}
            data-testid="agent-test-case-expected-input"
            className="font-mono text-sm"
            rows={5}
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="ds-check"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
        Required: publishing waits for it to pass
      </label>
      {problems.length > 0 ? (
        <Notice tone="warning" testId="agent-test-case-problems">
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {action.error ? <Notice tone="warning">{errorText(action.error)}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="agent-test-case-save"
          disabled={action.busy}
          onClick={save}
        >
          Save the case
        </Button>
      </div>
    </div>
  );
}

function TestRunsCard({
  agent,
  detail,
  liveBundle,
  base,
}: {
  agent: AgentSummary;
  detail: AgentDetail;
  liveBundle: AgentBundle | null;
  base: string;
}) {
  const runs = useApi(apiRoutes.opsRuns, { query: { agent: agent.id, mode: "test", limit: 20 } });
  const live = detail.versions.find((v) => v.id === agent.liveVersionId) ?? null;
  return (
    <Card
      title="Test runs"
      testId="agent-test-runs"
      meta={
        <Link to={`${base}/runs`} className="text-sm text-link">
          All runs
        </Link>
      }
    >
      <div className="px-6 pb-5">
        <TestRun agent={agent} live={live} liveBundle={liveBundle} onStarted={runs.reload} />
      </div>
      {runs.error ? (
        <div className="px-6 pb-4">
          <ErrorNotice error={runs.error} onRetry={runs.reload} />
        </div>
      ) : null}
      {runs.data && runs.data.runs.length === 0 ? (
        <p className="border-t border-line px-6 py-4 text-sm text-ink-muted">No test runs yet.</p>
      ) : null}
      {runs.data && runs.data.runs.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {runs.data.runs.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-6 py-2.5">
              <span className="flex min-w-0 items-center gap-3">
                <span className="w-28 shrink-0 text-sm text-ink-muted figures">
                  {shortTime(r.startedAt ?? r.createdAt)}
                </span>
                <Link to={`/ops/runs/${r.id}`} className="truncate text-ink hover:underline">
                  {r.workflowSlug}
                </Link>
              </span>
              <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
