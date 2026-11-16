// A build (docs/plan.md §1.108): the six phases as a stepper, the build's conversation with the
// Builder on the left (the one conversation component, ui/chat.tsx), and the phase's work on the
// right: the brief, the fit-gap, the draft's problems, the test plan and results, the client's
// trial, and QA with go / no-go. Open items run under every phase. A phase that's done can be
// looked at again; going back to it needs a reason. Used on its own page and as the agent page's
// Build tab.

import type { RouteSpec } from "@countersign/core";
import {
  BRIEF_FIELDS,
  BRIEF_HINTS,
  BRIEF_LABELS,
  BRIEF_STATES,
  type Brief,
  type BriefFieldKey,
  type BriefFieldState,
  type BuildDetail,
  type BuildItemOwner,
  type BuildItemState,
  type BuildPhase,
  DATA_SOURCES,
  type Dataset,
  FIT_REASON_MIN,
  FIT_VERDICTS,
  FIT_WORDS,
  type FitGap,
  type FitRow,
  type FitVerdict,
  fitChangeKind,
  ITEM_STATE_WORDS,
  itemOpen,
  OWNER_WORDS,
  PHASE_WORDS,
  type QaCheckId,
  SETUP_KINDS,
  SETUP_WORDS,
  type SetupField,
  type SetupKind,
  type TestPlan,
} from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CallOptions } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { voiceFor } from "../../api/voice";
import { AgentBadge } from "../../ui/badges";
import { AgentSaid, ChatLog, Composer, Pending, Thinking, YouSaid } from "../../ui/chat";
import { ErrorNotice } from "../../ui/ErrorState";
import { Select, TextArea, TextInput } from "../../ui/forms";
import { Badge, Button, Card, cx, Loading, Tag } from "../../ui/primitives";
import {
  BRIEF_STATE_TONE,
  BRIEF_STATE_WORDS,
  ITEM_TONE,
  plural,
  QA_STATE_WORDS,
  QA_TONE,
  SOURCE_WORDS,
  VERDICT_TONE,
} from "./words";

type Act = <R extends RouteSpec>(route: R, opts: CallOptions<R>) => Promise<boolean>;

export function BuildView({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const api = useApiClient();
  const loaded = useApi(apiRoutes.opsBuild, { params: { id } });
  const [detail, setDetail] = useState<BuildDetail | null>(loaded.data ?? null);
  const [viewing, setViewing] = useState<BuildPhase | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; since: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (loaded.data) setDetail(loaded.data);
  }, [loaded.data]);

  if (!detail) {
    return loaded.error ? (
      <ErrorNotice error={loaded.error} onRetry={loaded.reload} />
    ) : (
      <Loading />
    );
  }
  const b = detail.build;
  const open = b.status === "open";
  const shown = viewing ?? b.phase;
  const at = detail.phases.findIndex((p) => p.phase === b.phase);
  const shownAt = detail.phases.findIndex((p) => p.phase === shown);

  /** One change: the answer is the build as it is now. */
  const act: Act = async (route, opts) => {
    setBusy(route.path);
    setError(null);
    try {
      const out = (await api.call(route, opts)) as BuildDetail;
      setDetail(out);
      setViewing(null);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  async function say(text: string): Promise<boolean> {
    setPending({ text, since: Date.now() });
    try {
      return await act(apiRoutes.opsBuildTurn, { params: { id }, body: { text } });
    } finally {
      setPending(null);
    }
  }

  const moving = busy === apiRoutes.opsMoveBuild.path || busy === apiRoutes.opsBuildClientTest.path;
  return (
    <div className="flex flex-col gap-5" data-testid="build-view">
      {embedded ? null : <BuildHeader detail={detail} />}
      <ol
        className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6"
        data-testid="build-phases"
      >
        {detail.phases.map((p, i) => (
          <li key={p.phase}>
            <button
              type="button"
              data-testid={`build-phase-${p.phase}`}
              aria-current={p.state === "current" ? "step" : undefined}
              aria-pressed={p.phase === shown}
              onClick={() => setViewing(p.phase === b.phase ? null : p.phase)}
              className={cx(
                "flex h-full w-full flex-col gap-1 rounded-md border bg-surface px-3.5 py-3 text-left",
                p.state === "current"
                  ? "border-slate ring-1 ring-slate"
                  : "border-line hover:border-line-strong",
                p.phase === shown && "bg-slate-tint",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                <span
                  className={cx(
                    "inline-flex size-[22px] shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
                    p.state === "done"
                      ? "border-slate bg-slate text-on-slate"
                      : p.state === "current"
                        ? "border-2 border-slate text-slate"
                        : "border-line-strong text-ink-muted",
                  )}
                  aria-hidden
                >
                  {p.state === "done" ? "✓" : i + 1}
                </span>
                {p.label}
              </span>
              <span className="truncate text-xs text-ink-muted">
                {p.state === "done"
                  ? "Done"
                  : p.state === "current"
                    ? open
                      ? "Now"
                      : b.status === "live"
                        ? "Live"
                        : "Stopped"
                    : "Not yet"}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {b.status !== "open" ? (
        <p className="text-sm text-ink-muted" data-testid="build-closed">
          {b.status === "live"
            ? "This build is done: the agent is live."
            : "This build is stopped."}
        </p>
      ) : shownAt < at ? (
        <GoBack
          phase={shown}
          busy={moving}
          onBack={(reason) =>
            act(apiRoutes.opsMoveBuild, { params: { id }, body: { to: shown, reason } })
          }
        />
      ) : shownAt > at ? (
        <p className="text-sm text-ink-muted">
          Not yet: {PHASE_WORDS[shown].closes.replace("Closes", "This phase closes")}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
        <section
          className="ds-card flex flex-col"
          aria-label="Builder conversation"
          data-testid="build-chat"
        >
          <div className="ui-card__head">
            <span className="flex items-center gap-2">
              <AgentBadge name="Builder" size="sm" />
              <span className="type-subheading text-ink">Builder</span>
            </span>
            <span className="text-sm text-ink-muted">{PHASE_WORDS[b.phase].label}</span>
          </div>
          <div className="px-5 py-4">
            <ChatLog
              follow={`${detail.messages.length}:${pending?.text ?? ""}`}
              testId="build-messages"
            >
              {detail.messages.length === 0 && !pending ? (
                <p className="text-ink-muted">
                  {b.kind === "skill"
                    ? "Tell the Builder what the skill should do. It asks what it needs to know and fills the brief."
                    : "Tell the Builder what the agent should do. It asks what it needs to know and fills the brief: where the data comes from, where it goes and who is involved."}
                </p>
              ) : null}
              {detail.messages.map((m) =>
                m.role === "operator" ? (
                  <YouSaid key={m.id} text={m.text} />
                ) : (
                  <AgentSaid
                    key={m.id}
                    badge={<AgentBadge name="Builder" size="sm" />}
                    text={m.text}
                    testId="build-builder-message"
                  >
                    {m.changes.length > 0 ? (
                      <ul className="flex flex-col gap-1">
                        {m.changes.map((c) => (
                          <li
                            key={c}
                            className="rounded-sm border border-line px-2.5 py-1 text-xs text-ink"
                          >
                            <span className="text-slate">+ </span>
                            {c}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {m.chips.length > 0 && m.id === detail.messages.at(-1)?.id && open ? (
                      <div className="flex flex-wrap gap-1.5" data-testid="build-chips">
                        {m.chips.map((c) => (
                          <button
                            key={c}
                            type="button"
                            className="rounded-full border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-subtle"
                            disabled={!!pending}
                            onClick={() => void say(c)}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </AgentSaid>
                ),
              )}
              {pending ? (
                <Pending
                  text={pending.text}
                  since={pending.since}
                  badge={<AgentBadge name="Builder" size="sm" />}
                  label="The Builder is working on it…"
                  state={b.phase === "fitgap" ? "tracing" : "drafting"}
                  testId="build-thinking"
                />
              ) : moving ? (
                <Thinking
                  badge={<AgentBadge name="Builder" size="sm" />}
                  label="The Builder is working on it…"
                  state="drafting"
                  testId="build-thinking"
                />
              ) : null}
            </ChatLog>
          </div>
          {open ? (
            <div className="border-t border-line px-5 py-4">
              <Composer
                label="Message to the Builder"
                placeholder={PLACEHOLDER[b.phase]}
                busy={!!pending}
                onSend={say}
                inputTestId="build-input"
                sendTestId="build-send"
                voice={voiceFor("ops", b.client?.id ?? b.testClient?.id)}
              />
            </div>
          ) : null}
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          <PhasePanel
            phase={shown}
            detail={detail}
            current={shown === b.phase && open}
            busy={busy}
            act={act}
          />
          <ItemsPanel detail={detail} busy={busy} act={act} />
        </div>
      </div>
    </div>
  );
}

const PLACEHOLDER: Record<BuildPhase, string> = {
  intake: "Describe the work, or answer the question",
  fitgap: "Ask about a verdict, or drop something from scope",
  draft: "Ask about the draft, or note something left to do",
  poc: "Change the test data, or ask about a failure",
  client_test: "Ask how the trial is going",
  qa: "Ask about a check",
};

function BuildHeader({ detail }: { detail: BuildDetail }) {
  const b = detail.build;
  const agentLink = b.agentId ? `/ops/agents/${b.agentId}` : null;
  return (
    <header className="flex flex-col gap-2" data-testid="build-header">
      <p className="eyebrow text-ink-muted">
        <Link to="/ops/builds" className="hover:underline">
          Builds
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="type-title text-ink">{b.title}</h1>
        <Badge tone="accent">
          {b.kind === "skill" ? "Skill" : b.client ? "Client agent" : "Template"}
        </Badge>
        {b.status === "open" ? (
          <Badge tone="warning">Building · {PHASE_WORDS[b.phase].label}</Badge>
        ) : b.status === "live" ? (
          <Badge tone="positive">Live</Badge>
        ) : (
          <Badge tone="neutral">Stopped</Badge>
        )}
      </div>
      <p className="text-sm text-ink-muted">
        {[
          b.client
            ? `For ${b.client.name}`
            : b.kind === "skill"
              ? "For every agent"
              : "For every client",
          b.testClient ? `Tested at ${b.testClient.name}` : null,
          b.createdBy ? `Started by ${b.createdBy}` : null,
          plural(b.openItems, "open item"),
        ]
          .filter(Boolean)
          .join(" · ")}
        {agentLink ? (
          <>
            {" · "}
            <Link
              to={agentLink}
              className="font-medium text-slate hover:underline"
              data-testid="build-agent-link"
            >
              Open the agent
            </Link>
          </>
        ) : null}
      </p>
    </header>
  );
}

function GoBack({
  phase,
  busy,
  onBack,
}: {
  phase: BuildPhase;
  busy: boolean;
  onBack(reason: string): void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-4 py-3"
      data-testid="build-go-back"
    >
      <span className="text-sm text-ink">
        Looking back at {PHASE_WORDS[phase].label.toLowerCase()}.
      </span>
      <TextInput
        aria-label="Why it goes back"
        placeholder="Why it goes back"
        className="w-auto min-w-0 flex-1"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button size="sm" disabled={busy || !reason.trim()} onClick={() => onBack(reason.trim())}>
        Go back to this phase
      </Button>
    </div>
  );
}

/** The move out of a phase: its button, off with the gate's reasons while they hold. */
function Next({
  label,
  detail,
  busy,
  onClick,
  testId,
  extra,
}: {
  label: string;
  detail: BuildDetail;
  busy: boolean;
  onClick(): void;
  testId: string;
  extra?: ReactNode;
}) {
  const reasons = detail.gate.reasons;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {extra}
        <Button
          variant="primary"
          disabled={busy || reasons.length > 0}
          onClick={onClick}
          data-testid={testId}
        >
          {busy ? "Working…" : label}
        </Button>
        <span className="text-sm text-ink-muted">{PHASE_WORDS[detail.build.phase].closes}</span>
      </div>
      {reasons.length > 0 ? (
        <ul
          className="flex flex-col gap-0.5 text-sm text-ink-muted"
          data-testid={`${testId}-reasons`}
        >
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PhasePanel(props: {
  phase: BuildPhase;
  detail: BuildDetail;
  current: boolean;
  busy: string | null;
  act: Act;
}) {
  switch (props.phase) {
    case "intake":
      return <IntakePanel {...props} />;
    case "fitgap":
      return <FitGapPanel {...props} />;
    case "draft":
      return <DraftPanel {...props} />;
    case "poc":
      return <PocPanel {...props} />;
    case "client_test":
      return <ClientTestPanel {...props} />;
    case "qa":
      return <QaPanel {...props} />;
  }
}

type PanelProps = Parameters<typeof PhasePanel>[0];

const isBusy = (busy: string | null) => busy !== null;

// ── 1 Intake ────────────────────────────────────────────────────────────────────────────────────

function IntakePanel({ detail, current, busy, act }: PanelProps) {
  const id = detail.build.id;
  const [brief, setBrief] = useState<Brief>(detail.build.brief);
  useEffect(() => setBrief(detail.build.brief), [detail.build.brief]);
  const dirty = JSON.stringify(brief) !== JSON.stringify(detail.build.brief);
  const counts = BRIEF_STATES.map(
    (s) => [s, BRIEF_FIELDS.filter((k) => brief[k]?.state === s).length] as const,
  );
  const set = (k: BriefFieldKey, patch: Partial<{ text: string; state: BriefFieldState }>) =>
    setBrief((b) => ({
      ...b,
      [k]: { text: b[k]?.text ?? "", state: b[k]?.state ?? "confirmed", ...patch },
    }));
  return (
    <Card
      testId="build-brief"
      title="The brief"
      meta={
        <span className="flex flex-wrap gap-1.5">
          {counts
            .filter(([, n]) => n > 0)
            .map(([s, n]) => (
              <Badge key={s} tone={BRIEF_STATE_TONE[s]}>
                {n} {BRIEF_STATE_WORDS[s].toLowerCase()}
              </Badge>
            ))}
        </span>
      }
      footer={
        current ? (
          <div className="flex w-full flex-col gap-3">
            {dirty ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={isBusy(busy)}
                  onClick={() =>
                    void act(apiRoutes.opsUpdateBuild, { params: { id }, body: { brief } })
                  }
                  data-testid="build-brief-save"
                >
                  Save the brief
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setBrief(detail.build.brief)}>
                  Undo changes
                </Button>
              </div>
            ) : null}
            <Next
              label="Confirm the brief"
              detail={detail}
              busy={isBusy(busy) || dirty}
              testId="build-confirm-brief"
              onClick={() =>
                void act(apiRoutes.opsMoveBuild, { params: { id }, body: { to: "fitgap" } })
              }
            />
          </div>
        ) : null
      }
    >
      <dl className="flex flex-col">
        {BRIEF_FIELDS.map((k) => {
          const f = brief[k];
          return (
            <div
              key={k}
              className="grid gap-2 border-b border-line px-6 py-3 last:border-b-0 md:grid-cols-[140px_minmax(0,1fr)_auto]"
            >
              <dt className="pt-1.5 text-sm text-ink-muted">{BRIEF_LABELS[k]}</dt>
              <dd className="min-w-0">
                {current ? (
                  <TextArea
                    aria-label={BRIEF_LABELS[k]}
                    rows={Math.min(5, Math.max(1, Math.ceil((f?.text.length ?? 0) / 48)))}
                    className="w-full"
                    placeholder={BRIEF_HINTS[k]}
                    value={f?.text ?? ""}
                    data-testid={`build-brief-${k}`}
                    onChange={(e) => set(k, { text: e.target.value })}
                  />
                ) : (
                  <p className="pt-1.5 text-sm whitespace-pre-wrap text-ink">
                    {f?.text || <span className="text-ink-muted">Not asked</span>}
                  </p>
                )}
              </dd>
              <dd className="pt-1">
                {current && f ? (
                  <Select
                    aria-label={`${BRIEF_LABELS[k]}: how sure`}
                    value={f.state}
                    onChange={(e) => set(k, { state: e.target.value as BriefFieldState })}
                  >
                    {BRIEF_STATES.map((s) => (
                      <option key={s} value={s}>
                        {BRIEF_STATE_WORDS[s]}
                      </option>
                    ))}
                  </Select>
                ) : f ? (
                  <Badge tone={BRIEF_STATE_TONE[f.state]}>{BRIEF_STATE_WORDS[f.state]}</Badge>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

// ── 2 Fit-gap ───────────────────────────────────────────────────────────────────────────────────

function FitGapPanel({ detail, current, busy, act }: PanelProps) {
  const id = detail.build.id;
  const [fitgap, setFitgap] = useState<FitGap>(detail.build.fitgap);
  useEffect(() => setFitgap(detail.build.fitgap), [detail.build.fitgap]);
  const [only, setOnly] = useState<FitVerdict | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const dirty = JSON.stringify(fitgap) !== JSON.stringify(detail.build.fitgap);
  const inScope = fitgap.rows.filter((r) => !r.dropped);
  const counts = FIT_VERDICTS.map(
    (v) => [v, inScope.filter((r) => r.verdict === v).length] as const,
  ).filter(([, n]) => n > 0);
  const shown = only ? inScope.filter((r) => r.verdict === only) : fitgap.rows;
  const checking = busy === apiRoutes.opsBuildVerdict.path;
  const template = detail.build.kind === "agent" && !detail.build.client;
  return (
    <div className="flex flex-col gap-5">
      <Card
        testId="build-fitgap"
        title="What we do, what we'd build, what we can't"
        meta={
          <span className="flex flex-wrap gap-1.5">
            {counts.map(([v, n]) => (
              <button
                key={v}
                type="button"
                aria-pressed={only === v}
                title={
                  only === v ? "Show every row" : `Show only the ${FIT_WORDS[v].toLowerCase()} rows`
                }
                onClick={() => setOnly(only === v ? null : v)}
                data-testid={`build-fit-count-${v}`}
                className={cx("rounded-full", only === v && "ring-1 ring-slate ring-offset-1")}
              >
                <Badge tone={VERDICT_TONE[v]}>
                  {n} {FIT_WORDS[v].toLowerCase()}
                </Badge>
              </button>
            ))}
          </span>
        }
      >
        {fitgap.rows.length === 0 ? (
          <p className="px-6 py-5 text-sm text-ink-muted">
            The Builder writes the fit-gap when the brief is confirmed.
          </p>
        ) : (
          <div className="overflow-x-auto">
            {only ? (
              <p
                className="border-b border-line px-4 py-2.5 text-sm text-ink-muted"
                data-testid="build-fit-filter"
              >
                Showing the {plural(shown.length, `${FIT_WORDS[only].toLowerCase()} row`)}.{" "}
                <button
                  type="button"
                  className="font-medium text-slate hover:underline"
                  onClick={() => setOnly(null)}
                >
                  Show all
                </button>
              </p>
            ) : null}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-subtle text-left text-xs text-ink-muted">
                  <th className="px-4 py-2.5 font-medium">From the brief</th>
                  <th className="px-4 py-2.5 font-medium">Verdict</th>
                  <th className="px-4 py-2.5 font-medium">How</th>
                  <th className="px-4 py-2.5 font-medium">In scope</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <FitRowView
                    key={r.id}
                    row={r}
                    item={detail.items.find((i) => i.key === `fit:${r.id}`) ?? null}
                    current={current}
                    changing={changing === r.id}
                    checking={checking && changing === r.id}
                    locked={dirty || isBusy(busy)}
                    onScope={(inScope) =>
                      setFitgap((f) => ({
                        ...f,
                        rows: f.rows.map((x) => (x.id === r.id ? { ...x, dropped: !inScope } : x)),
                      }))
                    }
                    onChange={() => setChanging(changing === r.id ? null : r.id)}
                    onSend={async (to, reason) => {
                      if (
                        await act(apiRoutes.opsBuildVerdict, {
                          params: { id },
                          body: { rowId: r.id, to, reason },
                        })
                      )
                        setChanging(null);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {template ? (
        <SetupFormCard
          fields={fitgap.setup}
          current={current}
          onChange={(setup) => setFitgap((f) => ({ ...f, setup }))}
        />
      ) : null}
      {fitgap.needsTrue.length > 0 && !(template && fitgap.setup.length > 0) ? (
        <Card
          title="What needs to be true"
          meta={
            template
              ? "A template has no client yet: ask the Builder to make these the client intake form"
              : "Each becomes an open item until it is"
          }
        >
          <ul className="flex flex-col">
            {fitgap.needsTrue.map((n, i) => (
              <li
                key={n.id}
                className="flex items-start gap-3 border-b border-line px-6 py-3 text-sm last:border-b-0"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--slate)]"
                  aria-label={n.text}
                  checked={n.done}
                  disabled={!current}
                  onChange={(e) =>
                    setFitgap((f) => ({
                      ...f,
                      needsTrue: f.needsTrue.map((x, j) =>
                        j === i ? { ...x, done: e.target.checked } : x,
                      ),
                    }))
                  }
                />
                <span className={cx("text-ink", n.done && "text-ink-muted line-through")}>
                  {n.text}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {current ? (
        <div className="flex flex-col gap-3">
          {dirty ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={isBusy(busy)}
                onClick={() =>
                  void act(apiRoutes.opsUpdateBuild, { params: { id }, body: { fitgap } })
                }
                data-testid="build-fitgap-save"
              >
                Save the fit-gap
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFitgap(detail.build.fitgap)}>
                Undo changes
              </Button>
            </div>
          ) : null}
          <Next
            label="Agree the direction and draft it"
            detail={detail}
            busy={isBusy(busy) || dirty}
            testId="build-agree"
            onClick={() =>
              void act(apiRoutes.opsMoveBuild, { params: { id }, body: { to: "draft" } })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A template's client intake form: what we get from each client to set up their copy. The Builder
 * drafts it in the fit-gap; the operator edits, adds and takes fields out, and saves with the
 * fit-gap. It stays with the build: a template has no client to give open items to.
 */
function SetupFormCard({
  fields,
  current,
  onChange,
}: {
  fields: SetupField[];
  current: boolean;
  onChange: (fields: SetupField[]) => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<SetupKind>("answer");
  const asked = fields.filter((f) => !f.dropped).length;
  const edit = (id: string, patch: Partial<SetupField>) =>
    onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  return (
    <Card
      testId="build-setup"
      title="Client intake form"
      meta={`What we get from each client to set up their copy · ${plural(asked, "field")}`}
      footer={
        current ? (
          <form
            className="flex w-full flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!label.trim()) return;
              onChange([
                ...fields,
                {
                  id: `op-${Date.now().toString(36)}`,
                  label: label.trim(),
                  kind,
                  hint: "",
                  dropped: false,
                  byOperator: true,
                },
              ]);
              setLabel("");
            }}
          >
            <TextInput
              aria-label="New intake field"
              placeholder="Something to ask each client"
              className="w-auto min-w-0 flex-1"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              data-testid="build-setup-new"
            />
            <Select
              aria-label="Kind of field"
              className="w-44"
              value={kind}
              onChange={(e) => setKind(e.target.value as SetupKind)}
            >
              {SETUP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SETUP_WORDS[k]}
                </option>
              ))}
            </Select>
            <Button size="sm" type="submit" disabled={!label.trim()} data-testid="build-setup-add">
              Add
            </Button>
          </form>
        ) : null
      }
    >
      {fields.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          The Builder drafts the form with the fit-gap: the tools each client connects, the packs
          they need, and the answers and files we ask for.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-subtle text-left text-xs text-ink-muted">
                <th className="px-4 py-2.5 font-medium">What we ask</th>
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">Why, or an example</th>
                <th className="px-4 py-2.5 font-medium">Ask it</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr
                  key={f.id}
                  className="border-b border-line align-top last:border-b-0"
                  data-testid={`build-setup-${f.id}`}
                >
                  <td className={cx("px-4 py-3", f.dropped && "text-ink-muted line-through")}>
                    {current && !f.dropped ? (
                      <TextInput
                        aria-label={`Field: ${f.label}`}
                        value={f.label}
                        onChange={(e) => edit(f.id, { label: e.target.value })}
                      />
                    ) : (
                      f.label
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {current && !f.dropped ? (
                      <Select
                        aria-label={`Kind: ${f.label}`}
                        className="w-40"
                        value={f.kind}
                        onChange={(e) => edit(f.id, { kind: e.target.value as SetupKind })}
                      >
                        {SETUP_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {SETUP_WORDS[k]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Tag>{SETUP_WORDS[f.kind]}</Tag>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-muted">
                    {current && !f.dropped ? (
                      <TextInput
                        aria-label={`Hint: ${f.label}`}
                        value={f.hint}
                        onChange={(e) => edit(f.id, { hint: e.target.value })}
                      />
                    ) : (
                      f.hint
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--slate)]"
                      aria-label={`Ask it: ${f.label}`}
                      checked={!f.dropped}
                      disabled={!current}
                      data-testid={`build-setup-${f.id}-ask`}
                      onChange={(e) => edit(f.id, { dropped: !e.target.checked })}
                    />
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

/** Who an agreed row's open item goes to. */
const FIT_ITEM_OWNER: Partial<Record<FitVerdict, BuildItemOwner>> = {
  build: "builder",
  figure_out: "engineering",
};

function FitRowView({
  row: r,
  item,
  current,
  changing,
  checking,
  locked,
  onScope,
  onChange,
  onSend,
}: {
  row: FitRow;
  item: BuildDetail["items"][number] | null;
  current: boolean;
  changing: boolean;
  checking: boolean;
  locked: boolean;
  onScope: (inScope: boolean) => void;
  onChange: () => void;
  onSend: (to: FitVerdict, reason: string) => Promise<void>;
}) {
  const owner = FIT_ITEM_OWNER[r.verdict];
  return (
    <>
      <tr
        className={cx("align-top", !changing && "border-b border-line last:border-b-0")}
        data-testid={`build-fit-${r.id}`}
      >
        <td className={cx("px-4 py-3", r.dropped && "text-ink-muted line-through")}>{r.need}</td>
        <td className="px-4 py-3">
          <div className="flex flex-col items-start gap-1.5">
            <Badge tone={VERDICT_TONE[r.verdict]} testId={`build-fit-${r.id}-verdict`}>
              {FIT_WORDS[r.verdict]}
            </Badge>
            {r.override ? (
              <span className="text-xs text-ink-muted" data-testid={`build-fit-${r.id}-override`}>
                Changed from {FIT_WORDS[r.override.from]}
                {r.override.by ? ` by ${r.override.by}` : ""}
              </span>
            ) : null}
            {r.challenge ? (
              <Badge tone="neutral" testId={`build-fit-${r.id}-challenge`}>
                {checking ? "Builder checking" : "Asked the Builder"}
              </Badge>
            ) : null}
            {current && !r.dropped && !r.challenge ? (
              <button
                type="button"
                className="text-xs font-medium text-slate hover:underline disabled:opacity-60"
                disabled={locked && !changing}
                title={locked && !changing ? "Save or undo your changes first" : undefined}
                onClick={onChange}
                data-testid={`build-fit-${r.id}-change`}
              >
                {changing ? "Cancel" : "Challenge"}
              </button>
            ) : null}
          </div>
        </td>
        <td className="px-4 py-3 text-ink-muted">
          {r.how}
          {r.override ? <p className="mt-1 text-xs">Why it changed: {r.override.reason}</p> : null}
          {r.challenge ? (
            <p className="mt-1 text-xs">
              You asked for {FIT_WORDS[r.challenge.wanted]}: {r.challenge.reason}
            </p>
          ) : null}
          {r.dropped ? null : item ? (
            <button
              type="button"
              className="mt-1 block text-xs font-medium text-slate hover:underline"
              onClick={() =>
                document
                  .getElementById(`build-item-${item.id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" })
              }
              data-testid={`build-fit-${r.id}-item`}
            >
              Open item · {OWNER_WORDS[item.owner]} · {ITEM_STATE_WORDS[item.state]}
            </button>
          ) : owner ? (
            <p className="mt-1 text-xs" data-testid={`build-fit-${r.id}-item`}>
              Becomes an open item for {OWNER_WORDS[owner]} when you agree the direction.
            </p>
          ) : null}
        </td>
        <td className="px-4 py-3">
          <input
            type="checkbox"
            className="size-4 accent-[var(--slate)]"
            aria-label={`In scope: ${r.need}`}
            checked={!r.dropped}
            disabled={!current}
            data-testid={`build-fit-${r.id}-scope`}
            onChange={(e) => onScope(e.target.checked)}
          />
        </td>
      </tr>
      {changing ? (
        <tr className="border-b border-line last:border-b-0">
          <td colSpan={4} className="bg-surface-subtle px-4 py-3">
            <VerdictChange row={r} busy={locked} onSend={onSend} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Challenging a verdict: why is it wrong. More work changes it at once; less work goes to the
 * Builder, which checks the catalog and whether the step is captured right.
 */
function VerdictChange({
  row,
  busy,
  onSend,
}: {
  row: FitRow;
  busy: boolean;
  onSend: (to: FitVerdict, reason: string) => Promise<void>;
}) {
  const options = FIT_VERDICTS.filter((v) => v !== row.verdict);
  const [to, setTo] = useState<FitVerdict>(options[0] ?? "figure_out");
  const [reason, setReason] = useState("");
  const as = fitChangeKind(row.verdict, to);
  const short = reason.trim().length < FIT_REASON_MIN;
  return (
    <div className="flex flex-col gap-2.5" data-testid={`build-fit-${row.id}-form`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink">It's {FIT_WORDS[row.verdict]} now. It should be</span>
        <Select
          aria-label={`New verdict: ${row.need}`}
          className="w-40"
          value={to}
          onChange={(e) => setTo(e.target.value as FitVerdict)}
          data-testid={`build-fit-${row.id}-to`}
        >
          {options.map((v) => (
            <option key={v} value={v}>
              {FIT_WORDS[v]}
            </option>
          ))}
        </Select>
      </div>
      <p className="text-xs text-ink-muted">
        {as === "challenge"
          ? "That's less work, so the Builder checks it against the catalog and answers in the conversation. Say why you think we have it: the part that does it, or what the client really does at this step. If the row doesn't describe the step right, say how it should read."
          : "That's more work, so it changes now and stays when the Builder writes the fit-gap again. Say why the Builder's verdict is wrong: what's missing, or what makes this case harder."}
      </p>
      <TextArea
        aria-label={`Why: ${row.need}`}
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={
          as === "challenge"
            ? "e.g. The client's invoices come in as PDFs attached to the email, so this is the same step as reading the PDF."
            : "e.g. Their contracts are scanned images, and read document hasn't been checked on scans."
        }
        data-testid={`build-fit-${row.id}-reason`}
      />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={busy || short}
          onClick={() => void onSend(to, reason.trim())}
          data-testid={`build-fit-${row.id}-send`}
        >
          {as === "challenge" ? "Ask the Builder" : "Change it"}
        </Button>
        {short ? (
          <span className="text-xs text-ink-muted">
            Say why in at least {FIT_REASON_MIN} characters.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── 3 Draft ─────────────────────────────────────────────────────────────────────────────────────

function DraftPanel({ detail, current, busy, act }: PanelProps) {
  const d = detail.draft;
  const b = detail.build;
  const link =
    b.kind === "skill"
      ? d?.sessionId
        ? `/ops/skills/new?session=${d.sessionId}`
        : null
      : b.agentId
        ? `/ops/agents/${b.agentId}`
        : null;
  return (
    <Card
      testId="build-draft"
      title={d?.version ? `The draft · v${d.version}` : "The draft"}
      meta={
        link ? (
          <Link
            to={link}
            className="text-sm font-medium text-slate hover:underline"
            data-testid="build-open-draft"
          >
            {b.kind === "skill" ? "Open the skill's conversation" : "Open the workflow"}
          </Link>
        ) : null
      }
      footer={
        current ? (
          <Next
            label={b.kind === "skill" ? "Move to the POC test" : "Move to the POC test"}
            detail={detail}
            busy={isBusy(busy)}
            testId="build-to-poc"
            onClick={() =>
              void act(apiRoutes.opsMoveBuild, { params: { id: b.id }, body: { to: "poc" } })
            }
          />
        ) : null
      }
    >
      {!d ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          The draft is made when the direction is agreed.
        </p>
      ) : d.problems.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink" data-testid="build-draft-clean">
          No missing or invalid steps.{" "}
          {b.kind === "agent" ? "Look it over on the agent's Steps tab." : null}
        </p>
      ) : (
        <ul className="flex flex-col" data-testid="build-draft-problems">
          {d.problems.map((p) => (
            <li
              key={p.key}
              className="flex items-start justify-between gap-3 border-b border-line px-6 py-3 text-sm last:border-b-0"
            >
              <span className="text-ink">{p.title}</span>
              <Badge tone={p.code === "missing_step" ? "warning" : "risk"}>
                {p.code === "missing_step" ? "Missing" : "Invalid"}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── 4 POC test ──────────────────────────────────────────────────────────────────────────────────

function PocPanel({ detail, current, busy, act }: PanelProps) {
  const b = detail.build;
  const id = b.id;
  const [plan, setPlan] = useState<TestPlan>(b.testPlan);
  useEffect(() => setPlan(b.testPlan), [b.testPlan]);
  const dirty = JSON.stringify(plan) !== JSON.stringify(b.testPlan);
  const poc = detail.poc;
  const clients = useApi(
    apiRoutes.opsClients,
    b.kind === "agent" && !b.client ? { query: { view: "names" } } : null,
  );
  const [clientId, setClientId] = useState("");
  const setRow = (i: number, patch: Partial<Dataset>) =>
    setPlan((p) => ({ datasets: p.datasets.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));
  return (
    <div className="flex flex-col gap-5">
      <Card
        testId="build-test-plan"
        title="Test data plan"
        meta={
          <span className="text-sm text-ink-muted">
            Synthetic data, on the Sandbox. Nothing is written anywhere.
          </span>
        }
        footer={
          current ? (
            <div className="flex flex-wrap gap-2">
              {dirty ? (
                <>
                  <Button
                    size="sm"
                    disabled={isBusy(busy)}
                    onClick={() =>
                      void act(apiRoutes.opsUpdateBuild, {
                        params: { id },
                        body: { testPlan: plan },
                      })
                    }
                    data-testid="build-plan-save"
                  >
                    Save the plan
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPlan(b.testPlan)}>
                    Undo changes
                  </Button>
                </>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setPlan((p) => ({
                    datasets: [
                      ...p.datasets,
                      {
                        id: `data-${p.datasets.length + 1}`,
                        name: "",
                        count: 5,
                        covers: "",
                        source: "generate",
                      },
                    ],
                  }))
                }
              >
                Add a dataset
              </Button>
              {poc?.mode === "suite" ? (
                <>
                  <Button
                    size="sm"
                    disabled={isBusy(busy) || dirty}
                    onClick={() => void act(apiRoutes.opsBuildCases, { params: { id } })}
                    data-testid="build-make-cases"
                  >
                    {busy === apiRoutes.opsBuildCases.path
                      ? "Making the cases…"
                      : "Make the test cases"}
                  </Button>
                  <Button
                    size="sm"
                    disabled={isBusy(busy) || (poc?.cases ?? 0) === 0}
                    onClick={() => void act(apiRoutes.opsBuildRunTests, { params: { id } })}
                    data-testid="build-run-cases"
                  >
                    Run the test cases
                  </Button>
                </>
              ) : null}
            </div>
          ) : null
        }
      >
        {plan.datasets.length === 0 ? (
          <p className="px-6 py-5 text-sm text-ink-muted">
            The Builder plans the test data when the draft has no problems left.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-subtle text-left text-xs text-ink-muted">
                  <th className="px-4 py-2.5 font-medium">Data</th>
                  <th className="px-4 py-2.5 text-right font-medium">How many</th>
                  <th className="px-4 py-2.5 font-medium">Must cover</th>
                  <th className="px-4 py-2.5 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {plan.datasets.map((d, i) => (
                  <tr
                    key={d.id}
                    className="border-b border-line align-top last:border-b-0"
                    data-testid={`build-dataset-${d.id}`}
                  >
                    <td className="px-4 py-3">
                      {current ? (
                        <TextInput
                          aria-label="Data"
                          value={d.name}
                          onChange={(e) => setRow(i, { name: e.target.value })}
                        />
                      ) : (
                        d.name
                      )}
                    </td>
                    <td className="figures px-4 py-3 text-right">
                      {current ? (
                        <TextInput
                          aria-label="How many"
                          type="number"
                          min={1}
                          max={200}
                          className="w-20"
                          value={d.count}
                          onChange={(e) =>
                            setRow(i, {
                              count: Math.max(1, Math.min(200, Number(e.target.value) || 1)),
                            })
                          }
                        />
                      ) : (
                        d.count
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">
                      {current ? (
                        <TextInput
                          aria-label="Must cover"
                          value={d.covers}
                          onChange={(e) => setRow(i, { covers: e.target.value })}
                        />
                      ) : (
                        d.covers
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <fieldset className="ds-seg" aria-label="Source" disabled={!current}>
                        {DATA_SOURCES.map((s) => (
                          <button
                            key={s}
                            type="button"
                            aria-pressed={d.source === s}
                            onClick={() => setRow(i, { source: s })}
                          >
                            {SOURCE_WORDS[s]}
                          </button>
                        ))}
                      </fieldset>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {poc ? (
        <Card
          testId="build-poc-results"
          title={poc.mode === "suite" ? "Test results" : "Test runs"}
          meta={
            <Badge tone={poc.passed ? "positive" : "warning"}>
              {poc.passed ? "Passing" : "Not passing yet"}
            </Badge>
          }
        >
          <div className="flex flex-col gap-3 px-6 py-5 text-sm">
            <p className="text-ink" data-testid="build-poc-detail">
              {poc.detail}
            </p>
            {poc.mode === "suite" ? (
              <p className="text-ink-muted">
                {plural(poc.cases, "case")} · {poc.required} required
                {poc.latest ? ` · latest run ${poc.latest.passed} of ${poc.latest.total} pass` : ""}
              </p>
            ) : poc.testRuns ? (
              <p className="text-ink-muted">
                {plural(poc.testRuns.total, "test run")} of the latest version ·{" "}
                {poc.testRuns.succeeded} passed.{" "}
                {b.agentId ? (
                  <Link
                    to={`/ops/agents/${b.agentId}`}
                    className="font-medium text-slate hover:underline"
                  >
                    Test-run it on the agent page
                  </Link>
                ) : null}
              </p>
            ) : null}
          </div>
          {poc.failures.length > 0 ? (
            <ul className="flex flex-col border-t border-line">
              {poc.failures.map((f) => {
                const made = detail.items.some((i) => i.ref.testCaseId === f.caseId);
                return (
                  <li
                    key={f.caseId}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3 text-sm last:border-b-0"
                  >
                    <span className="text-ink">
                      {f.name}{" "}
                      <span className="text-ink-muted">
                        · {f.status === "fail" ? "fails" : "errored"}
                      </span>
                    </span>
                    {made ? (
                      <Badge tone="neutral">Open item</Badge>
                    ) : (
                      <Button
                        size="sm"
                        disabled={isBusy(busy)}
                        onClick={() =>
                          void act(apiRoutes.opsAddBuildItem, {
                            params: { id },
                            body: {
                              title: `Test fails: ${f.name}`,
                              kind: "test",
                              ref: { testCaseId: f.caseId },
                            },
                          })
                        }
                      >
                        Make it an open item
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {current ? (
        b.kind === "skill" ? (
          <Next
            label="Move to QA"
            detail={detail}
            busy={isBusy(busy)}
            testId="build-to-qa"
            onClick={() => void act(apiRoutes.opsMoveBuild, { params: { id }, body: { to: "qa" } })}
          />
        ) : (
          <Next
            label="Promote to ready to test"
            detail={detail}
            busy={isBusy(busy) || (!b.client && !clientId)}
            testId="build-promote"
            onClick={() =>
              void act(apiRoutes.opsBuildClientTest, {
                params: { id },
                body: b.client ? {} : { clientId },
              })
            }
            extra={
              b.client ? (
                <span className="text-sm text-ink">Tested at {b.client.name}</span>
              ) : (
                <Select
                  aria-label="The client it's tested with"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  data-testid="build-test-client"
                >
                  <option value="">Pick the client it's tested with</option>
                  {(clients.data?.clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )
            }
          />
        )
      ) : null}
    </div>
  );
}

// ── 5 Client test ───────────────────────────────────────────────────────────────────────────────

function ClientTestPanel({ detail, current, busy, act }: PanelProps) {
  const t = detail.clientTest;
  const id = detail.build.id;
  const [reason, setReason] = useState("");
  if (!t) {
    return (
      <Card title="Client test" pad>
        <p className="text-sm text-ink-muted">
          The client test starts when the POC test passes: the draft is published and put at the
          client, every write signed there.
        </p>
      </Card>
    );
  }
  const bar = (n: number, of: number) => (
    <div className="h-2 overflow-hidden rounded-full bg-surface-subtle" aria-hidden>
      <span
        className="block h-full rounded-full bg-slate"
        style={{ width: `${Math.min(100, of > 0 ? (n / of) * 100 : 0)}%` }}
      />
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      <Card
        testId="build-client-test"
        title={`${t.client.name}, on real data`}
        meta={
          <Link
            to={`/ops/agents/${t.agentId}`}
            className="text-sm font-medium text-slate hover:underline"
          >
            Open the client's copy
          </Link>
        }
      >
        <div className="grid gap-4 px-6 py-5 md:grid-cols-3">
          <div className="flex flex-col gap-1.5 rounded-md border border-line px-4 py-3">
            <span className="text-xs text-ink-muted">Stage</span>
            <span className="type-subheading text-ink">
              {t.stage ? STAGE_WORDS[t.stage] : "Not started"}
            </span>
          </div>
          {t.trial ? (
            <>
              <div className="flex flex-col gap-1.5 rounded-md border border-line px-4 py-3">
                <span className="text-xs text-ink-muted">Days</span>
                <span className="figures type-subheading text-ink">
                  {t.trial.days} of {t.trial.minDays}
                </span>
                {bar(t.trial.days, t.trial.minDays)}
              </div>
              <div className="flex flex-col gap-1.5 rounded-md border border-line px-4 py-3">
                <span className="text-xs text-ink-muted">Runs</span>
                <span className="figures type-subheading text-ink">
                  {t.trial.runs} of {t.trial.minRuns}
                </span>
                {bar(t.trial.runs, t.trial.minRuns)}
              </div>
            </>
          ) : null}
        </div>
        <p
          className="border-t border-line px-6 py-3 text-sm text-ink"
          data-testid="build-client-writes"
        >
          {t.writes.signed} signed · {t.writes.rejected} rejected · {t.writes.waiting} waiting on
          the client
        </p>
      </Card>
      {t.rejections.length > 0 ? (
        <Card title="What the client rejected" meta={plural(t.rejections.length, "write")}>
          <ul className="flex flex-col">
            {t.rejections.map((r) => {
              const made = detail.items.some((i) => i.ref.actionId === r.actionId);
              return (
                <li
                  key={r.actionId}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3 text-sm last:border-b-0"
                >
                  <span className="min-w-0 text-ink">
                    {r.reason ? `"${r.reason}"` : "No reason given"}{" "}
                    <span className="text-ink-muted">· {r.tool}</span>
                  </span>
                  {made ? (
                    <Badge tone="neutral">Open item</Badge>
                  ) : (
                    <Button
                      size="sm"
                      disabled={isBusy(busy)}
                      onClick={() =>
                        void act(apiRoutes.opsAddBuildItem, {
                          params: { id },
                          body: {
                            title: `Rejected: ${r.reason ?? r.tool}`,
                            kind: "feedback",
                            owner: "operator",
                            ref: { actionId: r.actionId, ...(r.runId ? { runId: r.runId } : {}) },
                          },
                        })
                      }
                    >
                      Make it an open item
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
      {current ? (
        detail.gate.reasons.length === 0 ? (
          <Next
            label="Move to QA"
            detail={detail}
            busy={isBusy(busy)}
            testId="build-to-qa"
            onClick={() => void act(apiRoutes.opsMoveBuild, { params: { id }, body: { to: "qa" } })}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2" data-testid="build-skip-trial">
            <span className="text-sm text-ink-muted">
              {detail.gate.reasons.join(" ")} Move on anyway:
            </span>
            <TextInput
              aria-label="Why it moves on"
              placeholder="Why it moves on"
              className="w-auto min-w-0 flex-1"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              size="sm"
              disabled={isBusy(busy) || !reason.trim()}
              onClick={() =>
                void act(apiRoutes.opsMoveBuild, {
                  params: { id },
                  body: { to: "qa", reason: reason.trim() },
                })
              }
            >
              Move to QA
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

const STAGE_WORDS = {
  bench: "On the bench",
  trial: "In trial",
  signoff: "Waiting for sign-off",
  live: "Live",
} as const;

// ── 6 QA and go / no-go ─────────────────────────────────────────────────────────────────────────

function QaPanel({ detail, current, busy, act }: PanelProps) {
  const b = detail.build;
  const id = b.id;
  const [accepting, setAccepting] = useState<QaCheckId | null>(null);
  const [reason, setReason] = useState("");
  const [noGo, setNoGo] = useState<{ to: BuildPhase | ""; reason: string }>({ to: "", reason: "" });
  const signed = !!b.qa.signedAt;
  const earlier = detail.phases.filter((p) => p.phase !== "qa");
  return (
    <div className="flex flex-col gap-5">
      <Card testId="build-qa" title="QA checklist">
        <ul className="flex flex-col">
          {detail.qaChecks.map((c) => (
            <li
              key={c.id}
              className="flex flex-col gap-2 border-b border-line px-6 py-3 text-sm last:border-b-0"
              data-testid={`build-qa-${c.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="text-ink">{c.label}</span>
                  <span className="block text-xs text-ink-muted">
                    {c.reason ? `Accepted: "${c.reason}"` : c.detail}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={QA_TONE[c.state]}>{QA_STATE_WORDS[c.state]}</Badge>
                  {current && c.state === "fail" && !signed ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAccepting(accepting === c.id ? null : c.id)}
                    >
                      Accept
                    </Button>
                  ) : null}
                </span>
              </div>
              {accepting === c.id ? (
                <div className="flex flex-wrap gap-2">
                  <TextInput
                    aria-label="Why it's accepted"
                    placeholder="Why it's accepted"
                    className="w-auto min-w-0 flex-1"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={isBusy(busy) || !reason.trim()}
                    onClick={async () => {
                      if (
                        await act(apiRoutes.opsBuildQa, {
                          params: { id },
                          body: { accept: c.id, reason: reason.trim() },
                        })
                      ) {
                        setAccepting(null);
                        setReason("");
                      }
                    }}
                  >
                    Accept it
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Go / no-go" testId="build-decision">
        <div className="flex flex-col gap-4 px-6 py-5 text-sm">
          <p className="text-ink">
            {signed ? "QA is signed." : "QA isn't signed yet."}{" "}
            {detail.clientTest
              ? detail.clientTest.stage === "live"
                ? `${detail.clientTest.client.name}'s copy is live.`
                : `It goes live when ${detail.clientTest.client.name} signs off: the go-live sign-off is on their Desk.`
              : null}
          </p>
          {current ? (
            <div className="flex flex-wrap gap-2">
              {!signed ? (
                <Button
                  variant="primary"
                  disabled={isBusy(busy) || detail.qaChecks.some((c) => c.state === "fail")}
                  onClick={() =>
                    void act(apiRoutes.opsBuildQa, { params: { id }, body: { sign: true } })
                  }
                  data-testid="build-sign-qa"
                >
                  Sign QA
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={isBusy(busy) || detail.gate.reasons.length > 0}
                  onClick={() =>
                    void act(apiRoutes.opsBuildDecision, { params: { id }, body: { go: true } })
                  }
                  data-testid="build-go"
                >
                  Go live
                </Button>
              )}
            </div>
          ) : null}
          {current ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <span className="text-ink-muted">No-go: back to</span>
              <Select
                aria-label="Back to"
                value={noGo.to}
                onChange={(e) => setNoGo((n) => ({ ...n, to: e.target.value as BuildPhase }))}
              >
                <option value="">a phase…</option>
                {earlier.map((p) => (
                  <option key={p.phase} value={p.phase}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <TextInput
                aria-label="Why not"
                placeholder="Why not"
                className="w-auto min-w-0 flex-1"
                value={noGo.reason}
                onChange={(e) => setNoGo((n) => ({ ...n, reason: e.target.value }))}
              />
              <Button
                size="sm"
                disabled={isBusy(busy) || !noGo.to || !noGo.reason.trim()}
                onClick={() =>
                  noGo.to &&
                  void act(apiRoutes.opsBuildDecision, {
                    params: { id },
                    body: { go: false, to: noGo.to, reason: noGo.reason.trim() },
                  })
                }
                data-testid="build-no-go"
              >
                No-go
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

// ── Open items ──────────────────────────────────────────────────────────────────────────────────

const OWNERS: BuildItemOwner[] = ["operator", "builder", "client", "engineering"];
const STATES: BuildItemState[] = ["open", "in_progress", "waiting", "done", "deferred"];

function ItemsPanel({ detail, busy, act }: { detail: BuildDetail; busy: string | null; act: Act }) {
  const id = detail.build.id;
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState<BuildItemOwner>("operator");
  const open = detail.items.filter((i) => itemOpen(i.state));
  const closed = detail.items.length - open.length;
  const editable = detail.build.status === "open";
  return (
    <Card
      testId="build-items"
      title="Open items"
      meta={
        <span className="flex gap-1.5">
          <Badge tone={open.length > 0 ? "warning" : "positive"}>{open.length} open</Badge>
          {closed > 0 ? <Badge tone="neutral">{closed} done or put off</Badge> : null}
        </span>
      }
      footer={
        editable ? (
          <form
            className="flex w-full flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                title.trim() &&
                (await act(apiRoutes.opsAddBuildItem, {
                  params: { id },
                  body: { title: title.trim(), owner },
                }))
              )
                setTitle("");
            }}
          >
            <TextInput
              aria-label="New open item"
              placeholder="Something left to do"
              className="w-auto min-w-0 flex-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="build-item-new"
            />
            <Select
              aria-label="Who has it"
              className="w-48"
              value={owner}
              onChange={(e) => setOwner(e.target.value as BuildItemOwner)}
            >
              {OWNERS.map((o) => (
                <option key={o} value={o}>
                  {OWNER_WORDS[o]}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              type="submit"
              disabled={isBusy(busy) || !title.trim()}
              data-testid="build-item-add"
            >
              Add
            </Button>
          </form>
        ) : null
      }
    >
      {detail.items.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          Nothing left to do yet. The Builder and the phases add items as they go.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-subtle text-left text-xs text-ink-muted">
                <th className="px-4 py-2.5 font-medium">Item</th>
                <th className="px-4 py-2.5 font-medium">From</th>
                <th className="px-4 py-2.5 font-medium">Who</th>
                <th className="px-4 py-2.5 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {[...open, ...detail.items.filter((i) => !itemOpen(i.state))].map((i) => (
                <tr
                  key={i.id}
                  id={`build-item-${i.id}`}
                  className="border-b border-line align-top last:border-b-0"
                  data-testid={`build-item-${i.id}`}
                >
                  <td
                    className={cx("px-4 py-3", !itemOpen(i.state) && "text-ink-muted line-through")}
                  >
                    {i.title}
                    {i.detail ? (
                      <p className="mt-0.5 text-xs text-ink-muted no-underline">{i.detail}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-ink-muted">{PHASE_WORDS[i.phase].label}</td>
                  <td className="px-4 py-3">
                    {editable ? (
                      <Select
                        aria-label={`Who has it: ${i.title}`}
                        value={i.owner}
                        onChange={(e) =>
                          void act(apiRoutes.opsUpdateBuildItem, {
                            params: { id, itemId: i.id },
                            body: { owner: e.target.value as BuildItemOwner },
                          })
                        }
                      >
                        {OWNERS.map((o) => (
                          <option key={o} value={o}>
                            {OWNER_WORDS[o]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone={i.owner === "client" ? "person" : "neutral"}>
                        {OWNER_WORDS[i.owner]}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editable ? (
                      <Select
                        aria-label={`State: ${i.title}`}
                        value={i.state}
                        data-testid={`build-item-${i.id}-state`}
                        onChange={(e) =>
                          void act(apiRoutes.opsUpdateBuildItem, {
                            params: { id, itemId: i.id },
                            body: { state: e.target.value as BuildItemState },
                          })
                        }
                      >
                        {STATES.map((s) => (
                          <option key={s} value={s}>
                            {ITEM_STATE_WORDS[s]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone={ITEM_TONE[i.state]}>{ITEM_STATE_WORDS[i.state]}</Badge>
                    )}
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
