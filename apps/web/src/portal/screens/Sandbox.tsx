// `/sandbox` and `/sandbox/:runId` (docs/plan.md §1.243): the client's sandbox. Pick one of your
// agents, run it on a recent document or with one of its forms as a test run on your own data, and
// see what it would do: each change it would make to your tools (an email as it would arrive, a
// text, a record's fields before and after) and the notices it would send. Nothing is written
// (invariant 8). "Send to me" sends one message to the person looking only. Someone who can't sign
// reads only. Runs of ours read "Mezonas". Never a bundle, instructions, prompts or cost
// (invariant 11): only what `/api/sandbox` returns.
import type {
  RunForm,
  SandboxAgent,
  SandboxRunSummary,
  SandboxStartBody,
  SandboxView,
} from "@countersign/core";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { usePoll } from "../../runs/usePoll";
import { SandboxRunBody } from "../../sandbox/SandboxRunBody";
import { useShownRun } from "../../sandbox/useShownRun";
import { SANDBOX_CHIP, type SandboxWords, sandboxWords } from "../../sandbox/words";
import { Loaded, Page, Section } from "../../ui/page";
import { Button, Card, EmptyState, ErrorNotice, PageHeader } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { StatusChip } from "../../ui/status";
import { PORTAL_PATHS } from "../paths";
import { type FieldSpec, type FormValues, formFields, formInput, RunFormFields } from "../runForm";

/** How often a running sandbox run, or a list with one, is read again. */
const POLL_MS = 2000;

export function PortalSandboxScreen() {
  const { t } = useI18n();
  const view = useApi(apiRoutes.portalSandbox);
  const going =
    view.data?.agents.some((a) => a.running) ||
    view.data?.runs.some((r) => r.status === "running") ||
    false;
  usePoll(view.reload, going, POLL_MS, view.loading);
  return (
    <Page testId="portal-sandbox">
      <PageHeader title={t("sandbox.title")} subtitle={t("sandbox.intro")} />
      <Loaded state={view} skeleton={<SkeletonRows rows={5} columns={1} />}>
        {(v) => <SandboxHome view={v} />}
      </Loaded>
    </Page>
  );
}

function SandboxHome({ view }: { view: SandboxView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const words = useMemo(() => sandboxWords(i18n), [i18n]);
  const [search, setSearch] = useSearchParams();
  const asked = search.get("agent");
  const chosen = view.agents.find((a) => a.id === asked) ?? view.agents[0];
  const usedUp = view.use.runs >= view.use.maxRuns;
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4" data-testid="sandbox-start">
        <p className="text-sm text-ink" data-testid="sandbox-use">
          {t("sandbox.use", { count: view.use.runs, max: view.use.maxRuns })}
          {usedUp ? <span className="text-ink-muted"> {t("sandbox.usedUp")}</span> : null}
        </p>
        {view.canTry ? null : (
          <p className="text-sm text-ink-muted" data-testid="sandbox-read-only">
            {t("sandbox.readOnly")}
          </p>
        )}
        {view.agents.length === 0 ? (
          <EmptyState compact line={t("sandbox.noAgents")} testId="sandbox-no-agents" />
        ) : (
          <>
            {view.agents.length > 1 ? (
              <fieldset
                className="ds-seg flex-wrap self-start"
                aria-label={t("sandbox.agents")}
                data-testid="sandbox-agents"
              >
                {view.agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={a.id === chosen?.id}
                    onClick={() => setSearch({ agent: a.id }, { replace: true })}
                    data-testid={`sandbox-agent-${a.id}`}
                  >
                    {a.name}
                  </button>
                ))}
              </fieldset>
            ) : null}
            {chosen ? (
              <AgentStart
                key={chosen.id}
                agent={chosen}
                canStart={view.canTry && !usedUp && !chosen.running}
              />
            ) : null}
          </>
        )}
      </section>
      <RecentRuns runs={view.runs} words={words} />
    </div>
  );
}

function AgentStart({ agent, canStart }: { agent: SandboxAgent; canStart: boolean }) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const forms = agent.forms.flatMap((form) => {
    const fields = formFields(form.input);
    return fields ? [{ form, fields }] : [];
  });

  async function start(body: SandboxStartBody): Promise<void> {
    setError(null);
    try {
      const out = await api.call(apiRoutes.portalSandboxStart, { body });
      navigate(PORTAL_PATHS.sandboxRun(out.run.runId));
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid={`sandbox-agent-start-${agent.id}`}>
      {agent.running ? (
        <p className="text-sm text-ink-muted" data-testid="sandbox-agent-running">
          {t("sandbox.running", { name: agent.name })}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
      {agent.documents.length === 0 && forms.length === 0 ? (
        <p className="text-sm text-ink-muted" data-testid="sandbox-nothing">
          {t("sandbox.nothing")}
        </p>
      ) : null}
      {agent.documents.length > 0 ? (
        <Card titleAbove title={t("sandbox.documents")} testId="sandbox-documents">
          {agent.documents.map((d) => (
            <div
              key={d.documentId}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
              data-testid={`sandbox-document-${d.documentId}`}
            >
              <span className="min-w-0">
                <span className="block text-ink">{d.title}</span>
                <span className="block text-sm text-ink-muted">
                  {[d.from, fmt.time(d.at)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <StartButton
                disabled={!canStart}
                label={t("sandbox.runOn")}
                testId={`sandbox-document-${d.documentId}-run`}
                onStart={() => start({ agentId: agent.id, documentId: d.documentId })}
              />
            </div>
          ))}
        </Card>
      ) : null}
      {forms.length > 0 ? (
        <Card titleAbove title={t("sandbox.forms")} testId="sandbox-forms">
          <div className="divide-y divide-line">
            {forms.map(({ form, fields }) => (
              <SandboxForm
                key={form.workflow}
                form={form}
                fields={fields}
                disabled={!canStart}
                onStart={(input) => start({ agentId: agent.id, workflow: form.workflow, input })}
              />
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function StartButton({
  disabled,
  label,
  testId,
  onStart,
}: {
  disabled: boolean;
  label: string;
  testId: string;
  onStart: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={disabled}
      working={busy}
      onClick={async () => {
        setBusy(true);
        await onStart();
        setBusy(false);
      }}
      data-testid={testId}
    >
      {label}
    </Button>
  );
}

function SandboxForm({
  form,
  fields,
  disabled,
  onStart,
}: {
  form: RunForm;
  fields: FieldSpec[];
  disabled: boolean;
  onStart: (input: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<FormValues>(new Map());
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onStart(formInput(fields, values));
    setBusy(false);
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 px-6 py-4"
      data-testid={`sandbox-form-${form.workflow}`}
    >
      <span className="font-medium text-ink">{form.label}</span>
      <RunFormFields
        fields={fields}
        values={values}
        onChange={(key, value) => setValues((m) => new Map(m).set(key, value))}
      />
      <Button
        type="submit"
        size="sm"
        disabled={disabled}
        working={busy}
        className="self-start"
        data-testid={`sandbox-form-${form.workflow}-run`}
      >
        {busy ? t("sandbox.starting") : t("sandbox.start")}
      </Button>
    </form>
  );
}

function RecentRuns({ runs, words }: { runs: SandboxRunSummary[]; words: SandboxWords }) {
  const { t, fmt } = useI18n();
  return (
    <Section title={t("sandbox.runs")} testId="sandbox-runs">
      {runs.length === 0 ? (
        <EmptyState compact line={t("sandbox.noRuns")} />
      ) : (
        <Card>
          {runs.map((r) => (
            <Link
              key={r.runId}
              to={PORTAL_PATHS.sandboxRun(r.runId)}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-surface-subtle"
              data-testid={`sandbox-run-row-${r.runId}`}
            >
              <span className="min-w-0">
                <span className="block text-ink">{r.title}</span>
                <span className="block text-sm text-ink-muted">
                  {[
                    r.agentName,
                    r.byName ? t("sandbox.by", { name: r.byName }) : null,
                    fmt.time(r.startedAt),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-ink-muted">
                  {t("sandbox.changes", { count: r.changes })} ·{" "}
                  {t("sandbox.messages", { count: r.messages })}
                </span>
                <StatusChip state={SANDBOX_CHIP[r.status]}>{words.runStatus[r.status]}</StatusChip>
              </span>
            </Link>
          ))}
        </Card>
      )}
    </Section>
  );
}

// ── One run ──────────────────────────────────────────────────────────────────────────────────

export function PortalSandboxRunScreen() {
  const { runId = "" } = useParams<{ runId: string }>();
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const words = useMemo(() => sandboxWords(i18n), [i18n]);
  const api = useApiClient();
  const view = useApi(apiRoutes.portalSandboxRun, { params: { runId } });
  const { run, answered } = useShownRun(view.data?.run);
  usePoll(view.reload, run?.status === "running", POLL_MS, view.loading);

  async function send(changeId: string): Promise<void> {
    const out = await api.call(apiRoutes.portalSandboxSend, { params: { runId, changeId } });
    answered(out.run);
  }

  return (
    <Page testId="portal-sandbox-run">
      <PageHeader
        eyebrow={
          <Link to={PORTAL_PATHS.sandbox} className="hover:underline">
            {t("sandbox.title")}
          </Link>
        }
        title={run?.title ?? t("sandbox.title")}
        badge={
          run ? (
            <StatusChip state={SANDBOX_CHIP[run.status]} testId="sandbox-run-status">
              {words.runStatus[run.status]}
            </StatusChip>
          ) : null
        }
        subtitle={
          run
            ? [
                run.agentName,
                run.byName ? t("sandbox.by", { name: run.byName }) : null,
                fmt.time(run.startedAt),
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
      />
      <Loaded state={view} skeleton={<SkeletonRows rows={6} columns={1} />}>
        {() => (run ? <SandboxRunBody run={run} words={words} onSend={send} /> : null)}
      </Loaded>
    </Page>
  );
}
