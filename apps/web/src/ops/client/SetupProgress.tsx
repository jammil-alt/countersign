// The client page's Setup tab, Progress (docs/setup-plan.md §8; docs/plan.md §1.185, SU6): each
// agent being set up by chapter with who it waits on, the people waiting (Nudge), the change asks
// from the walkthrough and tries, Do it on a call (the open intake's questions, answered for the
// client as "From our call: please check"), the runbook and Start trial (the existing Turn on).
// The lead never connects a tool, signs the scope or fills a seat for the client: none of that is
// here. Start trial stays off while anything holds it, and the trial only ever starts from here
// or the agent's page, by the operator (invariant 8). Back office words, in English.
import {
  type BoardAgent,
  type BoardCell,
  type GuideField,
  gettingStartedRoutes,
  type OpsIntakeView,
  type OpsSetupBoard,
  opsIntakeRoutes,
  type RunbookStep,
} from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Loaded } from "../../ui/page";
import { Badge, Button, Card, ErrorNotice } from "../../ui/primitives";
import { errorText, Notice, useAction } from "../agents/ui";
import { TurnOnSheet } from "../flow/TurnOnSheet";
import { OPS_PATHS } from "../paths";
import { shortDate } from "../work/parts";
import { ClientFrame, useClientPage } from "./ClientFrame";

export function OpsSetupProgressScreen() {
  const { clientId = "" } = useParams();
  const state = useApi(gettingStartedRoutes.opsSetupBoard, { params: { id: clientId } });
  return (
    <ClientFrame clientId={clientId} intro="Where the client's setup stands, chapter by chapter.">
      <div data-testid="ops-setup-progress">
        <Loaded state={state}>
          {(board) => <Board board={board} clientId={clientId} reload={state.reload} />}
        </Loaded>
      </div>
    </ClientFrame>
  );
}

const CHAPTERS: { key: BoardCell["chapter"]; label: string }[] = [
  { key: "business", label: "Business" },
  { key: "tools", label: "Tools" },
  { key: "people", label: "People" },
  { key: "see", label: "See it work" },
  { key: "live", label: "Go live" },
];

const STAGE_WORDS: Record<string, string> = {
  bench: "on the bench",
  trial: "in its trial",
  signoff: "waiting for sign-off",
  live: "live",
};

/** A cell's pill: done, not needed, not started, or the person it waits on (signal, with a word). */
function CellPill({ cell }: { cell: BoardCell }) {
  if (cell.state === "done") return <Badge tone="positive">Done</Badge>;
  if (cell.state === "not_needed") return <Badge>Not needed</Badge>;
  if (cell.waitingOn) return <Badge tone="warning">{`Waiting on ${cell.waitingOn}`}</Badge>;
  return <Badge>{cell.state === "not_started" ? "Not started" : "Open"}</Badge>;
}

function Board({
  board,
  clientId,
  reload,
}: {
  board: OpsSetupBoard;
  clientId: string;
  reload: () => void;
}) {
  const [onCall, setOnCall] = useState(false);
  const trial = board.runbook.find((s) => s.key === "trial");
  const waitingItems = board.waiting.reduce((n, w) => n + w.items.length, 0);
  return (
    <div className="flex flex-col gap-8">
      {onCall ? (
        <Notice tone="neutral" testId="ops-setup-on-call">
          On a call with the client. Answers you give show to them as "From our call: please check"
          and count once they say yes. You can't connect a tool, fill a signing seat or sign for
          them.
        </Notice>
      ) : null}

      <div className="ds-kpis ds-kpis--compact" data-testid="ops-setup-kpis">
        <div className="ds-kpi">
          <span className="ds-kpi__label">Agents in setup</span>
          <span className="ds-kpi__value">{board.agents.length}</span>
        </div>
        <div className={waitingItems > 0 ? "ds-kpi ds-kpi--signal" : "ds-kpi"}>
          <span className="ds-kpi__label">Waiting on the client</span>
          <span className="ds-kpi__value">{waitingItems}</span>
        </div>
        <div className="ds-kpi">
          <span className="ds-kpi__label">Change asks</span>
          <span className="ds-kpi__value">{board.asks.length}</span>
        </div>
        <div className="ds-kpi">
          <span className="ds-kpi__label">Trial target</span>
          <span className="ds-kpi__value">{trial?.at ? shortDate(trial.at) : "–"}</span>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="type-subheading text-ink">Chapters</h2>
          <button
            type="button"
            className="ds-choice text-sm disabled:cursor-default disabled:opacity-60"
            role="switch"
            aria-checked={onCall}
            disabled={!board.intakeId}
            title={board.intakeId ? undefined : "No intake is open for this client"}
            data-testid="ops-setup-call-switch"
            onClick={() => setOnCall((v) => !v)}
          >
            <span className="ds-switch" />
            Do it on a call
          </button>
        </div>
        {board.agents.length === 0 ? (
          <p className="text-ink-muted" data-testid="ops-setup-none">
            No agent is being set up for {board.client.name}.
          </p>
        ) : (
          <div className="dt dt-ana overflow-x-auto">
            <table data-testid="ops-setup-board">
              <thead>
                <tr className="dt-cols">
                  <th>Agent</th>
                  {CHAPTERS.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.agents.map((a) => (
                  <tr key={a.agentId} data-testid={`ops-setup-row-${a.agentId}`}>
                    <td>
                      <span className="block font-medium text-ink">{a.name}</span>
                      <span className="block text-sm text-ink-muted">
                        {[
                          a.version ? `v${a.version}` : null,
                          STAGE_WORDS[a.stage ?? "bench"] ?? "on the bench",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </td>
                    {CHAPTERS.map((c) => {
                      const cell = a.cells.find((x) => x.chapter === c.key);
                      return (
                        <td key={c.key} data-testid={`ops-setup-cell-${a.agentId}-${c.key}`}>
                          {cell ? (
                            <>
                              <CellPill cell={cell} />
                              {cell.note ? (
                                <span className="mt-1 block text-sm text-ink-muted">
                                  {cell.note}
                                </span>
                              ) : null}
                            </>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {onCall && board.intakeId ? <CallForm intakeId={board.intakeId} onSaved={reload} /> : null}

      <Waiting board={board} clientId={clientId} />
      <Asks board={board} />
      <Runbook steps={board.runbook} />

      {board.agents.map((a) => (
        <StartTrial key={a.agentId} agent={a} clientId={clientId} onStarted={reload} />
      ))}
    </div>
  );
}

// ── Waiting on ──────────────────────────────────────────────────────────────────────────────────

function Waiting({ board, clientId }: { board: OpsSetupBoard; clientId: string }) {
  return (
    <section className="flex flex-col gap-3" data-testid="ops-setup-waiting">
      <h2 className="type-subheading text-ink">Waiting on</h2>
      {board.waiting.length === 0 ? (
        <p className="text-ink-muted">Nothing waits on anyone at {board.client.name}.</p>
      ) : (
        <Card>
          {board.waiting.map((w) => (
            <WaitingRow key={w.userId ?? w.name} w={w} clientId={clientId} />
          ))}
        </Card>
      )}
    </section>
  );
}

const NUDGE_WORDS: Record<string, string> = {
  already_today: "Already nudged today. Try again tomorrow.",
  nothing_left: "Nothing is waiting on them now.",
  not_configured: "Email isn't set up here, so nothing went.",
  hipaa: "The client is in HIPAA mode and our email service isn't covered yet.",
};

function WaitingRow({ w, clientId }: { w: OpsSetupBoard["waiting"][number]; clientId: string }) {
  const action = useAction();
  const [result, setResult] = useState<{ sent: boolean; reason: string | null } | null>(null);
  const userId = w.userId;
  async function nudge() {
    if (!userId) return;
    const res = await action.call(gettingStartedRoutes.opsSetupNudge, {
      params: { id: clientId },
      body: { userId },
    });
    if (res.ok) setResult(res.data);
  }
  const items = w.items.length;
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 first:border-t-0"
      data-testid={`ops-setup-waiting-${userId ?? w.name}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-ink">
          {w.name} · {items} {items === 1 ? "thing" : "things"}
        </span>
        <span className="block text-sm text-ink-muted">{w.items.join(", ")}</span>
        <span className="block text-sm text-ink-muted">
          {w.lastSeenAt ? `Last here ${shortDate(w.lastSeenAt)}` : "Not here yet"}
        </span>
        {result ? (
          <span className="block text-sm text-ink" data-testid="ops-setup-nudge-result">
            {result.sent
              ? `Nudged. ${w.name} gets an email from you listing what's left.`
              : (NUDGE_WORDS[result.reason ?? ""] ?? "Nothing went.")}
          </span>
        ) : null}
        {action.error ? (
          <span className="block text-sm ui-tone-risk">{errorText(action.error)}</span>
        ) : null}
      </span>
      {userId ? (
        <Button
          size="sm"
          working={action.busy}
          disabled={result?.sent === true}
          onClick={() => void nudge()}
          data-testid="ops-setup-nudge"
        >
          Nudge
        </Button>
      ) : null}
    </div>
  );
}

// ── Change asks ─────────────────────────────────────────────────────────────────────────────────

function Asks({ board }: { board: OpsSetupBoard }) {
  return (
    <section className="flex flex-col gap-3" data-testid="ops-setup-asks">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="type-subheading text-ink">Change asks</h2>
        <span className="text-sm text-ink-muted">From the walkthrough, tries and requests</span>
      </div>
      {board.asks.length === 0 ? (
        <p className="text-ink-muted">No change asks are open.</p>
      ) : (
        <Card>
          {board.asks.map((a) => (
            <Link
              key={a.requestId}
              to={a.number > 0 ? OPS_PATHS.issue(a.requestId) : OPS_PATHS.buildWork}
              className="block border-t border-line px-5 py-3 first:border-t-0 hover:bg-surface-subtle"
              data-testid={`ops-setup-ask-${a.requestId}`}
            >
              <span className="block text-sm text-ink-muted">
                {[
                  a.number > 0 ? `#${a.number}` : "Idea",
                  a.agentName,
                  a.stepId ? `step ${a.stepId}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="block text-ink">{a.text}</span>
              <span className="block text-sm text-ink-muted">
                {[a.byName, shortDate(a.at)].filter(Boolean).join(" · ")}
              </span>
            </Link>
          ))}
        </Card>
      )}
    </section>
  );
}

// ── The runbook ─────────────────────────────────────────────────────────────────────────────────

function Runbook({ steps }: { steps: RunbookStep[] }) {
  const now = steps.find((s) => s.state === "now");
  return (
    <section className="flex flex-col gap-3" data-testid="ops-setup-runbook">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="type-subheading text-ink">Runbook</h2>
        <span className="text-sm text-ink-muted">
          {now ? `Now: day ${now.day} of about 17` : "Every step done"}
        </span>
      </div>
      <ol className="flex flex-col gap-3 border-l border-line pl-4">
        {steps.map((s) => (
          <li
            key={s.key}
            data-testid={`ops-setup-runbook-${s.key}`}
            data-state={s.state}
            className={s.state === "now" ? "-ml-[17px] border-l-2 border-slate pl-[15px]" : ""}
          >
            <p className="text-sm font-medium text-ink">
              {`Day ${s.day}`}
              {s.at ? ` · ${shortDate(s.at)}` : ""}
              {s.state === "done" ? " · done" : ""}
            </p>
            <p className={s.state === "done" ? "text-sm text-ink-muted" : "text-sm text-ink"}>
              {s.label}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── Start trial ─────────────────────────────────────────────────────────────────────────────────

function StartTrial({
  agent,
  clientId,
  onStarted,
}: {
  agent: BoardAgent;
  clientId: string;
  onStarted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const client = useClientPage();
  const slug = client.data?.agents.find((a) => a.id === agent.agentId)?.slug ?? null;
  const held = agent.holds.length > 0;
  return (
    <section data-testid={`ops-setup-start-${agent.agentId}`}>
      <Card pad>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="type-subheading text-ink">{`Start the ${agent.name}'s trial`}</h3>
            {held ? (
              <>
                <p className="mt-1 text-sm text-ink-muted">
                  {`Waiting on ${agent.holds.length} ${agent.holds.length === 1 ? "thing" : "things"}:`}
                </p>
                <ul className="mt-1 text-sm text-ink" data-testid="ops-setup-holds">
                  {agent.holds.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">
                Nothing holds it. Every write waits for the client's signature during the trial.
              </p>
            )}
          </div>
          <Button
            variant="primary"
            disabled={held}
            onClick={() => setOpen(true)}
            data-testid="ops-setup-start-trial"
          >
            Start trial
          </Button>
        </div>
      </Card>
      {open ? (
        <TurnOnSheet
          agentId={agent.agentId}
          template={false}
          onTry={() =>
            navigate(slug ? OPS_PATHS.agent(clientId, slug) : OPS_PATHS.client(clientId))
          }
          onStarted={() => onStarted()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}

// ── Do it on a call ─────────────────────────────────────────────────────────────────────────────

const ANSWERED = new Set(["answered", "confirmed", "corrected"]);

/** The intake's questions still open: unanswered, not sure, later, or answered on a call. */
function openFields(view: OpsIntakeView): GuideField[] {
  const latest = new Map(view.answers.map((a) => [a.fieldKey, a]));
  const seen = new Set<string>();
  return view.guide.sections
    .flatMap((s) => s.fields)
    .filter((f) => {
      if (seen.has(f.key)) return false;
      seen.add(f.key);
      if (f.state === "known" || f.kind === "tool" || f.kind === "files") return false;
      const a = latest.get(f.key);
      return !a || !ANSWERED.has(a.state) || a.source === "call";
    });
}

/** What was typed, as the field's kind wants it; undefined when nothing (or nothing valid). */
function typedValue(f: GuideField, raw: string | undefined): unknown {
  const v = raw?.trim() ?? "";
  if (!v) return undefined;
  switch (f.kind) {
    case "number": {
      const n = Number(v.replace(/,/g, ""));
      return Number.isFinite(n) ? n : undefined;
    }
    case "money":
      return { amount: v.replace(/^\$/, "").replace(/[,\s]/g, ""), currency: "USD" };
    case "yes_no":
      return v === "yes" ? true : v === "no" ? false : undefined;
    case "choices":
      return v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    default:
      return v;
  }
}

/** The call answer shown back in its box. */
function shownValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object" && "amount" in value) {
    return String((value as { amount: string }).amount);
  }
  return "";
}

function CallForm({ intakeId, onSaved }: { intakeId: string; onSaved: () => void }) {
  const state = useApi(opsIntakeRoutes.opsIntake, { params: { id: intakeId } });
  return (
    <section className="flex flex-col gap-3" data-testid="ops-setup-call">
      <h2 className="type-subheading text-ink">On the call: the intake's open questions</h2>
      <Loaded state={state}>
        {(view) => (
          <CallQuestions
            view={view}
            intakeId={intakeId}
            onSaved={() => {
              state.reload();
              onSaved();
            }}
          />
        )}
      </Loaded>
    </section>
  );
}

function CallQuestions({
  view,
  intakeId,
  onSaved,
}: {
  view: OpsIntakeView;
  intakeId: string;
  onSaved: () => void;
}) {
  const fields = openFields(view);
  const latest = new Map(view.answers.map((a) => [a.fieldKey, a]));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<number | null>(null);
  const action = useAction();
  const ready = fields.flatMap((f) => {
    const value = typedValue(f, drafts[f.key]);
    return value === undefined ? [] : [{ fieldKey: f.key, value }];
  });
  async function save() {
    const res = await action.call(gettingStartedRoutes.opsSetupCallAnswers, {
      params: { id: intakeId },
      body: { answers: ready },
    });
    if (res.ok) {
      setSaved(res.data.saved);
      setDrafts({});
      onSaved();
    }
  }
  if (fields.length === 0) {
    return <p className="text-ink-muted">Every question on the intake is answered.</p>;
  }
  return (
    <Card pad>
      <div className="flex flex-col gap-4">
        {fields.map((f) => {
          const a = latest.get(f.key);
          const fromCall = a?.source === "call" && ANSWERED.has(a.state);
          const hint = fromCall
            ? `From the call: ${shownValue(a?.value)}. Waiting on the client to say yes.`
            : f.hint || undefined;
          const value = drafts[f.key] ?? "";
          const set = (v: string) => setDrafts((d) => ({ ...d, [f.key]: v }));
          return (
            <Field key={f.key} label={f.label} hint={hint} testId={`ops-setup-call-${f.key}`}>
              {f.kind === "yes_no" ? (
                <Select
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  data-testid={`ops-setup-call-input-${f.key}`}
                >
                  <option value="">Not said</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              ) : f.kind === "choice" && f.choices ? (
                <Select
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  data-testid={`ops-setup-call-input-${f.key}`}
                >
                  <option value="">Not said</option>
                  {f.choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              ) : f.kind === "long_text" ? (
                <TextArea
                  rows={2}
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  data-testid={`ops-setup-call-input-${f.key}`}
                />
              ) : (
                <TextInput
                  type={f.kind === "date" ? "date" : "text"}
                  value={value}
                  placeholder={f.kind === "choices" && f.choices ? f.choices.join(", ") : undefined}
                  onChange={(e) => set(e.target.value)}
                  data-testid={`ops-setup-call-input-${f.key}`}
                />
              )}
            </Field>
          );
        })}
        {action.error ? <ErrorNotice error={action.error} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={ready.length === 0}
            working={action.busy}
            onClick={() => void save()}
            data-testid="ops-setup-call-save"
          >
            Save for the client to check
          </Button>
          {saved !== null ? (
            <span className="text-sm text-ink" data-testid="ops-setup-call-saved">
              {`Saved ${saved} ${saved === 1 ? "answer" : "answers"}. They show to the client as "From our call: please check".`}
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
