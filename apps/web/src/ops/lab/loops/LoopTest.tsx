// A Loop's test (docs/step-model-plan.md §8): try the saved version on one input and watch it turn
// by turn; keep a good try as a case; run the whole test set, which a Loop must pass on this exact
// version before it can be published. Tests use saved examples only: the bench answers reads from
// the case's fixtures, refuses every write and touches no client's tool (invariant 8).
import {
  Fixtures,
  type LoopTryView,
  type SkillListItem,
  type SkillVersionView,
} from "@countersign/core";
import { useEffect, useState } from "react";
import type { ResponseOf } from "../../../api/client";
import { apiRoutes } from "../../../api/routes";
import { type ApiState, useApi } from "../../../api/useApi";
import { Button, Card, EmptyState, ErrorNotice, Loading } from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import { errorText, Field, Notice, TextArea, TextInput, useAction } from "../../agents/ui";
import { shortValue } from "../../skills/TestsPanel";
import { LoopTurns, turnsOf } from "./LoopTurns";

type TestsData = ResponseOf<typeof apiRoutes.opsTests>;

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function LoopTest({
  skill,
  version,
  tests,
  onChanged,
}: {
  skill: SkillListItem;
  version: SkillVersionView | undefined;
  tests: ApiState<TestsData>;
  onChanged(): void;
}) {
  if (tests.error) return <ErrorNotice error={tests.error} onRetry={tests.reload} />;
  if (!tests.data || !version) return <Loading />;
  return (
    <div className="flex flex-col gap-6" data-testid="loop-test">
      <TryIt skill={skill} version={version} onKept={onChanged} />
      <TestSet skill={skill} version={version} data={tests.data} onChanged={onChanged} />
    </div>
  );
}

function TryIt({
  skill,
  version,
  onKept,
}: {
  skill: SkillListItem;
  version: SkillVersionView;
  onKept(): void;
}) {
  const [input, setInput] = useState("{}");
  const [fixtures, setFixtures] = useState("[]");
  const [result, setResult] = useState<{
    sent: unknown;
    fixtures: unknown;
    view: LoopTryView;
  } | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const run = useAction();

  async function tryIt() {
    const i = parseJson(input);
    const f = parseJson(fixtures);
    if (!i.ok) return setBad("What it gets isn't valid JSON.");
    const fx = f.ok ? Fixtures.safeParse(f.value) : null;
    if (!fx?.success) {
      return setBad("What the read actions answer should be a list of { tool, input, output }.");
    }
    setBad(null);
    const res = await run.call(apiRoutes.opsLoopTry, {
      params: { id: skill.id },
      body: { versionId: version.id, input: i.value, fixtures: fx.data },
    });
    if (res.ok) setResult({ sent: i.value, fixtures: fx.data, view: res.data });
  }

  return (
    <Card
      title="Try it"
      testId="loop-try"
      pad
      footer={
        <span className="text-sm text-ink-muted">
          Tests use saved examples only. They never touch a client's tools.
        </span>
      }
    >
      <p className="mb-4 text-sm text-ink-muted">
        Tries v{version.version}, the one saved. Give it an input and what each read action should
        answer: a call with no answer is refused, and a write is always refused.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="What it gets (JSON)">
          <TextArea
            data-testid="loop-try-input"
            rows={6}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </Field>
        <Field
          label="What its read actions answer (JSON)"
          hint="A list of { tool, input, output }."
        >
          <TextArea
            data-testid="loop-try-fixtures"
            rows={6}
            value={fixtures}
            onChange={(e) => setFixtures(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" data-testid="loop-try-run" disabled={run.busy} onClick={tryIt}>
          {run.busy ? "Trying…" : "Try it"}
        </Button>
      </div>
      {bad ? (
        <div className="mt-3">
          <Notice tone="warning">{bad}</Notice>
        </div>
      ) : null}
      {run.error ? (
        <div className="mt-3">
          <Notice tone="warning" testId="loop-try-error">
            {errorText(run.error)}
          </Notice>
        </div>
      ) : null}
      {result ? <TryResult skill={skill} {...result} onKept={onKept} /> : null}
    </Card>
  );
}

function TryResult({
  skill,
  sent,
  fixtures,
  view,
  onKept,
}: {
  skill: SkillListItem;
  sent: unknown;
  fixtures: unknown;
  view: LoopTryView;
  onKept(): void;
}) {
  const [name, setName] = useState("");
  const [expected, setExpected] = useState(pretty(view.output ?? {}));
  const [bad, setBad] = useState<string | null>(null);
  const keep = useAction();
  const [kept, setKept] = useState(false);

  async function keepIt() {
    const e = parseJson(expected);
    if (!e.ok) return setBad("What it should hand back isn't valid JSON.");
    setBad(null);
    const res = await keep.call(apiRoutes.opsCreateTest, {
      body: {
        targetKind: "skill",
        targetId: skill.id,
        name: name.trim(),
        input: sent,
        fixtures: fixtures as never,
        expected: e.value,
        matcher: { kind: "subset" },
        required: true,
        source: "manual",
        ...(skill.clientId ? { clientId: skill.clientId } : {}),
      },
    });
    if (res.ok) {
      setKept(true);
      onKept();
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4" data-testid="loop-try-result">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <StatusChip state={view.status === "succeeded" ? "done" : "failed"}>
          {view.status === "succeeded" ? "It finished" : "It didn't finish"}
        </StatusChip>
        <span className="text-ink-muted">
          {view.turns.length} {view.turns.length === 1 ? "turn" : "turns"} · {view.modelCalls} model{" "}
          {view.modelCalls === 1 ? "call" : "calls"} · ${view.costUsd}
        </span>
      </p>
      {view.error ? <Notice tone="warning">{view.error}</Notice> : null}
      <LoopTurns turns={view.turns} testId="loop-try-turns" />
      {view.status === "succeeded" ? (
        <div data-testid="loop-try-output">
          <p className="text-sm text-ink-muted">
            It handed back <span className="reference text-ink">{shortValue(view.output)}</span>
          </p>
        </div>
      ) : null}
      {view.status === "succeeded" && !kept ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <p className="text-sm text-ink">Keep this try as a test case</p>
          <Field label="Name">
            <TextInput
              data-testid="loop-keep-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="What it should hand back (JSON)"
            hint="Starts as what it handed back. Change it to what is right."
          >
            <TextArea
              data-testid="loop-keep-expected"
              rows={5}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </Field>
          {bad ? <Notice tone="warning">{bad}</Notice> : null}
          {keep.error ? <Notice tone="warning">{errorText(keep.error)}</Notice> : null}
          <div className="flex justify-end">
            <Button data-testid="loop-keep" disabled={!name.trim() || keep.busy} onClick={keepIt}>
              Keep as a test case
            </Button>
          </div>
        </div>
      ) : null}
      {kept ? <Notice tone="positive">Kept. Run the test set to include it.</Notice> : null}
    </div>
  );
}

function TestSet({
  skill,
  version,
  data,
  onChanged,
}: {
  skill: SkillListItem;
  version: SkillVersionView;
  data: TestsData;
  onChanged(): void;
}) {
  const lastRun = data.runs[0];
  const results = useApi(
    apiRoutes.opsTestSuiteRun,
    lastRun ? { params: { id: lastRun.id } } : null,
  );
  const run = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const cases = data.cases.filter((c) => c.archivedAt === null);
  const running = lastRun?.status === "running";
  const reloadResults = results.reload;

  // A suite runs in the background: look again while the last one is running.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      onChanged();
      reloadResults();
    }, 2500);
    return () => clearInterval(timer);
  }, [running, onChanged, reloadResults]);

  async function runSet() {
    const res = await run.call(apiRoutes.opsRunTests, {
      body: {
        targetKind: "skill",
        targetId: skill.id,
        versionId: version.id,
        ...(skill.clientId ? { clientId: skill.clientId } : {}),
      },
    });
    if (res.ok) onChanged();
  }

  const byCase = new Map((results.data?.results ?? []).map((r) => [r.testCaseId, r]));
  const onThisVersion = lastRun?.versionId === version.id;
  const passed =
    onThisVersion &&
    lastRun.status === "done" &&
    lastRun.failed === 0 &&
    lastRun.total === cases.length;

  return (
    <Card
      titleAbove
      title="Test set"
      testId="loop-test-set"
      meta={
        lastRun ? (
          <span data-testid="loop-tests-summary">
            <span className="text-positive">{lastRun.passed} pass</span>
            {lastRun.failed > 0 ? (
              <>
                {" · "}
                <span className="text-risk">{lastRun.failed} fail</span>
              </>
            ) : null}
            {lastRun.version !== null ? ` · v${lastRun.version}` : ""}
          </span>
        ) : (
          "Not run yet"
        )
      }
      footer={
        <span className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-muted">
          <span data-testid="loop-gate">
            {passed
              ? `All ${cases.length} pass on v${version.version}: it can be published.`
              : `Every case must pass on v${version.version} before it can be published. This can't be turned off.`}
          </span>
          <Button
            variant="primary"
            data-testid="loop-run-tests"
            disabled={run.busy || running || cases.length === 0}
            onClick={runSet}
          >
            {running ? "Running…" : run.busy ? "Starting…" : "Run the test set"}
          </Button>
        </span>
      }
    >
      {run.error ? (
        <div className="px-6 py-3">
          <Notice tone="warning" testId="loop-run-error">
            {errorText(run.error)}
          </Notice>
        </div>
      ) : null}
      {cases.length === 0 ? (
        <div className="ui-card__body">
          <EmptyState>
            No cases yet. Try it above, then keep a good try as a case. A Loop needs at least one.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-line" data-testid="loop-cases">
          {cases.map((c) => {
            const r = byCase.get(c.id);
            const turns = r ? turnsOf(r.diff) : [];
            return (
              <li key={c.id} className="px-6 py-3.5" data-testid={`loop-case-${c.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-ink">{c.name}</p>
                    <p className="text-sm text-ink-muted">
                      Should hand back{" "}
                      <span className="reference text-ink">{shortValue(c.expected)}</span>
                      {r ? (
                        <>
                          {" · got "}
                          <span className="reference text-ink">{shortValue(r.got)}</span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {!r ? (
                      <span className="text-sm text-ink-muted">Not run</span>
                    ) : r.status === "pass" ? (
                      <StatusChip state="done">Pass</StatusChip>
                    ) : (
                      <StatusChip state="failed">
                        {r.status === "error" ? "Error" : "Fails"}
                      </StatusChip>
                    )}
                    {r ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`loop-case-turns-${c.id}`}
                        onClick={() => setOpen(open === c.id ? null : c.id)}
                      >
                        {open === c.id ? "Hide turns" : "Show turns"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {open === c.id && r ? (
                  <div className="mt-3">
                    <LoopTurns turns={turns} testId={`loop-case-${c.id}-turns`} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
