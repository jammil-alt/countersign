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
  type BuildIssue,
  type BuildItemOwner,
  type BuildPhase,
  buildIssues,
  DATA_SOURCES,
  type Dataset,
  decisionUnreviewed,
  FIT_REASON_MIN,
  FIT_SCOPE_WORDS,
  FIT_SCOPES,
  FIT_VERDICTS,
  FIT_WORDS,
  type FitGap,
  type FitRow,
  type FitScope,
  type FitVerdict,
  fitChangeKind,
  fitScope,
  ISSUE_SOURCE_WORDS,
  ITEM_STATE_WORDS,
  issueByKey,
  itemOpen,
  OWNER_WORDS,
  PHASE_WORDS,
  type QaCheckId,
  SETTLE_WAYS,
  SETTLE_WORDS,
  SETUP_KINDS,
  SETUP_WORDS,
  type SettleWay,
  type SetupField,
  type SetupKind,
  settledByStep,
  type TestPlan,
  withFitScope,
} from "@countersign/core";
import {
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type CallOptions, isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { voiceFor } from "../../api/voice";
import { DraftButton } from "../../ui/assist";
import { AssistScope } from "../../ui/assist-scope";
import { AgentBadge } from "../../ui/badges";
import { AgentSaid, ChatLog, Composer, Pending, Thinking, YouSaid } from "../../ui/chat";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Badge, Button, Card, Count, cx, Loading, Tag } from "../../ui/primitives";
import type { Voice } from "../../ui/voice";
import { CloseMenu, ReplyBox } from "./closeout";
import { DecisionsCard } from "./decisions";
import { type Fold, useFirstRows, useFold } from "./fold";
import { AboutLink, FocusBar, ProposalCard } from "./issues";
import type { DraftNowState } from "./NewBuild";
import { problemAdvice, problemWhere } from "./problems";
import { RequirementsCard } from "./RequirementsCard";
import { ShortText } from "./short";
import { TryCard } from "./TryCard";
import {
  BRIEF_STATE_TONE,
  BRIEF_STATE_WORDS,
  CLOSE_CHOICES,
  GAP_CHOICES,
  ITEM_KIND_WORDS,
  ITEM_TONE,
  plural,
  QA_STATE_WORDS,
  QA_TONE,
  SOURCE_WORDS,
  TO_BUILDER,
  VERDICT_TONE,
} from "./words";

type Act = <R extends RouteSpec>(route: R, opts: CallOptions<R>) => Promise<boolean>;

/**
 * Whether trying an action again can help: the Builder's own failures (its model, its answer) and
 * the server's or the network's. Not a refusal (a 400, a 409): the same call gets the same answer.
 */
function retryable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return (
    error.status === 0 ||
    error.status >= 500 ||
    ["builder_failed", "builder_unavailable", "edit_failed"].includes(error.code)
  );
}

/** How often a build whose tests are running is read again. */
export const TESTS_POLL_MS = 5000;

/**
 * The build read again, keeping the records it had where they're the same, so a panel's unsaved
 * edits of them (the brief, the fit-gap, the test plan) aren't reset by a refresh.
 */
function sameRecords(prev: BuildDetail | null, next: BuildDetail): BuildDetail {
  if (!prev) return next;
  const keep = <K extends "brief" | "fitgap" | "testPlan">(k: K) =>
    JSON.stringify(prev.build[k]) === JSON.stringify(next.build[k]) ? prev.build[k] : next.build[k];
  return {
    ...next,
    build: {
      ...next.build,
      brief: keep("brief"),
      fitgap: keep("fitgap"),
      testPlan: keep("testPlan"),
    },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A record merged three ways, by its top-level keys: what the panel had from the server (`base`),
 * what the operator has on screen (`mine`) and the server's new one (`theirs`). A key the operator
 * didn't change takes the server's; a key only the operator changed stays theirs.
 */
// DECISION: FLOW-1 (QA 2026-11-19) merges by top-level key (a brief's field; the fit-gap's rows,
// needs and setup; the test plan's datasets). Where both changed one key the server's wins: that is
// the panel's own save coming back (perhaps tidied by the server), or the Builder's newer answer.
export function mergeRecord<T extends object>(base: T, mine: T, theirs: T): T {
  const out = { ...theirs } as Record<string, unknown>;
  const b = base as Record<string, unknown>;
  const m = mine as Record<string, unknown>;
  const t = theirs as Record<string, unknown>;
  for (const k of new Set([...Object.keys(b), ...Object.keys(m)])) {
    if (same(m[k], b[k]) || !same(t[k], b[k])) continue;
    if (m[k] === undefined) delete out[k];
    else out[k] = m[k];
  }
  return out as T;
}

/**
 * A panel's working copy of one of the build's records (the brief, the fit-gap, the test plan).
 * FLOW-1 (QA 2026-11-19): a new record from the server no longer resets the operator's unsaved
 * edits: it is merged with them (`mergeRecord`).
 */
function useWorkingCopy<T extends object>(server: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(server);
  const base = useRef(server);
  const mine = useRef(value);
  mine.current = value;
  useEffect(() => {
    if (base.current === server) return;
    const was = base.current;
    base.current = server;
    setValue(same(mine.current, was) ? server : mergeRecord(was, mine.current, server));
  }, [server]);
  return [value, setValue];
}

export function BuildView({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const api = useApiClient();
  const loaded = useApi(apiRoutes.opsBuild, { params: { id } });
  const [detail, setDetail] = useState<BuildDetail | null>(loaded.data ?? null);
  const [viewing, setViewing] = useState<BuildPhase | null>(null);
  // FLOW-2 (QA 2026-11-19): every request on its way, not one slot. A chat turn sent while a move
  // ran cleared the one slot when it answered, and the move's button came back on while the move
  // was still running (a second press made a second draft). Each request now clears only itself.
  const [inFlight, setInFlight] = useState<{ n: number; path: string }[]>([]);
  const calls = useRef(0);
  const busy = busyPath(inFlight.map((f) => f.path));
  const [pending, setPending] = useState<{ text: string; since: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  // QA (2026-11-17, fourth run): a failure while saving or moving showed above the page while the
  // operator was at the brief's foot, and the button looked dead. The error comes into view.
  const errorBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [error]);
  // QA (2026-11-17): the action that failed, so the notice can offer to try it again.
  const lastAct = useRef<(() => Promise<boolean>) | null>(null);
  const split = useSplit();
  // The conversation's box, so an open question's "Answer" can start the reply there.
  const [draftText, setDraftText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  // Owner (2026-11-17): the issue the conversation is on (its key), and whether only its thread
  // shows. It follows the Builder: when its answer is about an issue, the next words are too.
  const [focus, setFocus] = useState<string | null>(null);
  const [threadOnly, setThreadOnly] = useState(false);
  // Owner (2026-11-19): a long page. Its sections fold, and the jump links open the one they go
  // to. Decisions starts shut when nothing waits on a check.
  const issuesFold = useFold("issues");
  const decisionsFold = useFold(
    "decisions",
    (detail?.build.fitgap.decisions ?? []).some(decisionUnreviewed),
  );

  useEffect(() => {
    const data = loaded.data;
    if (data) setDetail((prev) => sameRecords(prev, data));
  }, [loaded.data]);

  // builder-plan.md B0: while the tests (or a try) run, the build is read again every 5 seconds,
  // and no longer once they're done. Not while an action is on its way: its answer is newer.
  const busyNow = useRef(busy);
  busyNow.current = busy;
  const testsRunning =
    detail?.poc?.latest?.status === "running" ||
    (detail?.poc?.tries ?? []).some((t) => t.status === "running");
  useEffect(() => {
    if (!testsRunning) return;
    const timer = setInterval(() => {
      void api
        .call(apiRoutes.opsBuild, { params: { id } })
        .then((out) => {
          if (!busyNow.current) setDetail((prev) => sameRecords(prev, out as BuildDetail));
        })
        .catch(() => undefined);
    }, TESTS_POLL_MS);
    return () => clearInterval(timer);
  }, [testsRunning, api, id]);

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

  const issues = buildIssues(detail);
  // docs/builder-plan.md §4: any decision can be talked about, not only the ones that are issues.
  const focused = focus ? issueByKey(detail, focus, issues) : null;
  const issueOf = (key: string | undefined) => (key ? issueByKey(detail, key, issues) : null);
  const onIssue = (key: string, only = false) => {
    setFocus(key);
    setThreadOnly(only);
    box.current?.focus();
  };
  const offIssue = () => {
    setFocus(null);
    setThreadOnly(false);
  };
  // Owner (2026-11-21): an answer or a choice made on an issue's row goes to the Builder in that
  // issue's thread, as the conversation's words do when it is on that issue.
  const sayAbout = (text: string, key: string) => {
    setFocus(key);
    setThreadOnly(false);
    return say(text, key);
  };
  const rowVoice = voiceFor("ops", detail.build.client?.id ?? detail.build.testClient?.id);

  /** One change: the answer is the build as it is now. */
  const act: Act = async (route, opts) => {
    lastAct.current = () => act(route, opts);
    // QA (2026-11-17, fourth run): for the five minutes the draft was being made, the box said it
    // was about an old, answered question. A move to another phase starts the conversation there.
    if (route.path === apiRoutes.opsMoveBuild.path) offIssue();
    calls.current += 1;
    const n = calls.current;
    setInFlight((f) => [...f, { n, path: route.path }]);
    setError(null);
    try {
      const out = (await api.call(route, opts)) as BuildDetail;
      // FLOW-1 (QA 2026-11-19): an answer is always a new object; a record it didn't change keeps
      // its old one, so a panel's unsaved edits of it aren't reset by an unrelated action.
      setDetail((prev) => sameRecords(prev, out));
      setViewing(null);
      // The conversation stays on the issue the Builder answered about (or moved on to).
      const last = out.messages.at(-1);
      const talked =
        route.path === apiRoutes.opsBuildTurn.path ||
        route.path === apiRoutes.opsBuildProposal.path;
      if (talked && last?.role === "builder" && last.about) setFocus(last.about);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setInFlight((f) => f.filter((x) => x.n !== n));
    }
  };

  /** The operator's words (about the issue in focus), or none to try the Builder's last turn again. */
  async function say(
    text?: string,
    about: string | null = focused?.key ?? null,
    // docs/plan.md §1.165: a way chosen on the issue itself; its words are the way's own.
    settle?: SettleWay,
  ): Promise<boolean> {
    if (text) setPending({ text, since: Date.now() });
    try {
      const done = await act(apiRoutes.opsBuildTurn, {
        params: { id },
        body:
          settle && about ? { about, settle } : text ? { text, ...(about ? { about } : {}) } : {},
      });
      // QA (2026-11-16): the words are saved before the Builder answers, so after a failure the
      // conversation is shown as it is now, with them in it, not as it was before they were sent.
      if (!done) {
        await api
          .call(apiRoutes.opsBuild, { params: { id } })
          .then((out) => setDetail((prev) => sameRecords(prev, out as BuildDetail)))
          .catch(() => undefined);
      }
      return done;
    } finally {
      setPending(null);
    }
  }

  const moving = busy === apiRoutes.opsMoveBuild.path || busy === apiRoutes.opsBuildClientTest.path;
  const retrying = inFlight.some((f) => f.path === apiRoutes.opsBuildTurn.path) && !pending;
  const lastId = detail.messages.at(-1)?.id;
  const decide = (messageId: string, d: "agree" | "decline" | "undo") =>
    void act(apiRoutes.opsBuildProposal, {
      params: { id, messageId },
      body: { decide: d },
    }).then((ok) => {
      // Not this: the box is where the operator says what they'd do instead.
      if (ok && d === "decline") box.current?.focus();
    });
  const hasDecisions = b.phase !== "intake" || b.fitgap.decisions.length > 0;
  const shownMessages =
    threadOnly && focused
      ? detail.messages.filter((m) => m.about === focused.key)
      : detail.messages;
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
      {/* §1.149.2: a client's build from a template reads its Requirements from the intake. */}
      {b.client && b.templateId ? (
        <RequirementsCard clientId={b.client.id} templateId={b.templateId} />
      ) : null}

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
      {error ? (
        <div ref={errorBox} className="flex flex-col gap-2" data-testid="build-error">
          <ErrorNotice error={error} />
          {retryable(error) && lastAct.current ? (
            <div>
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() => void lastAct.current?.()}
                data-testid="build-error-retry"
              >
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Feedback (2026-11-16): the conversation stays within the screen and scrolls on its own;
          on a wide screen the line between the two columns drags to make either wider. */}
      <div
        className="grid items-start gap-6 xl:grid-cols-[var(--build-chat-w)_minmax(0,1fr)] xl:gap-0"
        style={{ "--build-chat-w": `${split.width}px` } as CSSProperties}
      >
        <section
          className="ds-card flex flex-col xl:sticky xl:top-[calc(var(--header-h)+16px)] xl:max-h-[calc(100vh-var(--header-h)-32px)]"
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
          <div
            className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
            data-testid="build-chat-scroll"
            data-chat-scroll
          >
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
              {shownMessages.map((m) =>
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
                    {issueOf(m.about) ? (
                      <AboutLink
                        issue={issueOf(m.about) as BuildIssue}
                        focused={m.about === focused?.key}
                        onFocus={() => onIssue(m.about as string)}
                      />
                    ) : null}
                    {m.proposal ? (
                      <ProposalCard
                        proposal={m.proposal}
                        live={open}
                        busy={isBusy(busy)}
                        onDecide={(d) => decide(m.id, d)}
                      />
                    ) : null}
                    {m.failed && m.id === lastId && open ? (
                      <div>
                        <Button
                          size="sm"
                          disabled={isBusy(busy)}
                          onClick={() => void say()}
                          data-testid="build-retry"
                        >
                          Retry
                        </Button>
                      </div>
                    ) : null}
                    {m.chips.length > 0 && m.id === lastId && open ? (
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
              ) : moving || retrying ? (
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
              {focused ? (
                <FocusBar
                  issue={focused}
                  threadOnly={threadOnly}
                  onThread={setThreadOnly}
                  onClear={offIssue}
                />
              ) : null}
              <Composer
                label="Message to the Builder"
                placeholder={focused ? FOCUSED_PLACEHOLDER : PLACEHOLDER[b.phase]}
                busy={!!pending}
                value={draftText}
                onValueChange={setDraftText}
                inputRef={box}
                onSend={(text) => say(text)}
                inputTestId="build-input"
                sendTestId="build-send"
                voice={voiceFor("ops", b.client?.id ?? b.testClient?.id)}
                tools={
                  <DraftButton
                    field="build.answer"
                    context={{
                      buildId: b.id,
                      clientId: b.client?.id ?? b.testClient?.id,
                      ref: focused?.key,
                    }}
                    current={() => draftText}
                    onUse={setDraftText}
                    testId="build-input-draft"
                  />
                }
              />
            </div>
          ) : null}
        </section>

        <div className="relative flex min-w-0 flex-col gap-5 xl:pl-6">
          <SplitHandle split={split} />
          <BuildBar
            links={[
              {
                id: "build-at-phase",
                label: PHASE_WORDS[shown].label,
              },
              {
                id: "build-at-issues",
                label: "Issues",
                count: issues.filter((i) => i.open).length,
                fold: issuesFold,
              },
              ...(hasDecisions
                ? [
                    {
                      id: "build-at-decisions",
                      label: "Decisions",
                      count: b.fitgap.decisions.filter(decisionUnreviewed).length,
                      fold: decisionsFold,
                    },
                  ]
                : []),
            ]}
          >
            <WorkingStrip busy={busy} phase={b.phase} talking={!!pending} />
          </BuildBar>
          <div id="build-at-phase" className="ui-build-anchor flex flex-col gap-5">
            <PhasePanel
              phase={shown}
              detail={detail}
              current={shown === b.phase && open}
              busy={busy}
              act={act}
              onAbout={
                open
                  ? (title) => {
                      setDraftText((t) => aboutStart(title, t));
                      box.current?.focus();
                    }
                  : undefined
              }
            />
          </div>
          <div id="build-at-issues" className="ui-build-anchor">
            <ItemsPanel
              fold={issuesFold}
              detail={detail}
              issues={issues}
              focus={focused?.key ?? null}
              onTalk={open ? onIssue : undefined}
              onSettle={
                open && (b.phase === "draft" || b.phase === "poc")
                  ? (key, way) => {
                      onIssue(key);
                      void say(SETTLE_WORDS[way].ask, key, way);
                    }
                  : undefined
              }
              onWalk={
                open
                  ? () => {
                      offIssue();
                      void say("Walk me through the open issues, one at a time.", null);
                    }
                  : undefined
              }
              busy={busy}
              act={act}
              onSay={open ? sayAbout : undefined}
              voice={rowVoice}
            />
          </div>
          {/* docs/builder-plan.md §4: the Builder's decisions, beside the issues and known risks. */}
          {hasDecisions ? (
            <div id="build-at-decisions" className="ui-build-anchor">
              <DecisionsCard
                fold={decisionsFold}
                detail={detail}
                focus={focused?.key ?? null}
                onTalk={open ? onIssue : undefined}
                onSay={open ? sayAbout : undefined}
                voice={rowVoice}
                busy={isBusy(busy)}
                act={act}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// The conversation's width on a wide screen: dragged, or moved with the arrow keys, between these
// bounds, and kept for this browser.
const SPLIT_KEY = "mezonas.build.chatWidth";
const SPLIT_MIN = 320;
const SPLIT_MAX = 900;
const SPLIT_DEFAULT = 420;

interface Split {
  width: number;
  setWidth(width: number): void;
}

export function clampSplit(width: number): number {
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, width)));
}

function useSplit(): Split {
  const [width, set] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SPLIT_KEY));
      return saved ? clampSplit(saved) : SPLIT_DEFAULT;
    } catch {
      return SPLIT_DEFAULT;
    }
  });
  return {
    width,
    setWidth(next) {
      const w = clampSplit(next);
      set(w);
      try {
        localStorage.setItem(SPLIT_KEY, String(w));
      } catch {
        // The width is a convenience; it just isn't kept.
      }
    },
  };
}

/** The line between the columns: drag it, or focus it and use the arrows; a double click resets. */
function SplitHandle({ split }: { split: Split }) {
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const from = e.clientX;
    const was = split.width;
    const move = (ev: PointerEvent) => split.setWidth(was + ev.clientX - from);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no element of its own.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the conversation"
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      aria-valuenow={split.width}
      tabIndex={0}
      data-testid="build-split"
      onPointerDown={start}
      onDoubleClick={() => split.setWidth(SPLIT_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") split.setWidth(split.width - 24);
        else if (e.key === "ArrowRight") split.setWidth(split.width + 24);
        else return;
        e.preventDefault();
      }}
      className="group absolute top-0 bottom-0 left-0 hidden w-6 cursor-col-resize justify-center outline-none xl:flex"
    >
      <span
        aria-hidden
        className="h-full w-px bg-line group-hover:bg-slate group-focus-visible:bg-slate"
      />
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

/**
 * The box's hint while it is on an issue. Owner (2026-11-21): the whole question in it read as
 * text already typed. The "About" line over the box names the issue, so the hint stays short.
 */
export const FOCUSED_PLACEHOLDER = "Type your answer, or ask the Builder";

function BuildHeader({ detail }: { detail: BuildDetail }) {
  const b = detail.build;
  const agentLink = b.agentId ? `/ops/agents/${b.agentId}` : null;
  return (
    <header className="flex flex-col gap-2" data-testid="build-header">
      <p className="eyebrow text-ink-muted">
        <Link to="/ops/lab?tab=drafts" className="hover:underline">
          Agent lab · Drafts
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
          // QA (2026-11-17): one name and one count, the Issues panel's.
          plural(buildIssues(detail).filter((i) => i.open).length, "open issue"),
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

/**
 * While anything on the page is under way: one line that stays in sight wherever the page is
 * scrolled (owner, 2026-11-19: the faded buttons read as stuck). Not for the first half second, so
 * a quick save doesn't flash it.
 */
function WorkingStrip({
  busy,
  phase,
  talking,
}: {
  busy: string | null;
  phase: BuildPhase;
  talking: boolean;
}) {
  const [since, setSince] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSince(null);
      setShown(false);
      return;
    }
    setSince(Date.now());
    const t = setTimeout(() => setShown(true), 500);
    return () => clearTimeout(t);
  }, [busy]);
  if (!busy || !shown) return null;
  const label =
    busy === apiRoutes.opsDraftBuildNow.path
      ? DRAFTING_NOW
      : busy === apiRoutes.opsMoveBuild.path
        ? NEXT_WORKING[phase]
        : busy === apiRoutes.opsBuildTurn.path ||
            busy === apiRoutes.opsBuildProposal.path ||
            talking
          ? "The Builder is working on it…"
          : busy === apiRoutes.opsBuildCases.path
            ? "The Builder is making the test cases…"
            : busy === apiRoutes.opsBuildRunTests.path
              ? "Starting the test cases…"
              : "Saving…";
  return (
    <div className="ui-build-bar__working" data-testid="build-working">
      <Thinking
        badge={<AgentBadge name="Builder" size="sm" />}
        label={label}
        state={busy === apiRoutes.opsMoveBuild.path ? "drafting" : "tracing"}
        since={since ?? undefined}
      />
    </div>
  );
}

interface JumpLink {
  /** The section's element id. */
  id: string;
  label: string;
  /** What waits there: open issues, decisions to check. */
  count?: number;
  /** A folded section opens when it is jumped to. */
  fold?: Fold;
}

/**
 * Over the build's sections, staying in sight as the page scrolls (owner, 2026-11-19): a link to
 * each section with what waits in it, and what the Builder is doing while it works.
 */
function BuildBar({ links, children }: { links: JumpLink[]; children: ReactNode }) {
  const jump = (l: JumpLink) => {
    l.fold?.reveal();
    // After the section has opened, so the jump lands on its full height.
    requestAnimationFrame(() =>
      document.getElementById(l.id)?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
    );
  };
  // DECISION (owner, 2026-11-21, plan §1.167): the page showed through the gap over the bar as
  // it scrolled. The bar's holder sticks right under the header and fills that gap with the
  // page's own ground.
  return (
    <div className="ui-build-stick">
      <div className="ui-build-bar" data-testid="build-bar">
        <nav aria-label="Sections of the build" className="ui-build-bar__links">
          {links.map((l) => (
            <button
              key={l.id}
              type="button"
              className="ui-build-bar__link"
              onClick={() => jump(l)}
              data-testid={`build-jump-${l.id.replace("build-at-", "")}`}
            >
              {l.label}
              {l.count ? <Count n={l.count} tone="warning" /> : null}
            </button>
          ))}
        </nav>
        {children}
      </div>
    </div>
  );
}

/** What the Builder is doing while it drafts at once (docs/plan.md §1.165). */
const DRAFTING_NOW =
  "The Builder is drafting it from your description. It decides what's open; this takes a minute or two…";

/** What the Builder is doing while a phase's move runs. */
const NEXT_WORKING: Record<BuildPhase, string> = {
  intake: "The Builder is giving the brief a second look, then checking it against the catalog…",
  fitgap: "The Builder is drafting the workflow from the brief and the fit-gap…",
  draft: "The Builder is setting up the POC test…",
  poc: "Moving on…",
  client_test: "Moving to QA…",
  qa: "Saving…",
};

/** The move out of a phase: its button, off with the gate's reasons while they hold. */
function Next({
  label,
  detail,
  busy,
  onClick,
  testId,
  extra,
  why,
}: {
  label: string;
  detail: BuildDetail;
  busy: boolean;
  onClick(): void;
  testId: string;
  extra?: ReactNode;
  /** Why the button is off besides the gate's reasons (FLOW-8: no client picked to test with). */
  why?: ReactNode;
}) {
  const reasons = detail.gate.reasons;
  // Feedback (2026-11-16): a move can take the Builder a minute (agreeing the brief drafts the
  // fit-gap; agreeing the fit-gap drafts the workflow). While it works, the button says so and the
  // Builder's thinking loop runs beside it with the time it has taken, as it does in the chat.
  // QA (2026-11-16): only this button's own move: `busy` is also true while a chat turn runs, and
  // the loop then said it was drafting the workflow when the Builder was answering a message.
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    if (!busy) setSince(null);
  }, [busy]);
  const working = busy && since !== null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {extra}
        <Button
          variant="primary"
          disabled={busy || reasons.length > 0}
          working={working}
          onClick={() => {
            setSince(Date.now());
            onClick();
          }}
          data-testid={testId}
        >
          {working ? "Working…" : label}
        </Button>
        {working ? (
          <Thinking
            badge={<AgentBadge name="Builder" size="sm" />}
            label={NEXT_WORKING[detail.build.phase]}
            state={detail.build.phase === "fitgap" ? "drafting" : "tracing"}
            since={since ?? undefined}
            testId={`${testId}-working`}
          />
        ) : (
          <span className="text-sm text-ink-muted">{PHASE_WORDS[detail.build.phase].closes}</span>
        )}
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
      {why ? (
        <div className="text-sm text-ink-muted" data-testid={`${testId}-why`}>
          {why}
        </div>
      ) : null}
    </div>
  );
}

/** Draft (§1.168): the phase's long fields are about this build and its client. */
function PhasePanel(props: Parameters<typeof PhaseBody>[0]) {
  const b = props.detail.build;
  return (
    <AssistScope value={{ buildId: b.id, clientId: b.client?.id ?? b.testClient?.id }}>
      <PhaseBody {...props} />
    </AssistScope>
  );
}

function PhaseBody(props: {
  phase: BuildPhase;
  detail: BuildDetail;
  current: boolean;
  busy: string | null;
  act: Act;
  /** Starts the operator's words about something in the conversation's box. */
  onAbout?: ((title: string) => void) | undefined;
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

/** Moves between phases: the longest requests, and the one the page says it's working on first. */
const MOVES: readonly string[] = [
  apiRoutes.opsMoveBuild.path,
  apiRoutes.opsDraftBuildNow.path,
  apiRoutes.opsBuildClientTest.path,
  apiRoutes.opsBuildDecision.path,
];

/**
 * What the page is busy with, of the requests on their way: a move if one is, else the latest.
 * Null only when none is, so a button that waits on `busy` stays off until every one has answered.
 */
export function busyPath(paths: readonly string[]): string | null {
  return paths.find((p) => MOVES.includes(p)) ?? paths.at(-1) ?? null;
}

/**
 * The conversation's box after a try's "Wrong": the "About …" start put before what's typed there
 * (FLOW-10, QA 2026-11-19: it replaced it). An earlier start is swapped. An issue's "Answer it"
 * opens its own box under the issue (owner, 2026-11-21).
 */
export function aboutStart(title: string, typed: string): string {
  return `About “${title}”: ${typed.replace(/^About “[^”]*”: /, "")}`;
}

// ── 1 Intake ────────────────────────────────────────────────────────────────────────────────────

function IntakePanel({ detail, current, busy, act }: PanelProps) {
  const id = detail.build.id;
  const [brief, setBrief] = useWorkingCopy<Brief>(detail.build.brief);
  const dirty = JSON.stringify(brief) !== JSON.stringify(detail.build.brief);
  // docs/plan.md §1.165: a build started with a description (the lab's New) is drafted as its page
  // opens, once: the words leave the router's state first, so a reload doesn't ask again (the
  // server would refuse it anyway: the build has its draft).
  const location = useLocation();
  const navigate = useNavigate();
  const wanted = (location.state as Partial<DraftNowState> | null)?.draftNow;
  const asked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once, when the page opens.
  useEffect(() => {
    if (!wanted || asked.current || !current || detail.build.kind !== "agent") return;
    asked.current = true;
    navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    void act(apiRoutes.opsDraftBuildNow, { params: { id }, body: { description: wanted } });
  }, [wanted, current]);
  const draftingNow = busy === apiRoutes.opsDraftBuildNow.path;
  const canDraftNow = detail.build.kind === "agent" && !!brief.goal?.text.trim();
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
                  working={busy === apiRoutes.opsUpdateBuild.path}
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
              busy={isBusy(busy)}
              testId="build-confirm-brief"
              // QA (2026-11-17): with a change not saved the button did nothing, and nothing said
              // why. Confirming saves the brief as it reads on screen first.
              onClick={async () => {
                if (
                  dirty &&
                  !(await act(apiRoutes.opsUpdateBuild, { params: { id }, body: { brief } }))
                )
                  return;
                void act(apiRoutes.opsMoveBuild, { params: { id }, body: { to: "fitgap" } });
              }}
            />
            {/* Owner (2026-11-21): the way past the questions. The Builder drafts from the brief
                as it reads on screen, decides what is still open and lists each decision. */}
            {detail.build.kind === "agent" ? (
              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
                <Button
                  size="sm"
                  disabled={isBusy(busy) || !canDraftNow}
                  working={draftingNow}
                  onClick={async () => {
                    if (
                      dirty &&
                      !(await act(apiRoutes.opsUpdateBuild, { params: { id }, body: { brief } }))
                    )
                      return;
                    void act(apiRoutes.opsDraftBuildNow, { params: { id }, body: {} });
                  }}
                  data-testid="build-draft-now"
                >
                  {draftingNow ? "Drafting…" : "Skip the questions and draft it now"}
                </Button>
                <span className="text-sm text-ink-muted" data-testid="build-draft-now-hint">
                  {canDraftNow
                    ? "The Builder decides what's still open, lists each decision, and you change it after."
                    : "Say what it should do in Goal first."}
                </span>
              </div>
            ) : null}
          </div>
        ) : null
      }
    >
      {/* DECISION (owner, 2026-11-21, plan §1.167): "lets redesign this side". Each field's name
          and how sure we are share a line; its words sit below at full width, in a box as tall
          as they are. */}
      <div className="flex flex-col">
        {BRIEF_FIELDS.map((k) => {
          const f = brief[k];
          return (
            <div
              key={k}
              className="flex flex-col gap-2 border-b border-line px-6 py-4 last:border-b-0"
              data-testid={`build-brief-row-${k}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{BRIEF_LABELS[k]}</span>
                {current && f ? (
                  <fieldset className="ds-seg" aria-label={`${BRIEF_LABELS[k]}: how sure`}>
                    {BRIEF_STATES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={f.state === s}
                        data-testid={`build-brief-${k}-${s}`}
                        // QA (2026-11-17, fourth run): a status change left the brief unsaved and
                        // Confirm looked dead until "Save the brief". A status is one choice, not
                        // typing: it saves at once, with the brief as it reads on screen.
                        onClick={() => {
                          if (f.state === s) return;
                          const next: Brief = { ...brief, [k]: { ...f, state: s } };
                          setBrief(next);
                          void act(apiRoutes.opsUpdateBuild, {
                            params: { id },
                            body: { brief: next },
                          });
                        }}
                      >
                        {BRIEF_STATE_WORDS[s]}
                      </button>
                    ))}
                  </fieldset>
                ) : f ? (
                  <Badge tone={BRIEF_STATE_TONE[f.state]}>{BRIEF_STATE_WORDS[f.state]}</Badge>
                ) : null}
              </div>
              {current ? (
                <TextArea
                  autoSize
                  aria-label={BRIEF_LABELS[k]}
                  rows={2}
                  placeholder={BRIEF_HINTS[k]}
                  value={f?.text ?? ""}
                  data-testid={`build-brief-${k}`}
                  assist={`build.brief.${k}`}
                  onChange={(e) => set(k, { text: e.target.value })}
                />
              ) : (
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">
                  {f?.text || <span className="text-ink-muted">Not asked</span>}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── 2 Fit-gap ───────────────────────────────────────────────────────────────────────────────────

function FitGapPanel({ detail, current, busy, act }: PanelProps) {
  const id = detail.build.id;
  const [fitgap, setFitgap] = useWorkingCopy<FitGap>(detail.build.fitgap);
  const [only, setOnly] = useState<FitVerdict | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const dirty = JSON.stringify(fitgap) !== JSON.stringify(detail.build.fitgap);
  const inScope = fitgap.rows.filter((r) => !r.dropped);
  const risks = inScope.filter((r) => r.later).length;
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
            {risks > 0 ? (
              <Badge tone="neutral" testId="build-fit-risks">
                {plural(risks, "known risk")}
              </Badge>
            ) : null}
          </span>
        }
      >
        {fitgap.rows.length === 0 ? (
          current ? (
            <div
              className="flex flex-wrap items-center gap-3 px-6 py-5"
              data-testid="build-fitgap-empty"
            >
              <p className="text-sm text-ink-muted">
                {detail.messages.at(-1)?.failed
                  ? "The Builder's fit-gap didn't come through, so there's nothing here yet."
                  : "No fit-gap yet."}
              </p>
              <Button
                size="sm"
                disabled={isBusy(busy)}
                working={busy === apiRoutes.opsBuildTurn.path}
                onClick={() => void act(apiRoutes.opsBuildTurn, { params: { id }, body: {} })}
                data-testid="build-fitgap-write"
              >
                Ask the Builder to write it
              </Button>
            </div>
          ) : (
            <p className="px-6 py-5 text-sm text-ink-muted">
              The Builder writes the fit-gap when the brief is confirmed.
            </p>
          )
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
                  <th className="px-4 py-2.5 font-medium">In</th>
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
                    onScope={(scope) =>
                      setFitgap((f) => ({
                        ...f,
                        rows: f.rows.map((x) => (x.id === r.id ? withFitScope(x, scope) : x)),
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
              : "Each becomes an issue until it is"
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
            busy={isBusy(busy)}
            testId="build-agree"
            // Agreeing saves the fit-gap as it reads on screen first (as Confirm the brief does).
            onClick={async () => {
              if (
                dirty &&
                !(await act(apiRoutes.opsUpdateBuild, { params: { id }, body: { fitgap } }))
              )
                return;
              void act(apiRoutes.opsMoveBuild, { params: { id }, body: { to: "draft" } });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** An intake field's kind, the three side by side (Connect a tool, Answer, File). */
function SetupKindChoice({
  label,
  value,
  testId,
  onChange,
}: {
  label: string;
  value: SetupKind;
  testId: string;
  onChange: (kind: SetupKind) => void;
}) {
  return (
    <fieldset className="ds-seg" aria-label={label} data-testid={testId}>
      {SETUP_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          data-testid={`${testId}-${k}`}
          onClick={() => onChange(k)}
        >
          {SETUP_WORDS[k]}
        </button>
      ))}
    </fieldset>
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
              className="w-auto min-w-60 flex-1"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              data-testid="build-setup-new"
            />
            <SetupKindChoice
              label="Kind of field"
              value={kind}
              testId="build-setup-new-kind"
              onChange={setKind}
            />
            <Button size="sm" type="submit" disabled={!label.trim()} data-testid="build-setup-add">
              Add
            </Button>
          </form>
        ) : null
      }
    >
      {fields.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          The Builder drafts the form with the fit-gap: the tools each client connects, and the
          answers and files we ask for.
        </p>
      ) : (
        // DECISION (owner, 2026-11-21, plan §1.167): "you can't read the fields". One block per
        // field, each part at full width: the question, its kind, why we ask (or an example), and
        // whether we ask it.
        <ul className="flex flex-col">
          {fields.map((f) => {
            const editing = current && !f.dropped;
            return (
              <li
                key={f.id}
                className="flex flex-col gap-3 border-b border-line px-6 py-4 last:border-b-0"
                data-testid={`build-setup-${f.id}`}
              >
                {editing ? (
                  <Field label="What we ask">
                    <TextArea
                      autoSize
                      rows={1}
                      aria-label={`Field: ${f.label}`}
                      value={f.label}
                      onChange={(e) => edit(f.id, { label: e.target.value })}
                      data-testid={`build-setup-${f.id}-label`}
                    />
                  </Field>
                ) : (
                  <p
                    className={cx(
                      "text-sm font-medium text-ink",
                      f.dropped && "text-ink-muted line-through",
                    )}
                  >
                    {f.label}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {editing ? (
                    <SetupKindChoice
                      label={`Kind: ${f.label}`}
                      value={f.kind}
                      testId={`build-setup-${f.id}-kind`}
                      onChange={(kind) => edit(f.id, { kind })}
                    />
                  ) : (
                    <Tag>{SETUP_WORDS[f.kind]}</Tag>
                  )}
                  <button
                    type="button"
                    className="ds-choice text-sm disabled:cursor-default disabled:opacity-60"
                    role="switch"
                    aria-checked={!f.dropped}
                    aria-label={`Ask it: ${f.label}`}
                    disabled={!current}
                    data-testid={`build-setup-${f.id}-ask`}
                    onClick={() => edit(f.id, { dropped: !f.dropped })}
                  >
                    <span className="ds-switch" />
                    {f.dropped ? "Not asked" : "Ask it"}
                  </button>
                </div>
                {editing ? (
                  <Field label="Why, or an example">
                    <TextArea
                      autoSize
                      rows={1}
                      aria-label={`Hint: ${f.label}`}
                      placeholder="Why we need it, or an example answer"
                      value={f.hint}
                      onChange={(e) => edit(f.id, { hint: e.target.value })}
                      data-testid={`build-setup-${f.id}-hint`}
                      assist={{ field: "build.setup.hint", ref: `setup:${f.id}` }}
                    />
                  </Field>
                ) : f.hint ? (
                  <p
                    className={cx(
                      "text-sm leading-relaxed text-ink-muted",
                      f.dropped && "line-through",
                    )}
                  >
                    {f.hint}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
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
  onScope: (scope: FitScope) => void;
  onChange: () => void;
  onSend: (to: FitVerdict, reason: string) => Promise<void>;
}) {
  const owner = FIT_ITEM_OWNER[r.verdict];
  const scope = fitScope(r);
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
          {r.later ? (
            <p className="mt-1 text-xs" data-testid={`build-fit-${r.id}-risk`}>
              Known risk: not built in the first version. Until it shows up in runs, a person
              handles it.
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
          ) : r.later ? (
            <p className="mt-1 text-xs" data-testid={`build-fit-${r.id}-item`}>
              Put off as an issue when you agree the direction, to pick up when it shows up.
            </p>
          ) : owner ? (
            <p className="mt-1 text-xs" data-testid={`build-fit-${r.id}-item`}>
              Becomes an issue for {OWNER_WORDS[owner]} when you agree the direction.
            </p>
          ) : null}
        </td>
        <td className="px-4 py-3">
          {current ? (
            <Select
              aria-label={`In: ${r.need}`}
              className="w-40"
              value={scope}
              data-testid={`build-fit-${r.id}-scope`}
              onChange={(e) => onScope(e.target.value as FitScope)}
            >
              {FIT_SCOPES.map((k) => (
                <option key={k} value={k}>
                  {FIT_SCOPE_WORDS[k]}
                </option>
              ))}
            </Select>
          ) : (
            <Tag>{FIT_SCOPE_WORDS[scope]}</Tag>
          )}
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
  // QA (2026-11-17): it started on the first option (Native), so accepting the default proposed
  // the biggest change; nothing is chosen until the operator picks.
  const [to, setTo] = useState<FitVerdict | "">("");
  const [reason, setReason] = useState("");
  const as = to ? fitChangeKind(row.verdict, to) : null;
  const short = reason.trim().length < FIT_REASON_MIN;
  return (
    <div className="flex flex-col gap-2.5" data-testid={`build-fit-${row.id}-form`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink">It's {FIT_WORDS[row.verdict]} now. It should be</span>
        <Select
          aria-label={`New verdict: ${row.need}`}
          className="w-40"
          value={to}
          onChange={(e) => setTo(e.target.value as FitVerdict | "")}
          data-testid={`build-fit-${row.id}-to`}
        >
          <option value="" disabled>
            Pick one
          </option>
          {options.map((v) => (
            <option key={v} value={v}>
              {FIT_WORDS[v]}
            </option>
          ))}
        </Select>
      </div>
      {as === null ? null : (
        <p className="text-xs text-ink-muted">
          {as === "challenge"
            ? "That's less work, so the Builder checks it against the catalog and answers in the conversation. Say why you think we have it: the part that does it, or what the client really does at this step. If the row doesn't describe the step right, say how it should read."
            : "That's more work, so it changes now and stays when the Builder writes the fit-gap again. Say why the Builder's verdict is wrong: what's missing, or what makes this case harder."}
        </p>
      )}
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
        assist={{ field: "build.fit.reason", ref: `fit:${row.id}` }}
      />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={busy || short || !to}
          onClick={() => {
            if (to) void onSend(to, reason.trim());
          }}
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
  const problems = useFirstRows(d?.problems ?? [], {
    first: 3,
    noun: "problems",
    testId: "build-draft-problems-more",
  });
  const link =
    b.kind === "skill"
      ? d?.sessionId
        ? `/ops/skills/new?session=${d.sessionId}`
        : null
      : b.agentId
        ? // Straight to the draft's workflow, not the agent's overview (owner, 2026-11-16).
          `/ops/agents/${b.agentId}/workflow`
        : null;
  return (
    <Card
      testId="build-draft"
      title={d?.version ? `The draft · v${d.version}` : "The draft"}
      meta={
        link ? (
          <span className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
            {/* §1.172: where the lab's Drafts opens this build. A build started on its build page
                keeps it until someone moves it to the builder here; it can be moved back. */}
            {b.kind === "agent" && b.status === "open" ? (
              <button
                type="button"
                className="ds-btn ds-btn--link text-sm"
                data-testid="build-flow"
                disabled={isBusy(busy)}
                title={
                  b.flow === "describe"
                    ? "Drafts opens this build in the builder. Open it on this page instead."
                    : "From now on, Drafts opens this build in the builder, not on this page."
                }
                onClick={() =>
                  void act(apiRoutes.opsUpdateBuild, {
                    params: { id: b.id },
                    body: { flow: b.flow === "describe" ? "phases" : "describe" },
                  })
                }
              >
                {b.flow === "describe"
                  ? "Open it here from Drafts"
                  : "Open it in the builder from Drafts"}
              </button>
            ) : null}
            <Link
              to={link}
              className="text-sm font-medium text-slate hover:underline"
              data-testid="build-open-draft"
            >
              {b.kind === "skill" ? "Open the skill's conversation" : "Open the workflow"}
            </Link>
          </span>
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
      {/* Owner (2026-11-21): "if we get it written then we can see the flows and keep editing
          it". The steps as drafted, in run order and in plain words, before anything else. */}
      {d && d.steps.length > 0 ? <DraftSteps steps={d.steps} /> : null}
      {!d ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          The draft is made when the direction is agreed.
        </p>
      ) : d.problems.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink" data-testid="build-draft-clean">
          No missing or invalid steps.{" "}
          {b.kind === "agent"
            ? "To change a step, say so in the conversation, or open the workflow."
            : null}
        </p>
      ) : (
        // Feedback (2026-11-16): each problem in plain words, where it is, what would fix it and
        // what that fix costs (./problems.ts).
        <>
          <ul className="flex flex-col" data-testid="build-draft-problems">
            {problems.shown.map((p) => {
              const advice = problemAdvice(p);
              const where = problemWhere(p);
              return (
                <li
                  key={p.key}
                  data-testid="build-draft-problem"
                  className="flex flex-col gap-2 border-b border-line px-6 py-4 text-sm last:border-b-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium text-ink">{advice.what}</span>
                      {where ? <span className="text-xs text-ink-muted">{where}</span> : null}
                    </div>
                    <Badge tone={p.code === "missing_step" ? "warning" : "risk"}>
                      {p.code === "missing_step" ? "Missing" : "Invalid"}
                    </Badge>
                  </div>
                  <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[110px_minmax(0,1fr)]">
                    <dt className="text-ink-muted">To fix it</dt>
                    <dd className="text-ink" data-testid="build-draft-problem-fix">
                      {advice.fix}
                    </dd>
                    {advice.cost ? (
                      <>
                        <dt className="text-ink-muted">What it costs</dt>
                        <dd className="text-ink" data-testid="build-draft-problem-cost">
                          {advice.cost}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </li>
              );
            })}
          </ul>
          {problems.more}
        </>
      )}
    </Card>
  );
}

/** The draft's steps in run order: each one's name, and what kind of step it is in plain words. */
function DraftSteps({ steps }: { steps: NonNullable<BuildDetail["draft"]>["steps"] }) {
  const workflows = [...new Set(steps.map((s) => s.workflow))];
  return (
    <div className="border-b border-line px-6 py-4" data-testid="build-draft-steps">
      {workflows.map((w) => (
        <div key={w} className="flex flex-col gap-1.5 [&+&]:mt-4">
          {workflows.length > 1 ? (
            <span className="text-xs font-medium text-ink-muted">{w}</span>
          ) : null}
          <ol className="flex flex-col gap-1.5">
            {steps
              .filter((s) => s.workflow === w)
              .map((s, i) => (
                <li
                  key={s.stepId}
                  className="flex items-baseline gap-2.5 text-sm"
                  style={{ paddingLeft: `${Math.min(s.depth, 4) * 20}px` }}
                  data-testid="build-draft-step"
                >
                  <span className="w-5 shrink-0 text-right font-mono text-xs text-ink-muted">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{s.name || "A step"}</span>
                    <span className="text-ink-muted"> · {s.words}</span>
                  </span>
                </li>
              ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

// ── 4 POC test ──────────────────────────────────────────────────────────────────────────────────

function PocPanel({ detail, current, busy, act, onAbout }: PanelProps) {
  const b = detail.build;
  const id = b.id;
  const [plan, setPlan] = useWorkingCopy<TestPlan>(b.testPlan);
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
      {/* builder-plan.md B1: real examples first; model-made cases stay below. */}
      <TryCard
        detail={detail}
        live={current}
        busy={isBusy(busy)}
        act={act}
        {...(onAbout ? { onWrong: onAbout } : {})}
      />
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
                    variant="ghost"
                    disabled={isBusy(busy) || dirty}
                    working={busy === apiRoutes.opsBuildCases.path}
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
                    working={busy === apiRoutes.opsBuildRunTests.path}
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
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-ink">
                        {f.name}{" "}
                        <span className="text-ink-muted">
                          · {f.status === "fail" ? "fails" : "errored"}
                        </span>
                      </span>
                      {/* builder-plan.md B0: why, in its words (an error, or the fields that differ). */}
                      {f.why ? (
                        <span
                          className="break-words text-ink-muted"
                          data-testid={`build-poc-why-${f.caseId}`}
                        >
                          {f.why}
                        </span>
                      ) : null}
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
                        Make it an issue
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
            // FLOW-8 (QA 2026-11-19): off with no word why but a tooltip. Said on the page: the
            // clients couldn't be read, there is none to test with, or none is picked yet.
            why={
              b.client || clientId ? null : clients.error ? (
                <ErrorNotice error={clients.error} onRetry={clients.reload} />
              ) : clients.loading ? null : (clients.data?.clients ?? []).length === 0 ? (
                <>
                  There's no client to test it with yet.{" "}
                  <Link to="/ops/clients/new" className="font-medium text-slate hover:underline">
                    Add a client
                  </Link>{" "}
                  first.
                </>
              ) : (
                "Pick the client it's tested with."
              )
            }
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
                      Make it an issue
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
          {/* FLOW-3 (QA 2026-11-19): Go live was off with no word why. The gate's reasons, as
              `Next` says them. */}
          {current && signed && detail.gate.reasons.length > 0 ? (
            <ul
              className="flex flex-col gap-0.5 text-sm text-ink-muted"
              data-testid="build-go-reasons"
            >
              {detail.gate.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
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

type Item = BuildDetail["items"][number];

/**
 * The build's issues (core's `buildIssues`): its open items, the draft's problems, failing tests,
 * the client's rejected writes and QA's failing checks, open ones first. Owner (2026-11-17): each
 * can be talked about in the conversation, its thread shown again, or all walked through in turn.
 * Owner (2026-11-21): one row each, its words at full width, and closed out where it's listed: a
 * question answered under it, a gap's choice sent to the Builder, a note or precondition done.
 */
function ItemsPanel({
  fold,
  detail,
  issues,
  focus,
  onTalk,
  onSettle,
  onWalk,
  busy,
  act,
  onSay,
  voice,
}: {
  /**
   * Settles an issue one of three ways, from the issue itself (docs/plan.md §1.165): the Builder
   * makes that change at once. Offered while the build has a draft to change.
   */
  onSettle?: ((key: string, way: SettleWay) => void) | undefined;
  /** Folds the card (the page keeps it, so its jump link can open it). */
  fold?: Fold | undefined;
  detail: BuildDetail;
  issues: readonly BuildIssue[];
  /** The issue the conversation is on. */
  focus: string | null;
  /** Puts the conversation on an issue; `only` shows just its thread. */
  onTalk?: ((key: string, only?: boolean) => void) | undefined;
  /** Asks the Builder to take the open issues one at a time. */
  onWalk?: (() => void) | undefined;
  busy: string | null;
  act: Act;
  /** Says something to the Builder about an issue (its key), as the conversation does. */
  onSay?: ((text: string, key: string) => Promise<boolean>) | undefined;
  /** Dictation for the answer box. */
  voice?: Voice | undefined;
}) {
  const id = detail.build.id;
  const [title, setTitle] = useState("");
  // The one answer box open (its issue's key) and its words.
  const [answering, setAnswering] = useState<{ key: string; text: string } | null>(null);
  // Open ones first, then the first few of them; the one the conversation is on always shows.
  const rows = useFirstRows([...issues.filter((i) => i.open), ...issues.filter((i) => !i.open)], {
    keep: (i) => i.key === focus || i.key === answering?.key,
    noun: "issues",
    testId: "build-issues-more",
  });
  const openCount = issues.filter((i) => i.open).length;
  const closed = issues.length - openCount;
  const editable = detail.build.status === "open";
  const off = isBusy(busy);
  const items = new Map(detail.items.map((i) => [i.id, i]));
  const update = (
    i: Item,
    body: NonNullable<CallOptions<typeof apiRoutes.opsUpdateBuildItem>["body"]>,
  ) => void act(apiRoutes.opsUpdateBuildItem, { params: { id, itemId: i.id }, body });
  // DECISION (docs/plan.md §1.166): an answer is a turn about the issue (`about: item:<id>`), as
  // the conversation's own words are when it is on that issue; the Builder fills the brief and
  // closes the question. The box closes at once; if the Builder couldn't take the words, they
  // come back.
  const answer = async (key: string, text: string, typed: string) => {
    if (!onSay) return;
    setAnswering(null);
    if (!(await onSay(text, key))) setAnswering((now) => now ?? { key, text: typed });
  };
  const talk = (issue: BuildIssue) =>
    onTalk ? (
      <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <button
          type="button"
          className="ds-btn ds-btn--link text-xs"
          aria-pressed={focus === issue.key}
          onClick={() => onTalk(issue.key)}
          data-testid={`build-issue-${issue.key}-talk`}
        >
          {focus === issue.key ? "Talking about it" : "Talk about it"}
        </button>
        {issue.talk > 0 ? (
          <button
            type="button"
            className="ds-btn ds-btn--link text-xs"
            onClick={() => onTalk(issue.key, true)}
            data-testid={`build-issue-${issue.key}-thread`}
          >
            {plural(issue.talk, "message")} about it
          </button>
        ) : null}
      </span>
    ) : null;
  // Owner (2026-11-21): "issues should be decided in a few ways: change the process, build a skill
  // or code a new step if it needs code and not a skill". On what is wrong with the draft or its
  // tests and on gaps; a question is answered, and a decision or a QA check has its own control.
  // docs/plan.md §1.169 (owner, 2026-11-21: "give it an action, not just mark it"): each way gives
  // the issue to whoever takes that step and starts it; it closes when the step is done. A gap
  // put off is taken back up the same way.
  const settle = (issue: BuildIssue) => {
    if (!onSettle) return null;
    const item = issue.itemId ? items.get(issue.itemId) : undefined;
    const kind = item?.kind ?? null;
    const putOff = item?.state === "deferred";
    if (!issue.open && !putOff) return null;
    const fits =
      issue.source === "problem" ||
      issue.source === "case" ||
      issue.source === "rejection" ||
      (issue.source === "item" && (kind === "gap" || kind === "test" || kind === "feedback"));
    if (!fits) return null;
    return (
      <span
        className="flex flex-wrap items-center gap-1.5"
        data-testid={`build-issue-${issue.key}-settle`}
      >
        <span className="text-xs text-ink-muted">{putOff ? "Take it up:" : "Settle it:"}</span>
        {SETTLE_WAYS.map((way) => (
          <Button
            key={way}
            size="sm"
            disabled={isBusy(busy)}
            title={`${SETTLE_WORDS[way].who} takes it. ${SETTLE_WORDS[way].does}`}
            onClick={() => onSettle(issue.key, way)}
            data-testid={`build-issue-${issue.key}-settle-${way}`}
          >
            {SETTLE_WORDS[way].label}
          </Button>
        ))}
      </span>
    );
  };
  /**
   * What an item's row offers, by its kind and state, then the conversation's links. docs/plan.md
   * §1.169: nothing here marks a question, gap, test or feedback done; its step does. It can be
   * put off, dropped as not needed, or taken up again.
   */
  const actions = (issue: BuildIssue, i: Item) => {
    const live = editable && itemOpen(i.state);
    const say = live ? onSay : undefined;
    const byStep = settledByStep(i.kind);
    const buttons = !say ? null : i.kind === "question" ? (
      <>
        {answering?.key === issue.key ? null : (
          <Button
            size="sm"
            disabled={off}
            onClick={() => setAnswering({ key: issue.key, text: "" })}
            data-testid={`build-item-${i.id}-answer`}
          >
            Answer it
          </Button>
        )}
        <CloseMenu
          choices={CLOSE_CHOICES}
          disabled={off}
          testId={`build-item-${i.id}-close`}
          onPick={(c) => update(i, c === "deferred" ? { state: "deferred" } : { drop: true })}
        />
      </>
    ) : i.kind === "gap" && !onSettle ? (
      // Before there is a draft to change: the fit-gap's own choices, sent to the Builder.
      GAP_CHOICES.filter((c) => c.key !== "drop").map((c) => (
        <Button
          key={c.key}
          size="sm"
          disabled={off}
          onClick={() => void say(TO_BUILDER.gap[c.key](i.title), issue.key)}
          data-testid={`build-item-${i.id}-gap-${c.key}`}
        >
          {c.label}
        </Button>
      ))
    ) : null;
    // A gap, a test or client feedback: put off (a person does it for now) or dropped.
    const aside =
      editable && byStep && i.kind !== "question" && i.state !== "done" ? (
        <>
          {live ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={off}
              onClick={() => update(i, { state: "deferred" })}
              data-testid={`build-item-${i.id}-put-off`}
            >
              Put off
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={off}
            onClick={() => update(i, { drop: true })}
            data-testid={`build-item-${i.id}-gap-drop`}
          >
            Drop it
          </Button>
        </>
      ) : null;
    // A note or a precondition is done by a click, whoever settled it.
    const done =
      live && (i.kind === "note" || i.kind === "precondition") ? (
        <Button
          size="sm"
          disabled={off}
          onClick={() => update(i, { state: "done" })}
          data-testid={`build-item-${i.id}-done`}
        >
          Done
        </Button>
      ) : null;
    // Taking one up again: a put-off item that no way above takes up, or one closed.
    const again =
      editable && !itemOpen(i.state) && !(i.state === "deferred" && settle(issue)) ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={off}
          onClick={() => update(i, { state: "open" })}
          data-testid={`build-item-${i.id}-reopen`}
        >
          {i.state === "deferred" ? "Take it up" : "Reopen"}
        </Button>
      ) : null;
    if (!buttons && !aside && !done && !again && !onTalk) return null;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {buttons || aside || done || again ? (
          <span className="flex flex-wrap items-center gap-2">
            {buttons}
            {done}
            {aside}
            {again}
          </span>
        ) : null}
        {talk(issue)}
      </div>
    );
  };
  return (
    <Card
      testId="build-items"
      title="Issues"
      fold={fold}
      meta={
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={openCount > 0 ? "warning" : "positive"}>{openCount} open</Badge>
          {closed > 0 ? <Badge tone="neutral">{closed} done or put off</Badge> : null}
          {onWalk && openCount > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={off}
              onClick={onWalk}
              data-testid="build-issues-walk"
            >
              Walk me through them
            </Button>
          ) : null}
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
                  body: { title: title.trim(), owner: "operator" },
                }))
              )
                setTitle("");
            }}
          >
            <TextInput
              aria-label="New issue"
              placeholder="Something left to do"
              className="w-auto min-w-0 flex-1 basis-full sm:basis-0"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="build-item-new"
            />
            <Button
              size="sm"
              type="submit"
              disabled={off || !title.trim()}
              working={busy === apiRoutes.opsAddBuildItem.path}
              data-testid="build-item-add"
            >
              Add
            </Button>
          </form>
        ) : null
      }
    >
      {issues.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          Nothing left to settle yet. The Builder and the phases add issues as they go.
        </p>
      ) : (
        <>
          <ul className="flex flex-col" aria-label="Issues">
            {rows.shown.map((issue) => {
              const i = issue.itemId ? items.get(issue.itemId) : undefined;
              const row = cx(
                "flex min-w-0 flex-col gap-1.5 border-b border-line px-4 py-3 last:border-b-0 sm:px-5",
                focus === issue.key && "bg-slate-tint",
              );
              if (!i) {
                return (
                  <li key={issue.key} className={row} data-testid={`build-issue-${issue.key}`}>
                    <span className="flex flex-wrap items-center gap-2">
                      <Tag>{ISSUE_SOURCE_WORDS[issue.source]}</Tag>
                      <span className="min-w-0 font-medium break-words text-ink">
                        {issue.title}
                      </span>
                    </span>
                    {issue.detail ? (
                      <ShortText text={issue.detail} className="text-sm text-ink-muted" />
                    ) : null}
                    <MetaLine>
                      <span>From {PHASE_WORDS[issue.phase].label}</span>
                      <span>
                        Who has it:{" "}
                        <span className="text-ink">
                          {issue.source === "problem" || issue.source === "case"
                            ? "Builder"
                            : "You"}
                        </span>
                      </span>
                      <Badge
                        tone={
                          !issue.open
                            ? "positive"
                            : issue.source === "rejection"
                              ? "person"
                              : issue.source === "decision"
                                ? "warning"
                                : "risk"
                        }
                      >
                        {issue.state}
                      </Badge>
                    </MetaLine>
                    {settle(issue)}
                    {talk(issue)}
                  </li>
                );
              }
              return (
                <li
                  key={i.id}
                  id={`build-item-${i.id}`}
                  className={row}
                  data-testid={`build-item-${i.id}`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Tag testId={`build-item-${i.id}-kind`}>
                      {ITEM_KIND_WORDS[i.kind]?.label ?? i.kind}
                    </Tag>
                    <span
                      className={cx(
                        "min-w-0 font-medium break-words text-ink",
                        !itemOpen(i.state) && "text-ink-muted line-through",
                      )}
                    >
                      {i.title}
                    </span>
                  </span>
                  {/* An open item's detail is short first; a closed one keeps its whole detail,
                      which ends with how it was closed (§1.166). */}
                  {!i.detail ? null : itemOpen(i.state) ? (
                    <ShortText
                      text={i.detail}
                      className="text-sm text-ink-muted"
                      testId={`build-item-${i.id}-detail`}
                    />
                  ) : (
                    <p className="text-sm break-words whitespace-pre-line text-ink-muted">
                      {i.detail}
                    </p>
                  )}
                  {itemOpen(i.state) ? (
                    <p className="text-xs text-ink" data-testid={`build-item-${i.id}-how`}>
                      <span className="text-ink-muted">To settle it: </span>
                      {ITEM_KIND_WORDS[i.kind]?.how}
                    </p>
                  ) : null}
                  <MetaLine>
                    <span>From {PHASE_WORDS[i.phase].label}</span>
                    {/* docs/plan.md §1.169: who has it and its status follow from the step
                        taken; neither is picked here. */}
                    <span data-testid={`build-item-${i.id}-owner`}>
                      Who has it: <span className="text-ink">{OWNER_WORDS[i.owner]}</span>
                    </span>
                    <Badge tone={ITEM_TONE[i.state]} testId={`build-item-${i.id}-state`}>
                      {issue.state}
                    </Badge>
                  </MetaLine>
                  {settle(issue)}
                  {actions(issue, i)}
                  {answering?.key === issue.key ? (
                    <ReplyBox
                      label={`Your answer: ${i.title}`}
                      placeholder="Your answer. The Builder puts it in the brief."
                      send="Send answer"
                      value={answering.text}
                      onChange={(text) => setAnswering({ key: issue.key, text })}
                      onSend={(text) =>
                        void answer(issue.key, TO_BUILDER.answer(i.title, text), text)
                      }
                      onCancel={() => setAnswering(null)}
                      voice={voice}
                      busy={off}
                      testId={`build-item-${i.id}-answer-box`}
                      assist={{
                        field: "build.item.answer",
                        ref: `item:${i.id}`,
                        context: {
                          buildId: id,
                          clientId: detail.build.client?.id ?? detail.build.testClient?.id,
                        },
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {rows.more}
        </>
      )}
    </Card>
  );
}

/** A row's meta line: where it came from · who has it · its status, in full words. */
function MetaLine({ children }: { children: ReactNode[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-muted sm:gap-x-2">
      {children.map((c, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of three parts
        <span key={n} className="flex items-center gap-2">
          {/* On a phone the parts wrap, and a dot would start a line. */}
          {n > 0 ? (
            <span aria-hidden className="hidden sm:inline">
              ·
            </span>
          ) : null}
          {c}
        </span>
      ))}
    </div>
  );
}
