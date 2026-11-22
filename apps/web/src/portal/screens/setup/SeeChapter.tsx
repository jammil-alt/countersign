// See it work (docs/setup-plan.md §6; docs/plan.md §1.199, SU4 and SU5): one agent at a time, its
// process read step by step from its SOP (`/api/services/:id/sop`: names, how each step works,
// who, why; seats already as people's names), each step with Looks right or We do it differently
// (a request to the lead, tied to the step); the settings the client may choose within bounds (the
// agent's Settings card); then Try it on a real one: a test run on one of the client's own
// documents, its steps appearing as it runs, each with Right or Not right because…. A try writes
// nothing and asks nobody (invariant 8). Viewers read only. Their words are data (invariant 9).
import {
  gettingStartedRoutes,
  type SetupAgentLine,
  type SopProcedureLine,
  type SopStepLine,
  sopRoutes,
  type TryCandidate,
  type TryStep,
  type TryView,
  type WalkMark,
  type WalkMarkBody,
  type WalkthroughView,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useApi, useApiClient } from "../../../api/useApi";
import { useI18n } from "../../../i18n/i18n";
import { useSession } from "../../../session/session";
import { Field, TextArea } from "../../../ui/forms";
import { Loaded } from "../../../ui/page";
import { Badge, Button, Card, ErrorNotice, SectionLabel } from "../../../ui/primitives";
import { SkeletonRows } from "../../../ui/skeleton";
import { PORTAL_PATHS } from "../../paths";
import { AdjustSettings } from "../AdjustSettings";
import { ChapterFrame } from "./ChapterFrame";
import { scheduleWords } from "./scheduleWords";

/** How often a running try is read again. */
const POLL_MS = 2000;

export function SeeChapterScreen() {
  const { agentId } = useParams<{ agentId?: string }>();
  const overview = useApi(gettingStartedRoutes.portalGettingStarted);
  return (
    <ChapterFrame chapter="see">
      <Loaded state={overview}>
        {(d) => (
          <SeeAgents agents={d.agents} lead={d.lead?.name ?? null} agentId={agentId ?? null} />
        )}
      </Loaded>
    </ChapterFrame>
  );
}

function SeeAgents({
  agents,
  lead,
  agentId,
}: {
  agents: SetupAgentLine[];
  lead: string | null;
  agentId: string | null;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  if (agents.length === 0) return <p className="text-ink-muted">{t("setup.see.none")}</p>;
  // DECISION: with one agent being set up it opens at once; with several, the one in the address,
  // else the reader picks.
  const chosen =
    agents.find((a) => a.agentId === agentId) ?? (agents.length === 1 ? agents[0] : undefined);
  return (
    <div className="flex flex-col gap-6" data-testid="start-see">
      {agents.length > 1 ? (
        <fieldset
          className="ds-seg flex-wrap self-start"
          aria-label={t("setup.see.agents")}
          data-testid="start-see-agents"
        >
          {agents.map((a) => (
            <button
              key={a.agentId}
              type="button"
              aria-pressed={a.agentId === chosen?.agentId}
              onClick={() => navigate(PORTAL_PATHS.startSee(a.agentId))}
            >
              {a.name}
            </button>
          ))}
        </fieldset>
      ) : null}
      {chosen ? (
        <AgentSee key={chosen.agentId} agentId={chosen.agentId} lead={lead} />
      ) : (
        <p className="text-ink-muted">{t("setup.see.pick")}</p>
      )}
    </div>
  );
}

function useIsAdmin(): boolean {
  const session = useSession();
  const client =
    session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  return client?.role === "client_admin";
}

/** The lead's first name, for "Ana has this". */
function firstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

function AgentSee({ agentId, lead }: { agentId: string; lead: string | null }) {
  const walk = useApi(gettingStartedRoutes.portalSetupWalkthrough, { params: { id: agentId } });
  return (
    <Loaded state={walk} skeleton={<SkeletonRows rows={5} columns={1} />}>
      {(w) => <Walk initial={w} lead={firstName(lead)} />}
    </Loaded>
  );
}

function Walk({ initial, lead }: { initial: WalkthroughView; lead: string | null }) {
  const { t, ...i18n } = useI18n();
  const api = useApiClient();
  const isAdmin = useIsAdmin();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setView(initial), [initial]);
  const sop = useApi(sopRoutes.portalAgentSop, { params: { id: view.agentId } });
  const id = view.agentId;

  async function mark(stepId: string, body: WalkMarkBody): Promise<boolean> {
    setError(null);
    try {
      setView(
        await api.call(gettingStartedRoutes.portalSetupWalkMark, { params: { id, stepId }, body }),
      );
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  }

  // A running try is read again every two seconds, its steps appearing as it goes; once it is done
  // the whole view is read again (what's left to try, and whether another may start).
  const running = view.tries.recent.find((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const out = await api.call(gettingStartedRoutes.portalSetupTryView, {
          params: { id, runId: running.runId },
        });
        if (!live) return;
        if (out.try.status === "running") {
          setView((v) => withTry(v, out.try));
        } else {
          const next = await api.call(gettingStartedRoutes.portalSetupWalkthrough, {
            params: { id },
          });
          if (live) setView(next);
        }
      } catch (e) {
        if (live) setError(e);
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, id, running]);

  async function startTry(documentId: string): Promise<void> {
    setError(null);
    try {
      const out = await api.call(gettingStartedRoutes.portalSetupTry, {
        params: { id },
        body: { documentId },
      });
      setView((v) => ({
        ...v,
        canTry: false,
        tries: { ...v.tries, used: v.tries.used + 1, recent: [out.try, ...v.tries.recent] },
      }));
    } catch (e) {
      setError(e);
    }
  }

  async function verdict(runId: string, stepId: string, because: string | null) {
    setError(null);
    try {
      const out = await api.call(gettingStartedRoutes.portalSetupTryVerdict, {
        params: { id, runId, stepId },
        body: because === null ? { right: true } : { right: false, because },
      });
      setView((v) => withTry(v, out.try));
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid={`start-see-${id}`}>
      <p className="text-ink-muted">{t("setup.see.intro", { name: view.name })}</p>
      {view.canSign ? null : (
        <p className="text-sm text-ink-muted" data-testid="start-see-read-only">
          {t("setup.see.readOnly")}
        </p>
      )}
      {error ? <ErrorNotice error={error} /> : null}
      <section>
        <SectionLabel>{t("setup.see.steps")}</SectionLabel>
        <Loaded state={sop} skeleton={<SkeletonRows rows={6} columns={1} />}>
          {(s) => (
            <Steps
              lines={s.procedure}
              marks={view.marks}
              canSign={view.canSign}
              lead={lead}
              onMark={mark}
            />
          )}
        </Loaded>
      </section>
      <AdjustSettings
        id={id}
        name={view.name}
        isAdmin={isAdmin}
        scheduleText={(cron) => scheduleWords(cron, { t, locale: i18n.locale })}
      />
      <TrySection view={view} lead={lead} onTry={startTry} onVerdict={verdict} />
    </div>
  );
}

function withTry(v: WalkthroughView, one: TryView): WalkthroughView {
  return {
    ...v,
    tries: { ...v.tries, recent: v.tries.recent.map((r) => (r.runId === one.runId ? one : r)) },
  };
}

// ── The steps ────────────────────────────────────────────────────────────────────────────────

/** Each top-level step with what it holds (a decision's paths, a loop's steps). */
function groups(lines: readonly SopProcedureLine[]) {
  const out: { step: SopStepLine; inner: SopProcedureLine[] }[] = [];
  for (const l of lines) {
    if (l.line === "step" && l.depth === 0) out.push({ step: l, inner: [] });
    else out.at(-1)?.inner.push(l);
  }
  return out;
}

function Steps({
  lines,
  marks,
  canSign,
  lead,
  onMark,
}: {
  lines: readonly SopProcedureLine[];
  marks: readonly WalkMark[];
  canSign: boolean;
  lead: string | null;
  onMark: (stepId: string, body: WalkMarkBody) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const list = groups(lines);
  if (list.length === 0) return <p className="text-ink-muted">{t("setup.see.noSteps")}</p>;
  const byStep = new Map(marks.map((m) => [m.stepId, m]));
  return (
    <ol className="flex flex-col gap-3">
      {list.map(({ step, inner }) => (
        <StepCard
          key={step.id}
          step={step}
          inner={inner}
          mark={byStep.get(step.id) ?? null}
          canSign={canSign}
          lead={lead}
          onMark={(body) => onMark(step.id, body)}
        />
      ))}
    </ol>
  );
}

function HowItWorks({ step }: { step: SopStepLine }) {
  const { t } = useI18n();
  let words: string;
  switch (step.method) {
    case "rules":
      words = t("sop.method.rules");
      break;
    case "ai":
      words = step.model ? `${t("sop.method.ai")} · ${step.model}` : t("sop.method.ai");
      break;
    case "rules_then_ai":
      words = `${t("sop.method.rulesThen")} ${t("sop.method.ai")}${step.model ? ` · ${step.model}` : ""}`;
      break;
    case "person":
      words = t("setup.see.person");
      break;
    default:
      words = step.kindWords;
  }
  return (
    <span
      className={step.method === "person" ? "text-sm text-copper-ink" : "text-sm text-ink-muted"}
      data-testid="start-see-how"
    >
      {words}
    </span>
  );
}

function StepFacts({ step }: { step: SopStepLine }) {
  const { t } = useI18n();
  const approvers =
    step.approval && step.approval.level !== "off" && step.approval.approvers.length
      ? step.approval.approvers
          .map((a) => (a.condition ? `${a.party.name} (${a.condition})` : a.party.name))
          .join(", ")
      : null;
  if (!step.who && !approvers && step.told.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5 text-sm text-ink">
      {step.who ? <li>{t("setup.see.who", { name: step.who.name })}</li> : null}
      {approvers ? <li>{t("setup.see.asksFirst", { names: approvers })}</li> : null}
      {step.told.length ? (
        <li>{t("setup.see.told", { names: step.told.map((p) => p.name).join(", ") })}</li>
      ) : null}
    </ul>
  );
}

function StepCard({
  step,
  inner,
  mark,
  canSign,
  lead,
  onMark,
}: {
  step: SopStepLine;
  inner: SopProcedureLine[];
  mark: WalkMark | null;
  canSign: boolean;
  lead: string | null;
  onMark: (body: WalkMarkBody) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"ok" | "different" | null>(null);
  const send = async (body: WalkMarkBody, which: "ok" | "different") => {
    setBusy(which);
    const ok = await onMark(body);
    setBusy(null);
    if (ok && which === "different") {
      setOpen(false);
      setText("");
    }
  };
  return (
    <li
      className="rounded-md border border-line bg-surface p-4"
      data-testid={`see-step-${step.id}`}
    >
      <div className="flex items-start gap-3">
        <span className="w-8 shrink-0 font-mono text-sm text-ink-muted">{step.number}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="text-ink">{step.name}</h3>
            <HowItWorks step={step} />
          </div>
          <p className="text-sm text-ink-muted">{step.purpose}</p>
          <StepFacts step={step} />
          {inner.length ? (
            <ul className="mt-2 flex flex-col gap-1 border-l border-line pl-3 text-sm">
              {inner.map((l, i) =>
                l.line === "path" ? (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: a path line has no id; its place is its key.
                    key={`path-${i}`}
                    className="text-ink-muted"
                    style={{ paddingLeft: `${(l.depth - 1) * 0.75}rem` }}
                  >
                    {l.label === "otherwise" ? t("setup.see.otherwise") : l.words}
                  </li>
                ) : (
                  <li
                    key={l.id}
                    className="text-ink"
                    style={{ paddingLeft: `${(l.depth - 1) * 0.75}rem` }}
                  >
                    <span className="font-mono text-ink-muted">{l.number}</span> {l.name}
                  </li>
                ),
              )}
            </ul>
          ) : null}

          {mark?.state === "asked" ? (
            <div
              className="mt-3 flex flex-wrap items-start gap-3 rounded-md border border-line bg-surface-subtle px-3 py-2"
              data-testid={`see-step-${step.id}-asked`}
            >
              <p className="min-w-0 flex-1 text-sm text-ink">
                {t("setup.see.youSaid", { text: mark.text ?? "" })}{" "}
                <span className="text-ink-muted">
                  {lead ? t("setup.see.withLead", { lead }) : t("setup.see.withUs")}
                </span>
              </p>
              <Badge tone="person">
                {mark.request
                  ? t("setup.see.request", { number: String(mark.request.number) })
                  : t("setup.see.asked")}
              </Badge>
            </div>
          ) : mark?.state === "ok" ? (
            <p className="mt-3 text-sm text-positive" data-testid={`see-step-${step.id}-ok`}>
              {mark.byName
                ? t("setup.see.lookedRightBy", { name: mark.byName })
                : t("setup.see.lookedRight")}
            </p>
          ) : null}

          {canSign && !open ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {mark?.state === "ok" ? null : (
                <Button
                  size="sm"
                  working={busy === "ok"}
                  onClick={() => void send({ ok: true }, "ok")}
                  data-testid={`see-step-${step.id}-ok-button`}
                >
                  {t("setup.see.looksRight")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpen(true)}
                data-testid={`see-step-${step.id}-different`}
              >
                {t("setup.see.different")}
              </Button>
            </div>
          ) : null}
          {canSign && open ? (
            <div className="mt-3 flex flex-col gap-2">
              <Field label={t("setup.see.differentLabel")} hint={t("setup.see.differentHint")}>
                <TextArea
                  rows={3}
                  autoSize
                  maxLength={2000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  data-testid={`see-step-${step.id}-text`}
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={text.trim() === ""}
                  working={busy === "different"}
                  onClick={() => void send({ different: text.trim() }, "different")}
                  data-testid={`see-step-${step.id}-send`}
                >
                  {lead ? t("setup.see.sendTo", { lead }) : t("common.send")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// ── Try it on a real one ─────────────────────────────────────────────────────────────────────

function TrySection({
  view,
  lead,
  onTry,
  onVerdict,
}: {
  view: WalkthroughView;
  lead: string | null;
  onTry: (documentId: string) => Promise<void>;
  onVerdict: (runId: string, stepId: string, because: string | null) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const left = Math.max(0, view.tries.max - view.tries.used);
  const running = view.tries.recent.some((r) => r.status === "running");
  return (
    <section className="flex flex-col gap-3" data-testid="start-see-try">
      <SectionLabel
        action={<span className="text-sm text-ink-muted">{t("setup.see.try.hint")}</span>}
      >
        {t("setup.see.try.title")}
      </SectionLabel>
      <p className="text-sm text-ink" data-testid="start-see-tries-left">
        {t("setup.see.try.left", { count: left, max: view.tries.max })}
        {left === 0 ? (
          <span className="text-ink-muted">
            {" "}
            {lead ? t("setup.see.try.usedUpLead", { lead }) : t("setup.see.try.usedUp")}
          </span>
        ) : running ? (
          <span className="text-ink-muted"> {t("setup.see.try.wait")}</span>
        ) : null}
      </p>
      {view.candidates.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("setup.see.try.none")}</p>
      ) : (
        <Card>
          {view.candidates.map((c) => (
            <Candidate key={c.documentId} c={c} canTry={view.canTry} onTry={onTry} />
          ))}
        </Card>
      )}
      {view.tries.recent.map((r) => (
        <TryCard key={r.runId} run={r} canSign={view.canSign} lead={lead} onVerdict={onVerdict} />
      ))}
    </section>
  );
}

function Candidate({
  c,
  canTry,
  onTry,
}: {
  c: TryCandidate;
  canTry: boolean;
  onTry: (documentId: string) => Promise<void>;
}) {
  const { t, fmt } = useI18n();
  const [busy, setBusy] = useState(false);
  const when = fmt.time(c.at);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
      data-testid={`see-candidate-${c.documentId}`}
    >
      <span className="min-w-0">
        <span className="block text-ink">{c.title}</span>
        <span className="block text-sm text-ink-muted">
          {c.from ? t("setup.see.try.from", { from: c.from, when }) : when}
        </span>
      </span>
      {canTry ? (
        <Button
          size="sm"
          working={busy}
          onClick={async () => {
            setBusy(true);
            await onTry(c.documentId);
            setBusy(false);
          }}
          data-testid={`see-candidate-${c.documentId}-try`}
        >
          {t("setup.see.try.this")}
        </Button>
      ) : null}
    </div>
  );
}

const STATE_KEYS = {
  done: "setup.see.try.state.done",
  running: "setup.see.try.state.running",
  waiting: "setup.see.try.state.waiting",
  skipped: "setup.see.try.state.skipped",
  failed: "setup.see.try.state.failed",
} as const;

function TryCard({
  run,
  canSign,
  lead,
  onVerdict,
}: {
  run: TryView;
  canSign: boolean;
  lead: string | null;
  onVerdict: (runId: string, stepId: string, because: string | null) => Promise<boolean>;
}) {
  const { t } = useI18n();
  return (
    <Card pad testId={`see-try-${run.runId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-ink">{run.title}</h3>
        <div className="flex flex-wrap gap-2">
          <Badge tone="accent">{t("setup.see.try.badge")}</Badge>
          <Badge
            tone={run.status === "failed" ? "risk" : run.status === "done" ? "positive" : "neutral"}
            testId={`see-try-${run.runId}-status`}
          >
            {t(
              run.status === "running"
                ? "setup.see.try.status.running"
                : run.status === "failed"
                  ? "setup.see.try.status.failed"
                  : "setup.see.try.status.done",
            )}
          </Badge>
        </div>
      </div>
      {run.steps.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">{t("setup.see.try.starting")}</p>
      ) : (
        <ol className="mt-3 flex flex-col divide-y divide-line">
          {run.steps.map((s) => (
            <TryStepRow
              key={s.id}
              step={s}
              runId={run.runId}
              canSay={canSign && run.status !== "running" && s.state !== "running"}
              lead={lead}
              onVerdict={onVerdict}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

function TryStepRow({
  step,
  runId,
  canSay,
  lead,
  onVerdict,
}: {
  step: TryStep;
  runId: string;
  canSay: boolean;
  lead: string | null;
  onVerdict: (runId: string, stepId: string, because: string | null) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [because, setBecause] = useState("");
  const [busy, setBusy] = useState<"right" | "not" | null>(null);
  const say = async (why: string | null) => {
    setBusy(why === null ? "right" : "not");
    const ok = await onVerdict(runId, step.id, why);
    setBusy(null);
    if (ok) {
      setOpen(false);
      setBecause("");
    }
  };
  return (
    <li className="py-3 first:pt-0 last:pb-0" data-testid={`see-try-step-${step.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-ink">{step.name}</span>
        <span className={step.person ? "text-sm text-copper-ink" : "text-sm text-ink-muted"}>
          {t(STATE_KEYS[step.state])}
        </span>
      </div>
      {step.summary ? <p className="text-sm text-ink-muted">{step.summary}</p> : null}
      {step.verdict === "right" ? (
        <p className="mt-1 text-sm text-positive">{t("setup.see.try.saidRight")}</p>
      ) : step.verdict === "not_right" ? (
        <p className="mt-1 text-sm text-ink">
          {t("setup.see.try.saidNotRight")}{" "}
          <span className="text-ink-muted">
            {lead ? t("setup.see.withLead", { lead }) : t("setup.see.withUs")}
          </span>
        </p>
      ) : null}
      {canSay && step.verdict === null && !open ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            working={busy === "right"}
            onClick={() => void say(null)}
            data-testid={`see-try-step-${step.id}-right`}
          >
            {t("setup.see.try.right")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen(true)}
            data-testid={`see-try-step-${step.id}-not-right`}
          >
            {t("setup.see.try.notRight")}
          </Button>
        </div>
      ) : null}
      {canSay && open ? (
        <div className="mt-2 flex flex-col gap-2">
          <Field label={t("setup.see.try.because")}>
            <TextArea
              rows={2}
              autoSize
              maxLength={2000}
              value={because}
              onChange={(e) => setBecause(e.target.value)}
              data-testid={`see-try-step-${step.id}-because`}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={because.trim() === ""}
              working={busy === "not"}
              onClick={() => void say(because.trim())}
              data-testid={`see-try-step-${step.id}-send`}
            >
              {lead ? t("setup.see.sendTo", { lead }) : t("common.send")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
