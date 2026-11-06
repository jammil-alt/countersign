// A skill's tests (ARCHITECTURE §9.10; testbench routes): its cases with what each expects and,
// from the latest suite run, what it got; whether publishing needs the required cases to pass
// (turning that off needs a reason, which is logged). Tests run on saved examples only and never
// write to a client's tools.
import type { SkillListItem } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { Button, Card, EmptyState, ErrorNotice, Loading } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { errorText, Field, Notice, TextInput, useAction } from "../agents/ui";
import type { TestsData } from "./SkillPage";

/** A value as one short line: a string as is, anything else as JSON, cut at 80 characters. */
export function shortValue(value: unknown): string {
  if (value === undefined || value === null) return "nothing";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export function TestsPanel({
  skill,
  tests,
  onChanged,
}: {
  skill: SkillListItem;
  tests: ApiState<TestsData>;
  onChanged(): void;
}) {
  if (tests.error) return <ErrorNotice error={tests.error} onRetry={tests.reload} />;
  if (!tests.data) return <Loading />;
  return <TestsBody skill={skill} data={tests.data} onChanged={onChanged} />;
}

function TestsBody({
  skill,
  data,
  onChanged,
}: {
  skill: SkillListItem;
  data: TestsData;
  onChanged(): void;
}) {
  const lastRun = data.runs[0];
  const results = useApi(
    apiRoutes.opsTestSuiteRun,
    lastRun ? { params: { id: lastRun.id } } : null,
  );
  const byCase = new Map((results.data?.results ?? []).map((r) => [r.testCaseId, r]));
  const cases = data.cases.filter((c) => c.archivedAt === null);

  return (
    <div className="flex flex-col gap-6" data-testid="skill-tests">
      <RequireTests skill={skill} required={data.requireTests} onChanged={onChanged} />
      <Card
        title="Tests"
        meta={
          lastRun ? (
            <span data-testid="skill-tests-summary">
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
          <span className="text-sm text-ink-muted">
            Tests use saved examples only. They never touch a client's tools.
          </span>
        }
      >
        {cases.length === 0 ? (
          <div className="ui-card__body">
            <EmptyState>
              No test cases yet. Give the Builder examples and it adds them with their expected
              answers.
            </EmptyState>
          </div>
        ) : (
          <div className="dt dt-ana overflow-x-auto">
            <table data-testid="skill-tests-table">
              <thead>
                <tr className="dt-cols">
                  <th>Case</th>
                  <th>Expected</th>
                  <th>Got</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => {
                  const r = byCase.get(c.id);
                  return (
                    <tr key={c.id} data-testid={`skill-test-${c.id}`}>
                      <td>
                        <span className="block text-ink">{c.name}</span>
                        <span className="block text-sm text-ink-muted">
                          {c.clientName ?? "Shared"}
                          {c.required ? " · required" : ""}
                        </span>
                      </td>
                      <td className="reference text-ink">{shortValue(c.expected)}</td>
                      <td className="reference text-ink">{r ? shortValue(r.got) : "—"}</td>
                      <td>
                        {!r ? (
                          <span className="text-sm text-ink-muted">Not run</span>
                        ) : r.status === "pass" ? (
                          <StatusChip state="done">Pass</StatusChip>
                        ) : (
                          <StatusChip state="failed">
                            {r.status === "error" ? "Error" : "Fails"}
                          </StatusChip>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** "Publishing needs the required tests to pass": a switch; turning it off asks why. */
function RequireTests({
  skill,
  required,
  onChanged,
}: {
  skill: SkillListItem;
  required: boolean | null;
  onChanged(): void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const action = useAction();
  if (required === null) return null;

  async function set(next: boolean) {
    const res = await action.call(apiRoutes.opsSkillRequireTests, {
      params: { id: skill.id },
      body: next ? { required: true } : { required: false, reason: reason.trim() },
    });
    if (res.ok) {
      setAsking(false);
      setReason("");
      onChanged();
    }
  }

  return (
    <Card pad testId="skill-require-tests">
      <button
        type="button"
        className="ds-choice"
        role="switch"
        aria-checked={required}
        data-testid="skill-require-tests-switch"
        disabled={action.busy}
        onClick={() => (required ? setAsking(true) : void set(true))}
      >
        <span className="ds-switch" />
        Publishing needs the required tests to pass
      </button>
      {asking ? (
        <div className="mt-4 flex flex-col gap-3">
          <Field label="Why turn it off?" hint="Kept in the audit log.">
            <TextInput
              data-testid="skill-require-tests-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Keep it on
            </Button>
            <Button
              data-testid="skill-require-tests-off"
              disabled={!reason.trim() || action.busy}
              onClick={() => void set(false)}
            >
              Turn it off
            </Button>
          </div>
        </div>
      ) : null}
      {action.error ? (
        <div className="mt-3">
          <Notice tone="warning">{errorText(action.error)}</Notice>
        </div>
      ) : null}
    </Card>
  );
}
