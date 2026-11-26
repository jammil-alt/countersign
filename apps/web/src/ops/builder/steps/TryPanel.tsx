// Try it on a step-model workflow (feedback, 2026-11-26: "where are we supposed to test a workflow
// or a step? The Try button is gone"). The v4 builder's Try panel went with it (#707); this is the
// step builder's: the draft is saved, then run once as a test run (`opsTestRun`: a template in the
// Sandbox or the client picked, a client's agent at its own client), read back until it ends, and
// each step's result is handed to the chart and the list. A test run never writes: what it would
// change or send is recorded as proposed.
// DECISION: a JSON input started from the trigger's sample, and every step of the workflow. The
// v4 panel's file upload, made-up data and "some of the steps" are not here yet: the test-run
// route still refuses a range on a v5 workflow (docs/step-model-plan.md §13d, follow-ups).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../../api/client";
import { apiRoutes } from "../../../api/routes";
import { useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Select, TextArea } from "../../../ui/forms";
import { Icon } from "../../../ui/icons";
import { Badge, Button } from "../../../ui/primitives";
import { JSON_INPUT_PROPS, parsePayload } from "../../agents/TestPayload";
import type { TryMark } from "../../flow/types";
import { useOpsClients } from "../../OpsLayout";
import { OPS_PATHS } from "../../paths";
import { parseNodeId } from "../../run/checklist";
import { findStep, walk } from "./model";
import type { Workflow } from "./types";

export type TryRun = ResponseOf<typeof apiRoutes.opsRun>;
type Row = TryRun["steps"][number];

const POLL_MS = 1500;
/** How long the panel follows a run before it says to open it. */
const FOLLOW_MS = 5 * 60_000;

export function tryEnded(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** A row the test run recorded and never made: a write or a send it proposed. */
function wouldHave(row: Row, run: TryRun): boolean {
  if (row.status !== "succeeded") return false;
  const out = row.output && typeof row.output === "object" ? (row.output as object) : {};
  if ((out as { wouldHaveDone?: unknown }).wouldHaveDone === true) return true;
  return run.actions.some((a) => a.stepRunId === row.id && a.status === "proposed");
}

const RANK: Record<TryMark["status"], number> = {
  skipped: 0,
  did: 1,
  would: 2,
  waiting: 3,
  failed: 4,
};

/** One mark per step of the workflow that has a row: the worst of its rows (a loop runs it often). */
export function tryMarks(run: TryRun, workflow: Workflow): TryMark[] {
  const out = new Map<string, TryMark>();
  for (const row of run.steps) {
    const { stepId } = parseNodeId(row.nodeId);
    if (!findStep(workflow, stepId)) continue;
    const said = row.summary?.trim() || undefined;
    let mark: TryMark | null = null;
    switch (row.status) {
      case "succeeded":
        mark = wouldHave(row, run)
          ? {
              stepId,
              status: "would",
              summary: said ?? "Would have done this. Nothing was written.",
            }
          : { stepId, status: "did", summary: said ?? "Done" };
        break;
      case "failed":
        mark = { stepId, status: "failed", summary: said ?? errorWords(run) ?? "It failed here" };
        break;
      case "waiting":
        mark = { stepId, status: "waiting", summary: said ?? "Waiting for a person" };
        break;
      case "skipped":
      case "cancelled":
        mark = { stepId, status: "skipped", summary: said ?? "Skipped" };
        break;
    }
    if (!mark) continue;
    const was = out.get(stepId);
    if (!was || RANK[mark.status] >= RANK[was.status]) out.set(stepId, mark);
  }
  return [...out.values()];
}

function errorWords(run: TryRun): string | null {
  const e = run.run.error as unknown;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const said =
      (e as { reason?: unknown; message?: unknown }).reason ?? (e as { message?: unknown }).message;
    if (typeof said === "string" && said) return said;
  }
  return null;
}

function outcome(run: TryRun, marks: readonly TryMark[]): string {
  const n = (s: TryMark["status"]) => marks.filter((m) => m.status === s).length;
  switch (run.run.status) {
    case "succeeded": {
      const would = n("would");
      return would
        ? `It ran to the end. ${would} ${would === 1 ? "step" : "steps"} would have written or sent: nothing was.`
        : "It ran to the end. Nothing was written.";
    }
    case "failed":
      return `It stopped: ${errorWords(run) ?? "a step failed"}.`;
    case "cancelled":
      return "It was cancelled.";
    case "waiting":
      return "It is waiting for a person. Open the test run to answer it.";
    default:
      return "It is running…";
  }
}

const MARK_TONE: Record<TryMark["status"], "positive" | "warning" | "risk" | "neutral"> = {
  did: "positive",
  would: "positive",
  waiting: "warning",
  failed: "risk",
  skipped: "neutral",
};
const MARK_WORD: Record<TryMark["status"], string> = {
  did: "Did",
  would: "Would do",
  waiting: "Waiting",
  failed: "Failed",
  skipped: "Skipped",
};

export interface TryPanelProps {
  agent: { id: string; kind: "template" | "client"; tenantId: string | null };
  workflow: Workflow;
  /** The workflow's slug: the one the test run runs. */
  slug: string;
  /** The trigger's sample payload, to start the input from. */
  sample: unknown;
  /** Saves unsaved changes as a draft; answers the version to run, or null when saving failed. */
  prepare(): Promise<string | null>;
  /** Each step's result, for the chart and the list; [] clears them. */
  onMarks(marks: TryMark[]): void;
  onSelect(stepId: string): void;
  onClose(): void;
}

export function TryPanel(props: TryPanelProps) {
  const api = useApiClient();
  const clients = useOpsClients();
  const [text, setText] = useState(() =>
    props.sample === undefined ? "{}" : JSON.stringify(props.sample, null, 2),
  );
  const sandbox = clients?.find((c) => c.sandbox)?.id ?? null;
  const [clientId, setClientId] = useState<string | null>(null);
  const where = clientId ?? sandbox;
  const [phase, setPhase] = useState<"choose" | "starting" | "running" | "ended" | "error">(
    "choose",
  );
  const [error, setError] = useState<unknown>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [last, setLast] = useState<TryRun | null>(null);
  const gen = useRef(0);
  const marksRef = useRef(props.onMarks);
  marksRef.current = props.onMarks;
  const parsed = parsePayload(text);
  const clientField = useId();
  const inputField = useId();

  // Closing the panel stops following the run (it goes on on the server).
  useEffect(
    () => () => {
      gen.current += 1;
    },
    [],
  );

  const marks = useMemo(() => (last ? tryMarks(last, props.workflow) : []), [last, props.workflow]);

  async function start() {
    if (!parsed.ok) return;
    gen.current += 1;
    const mine = gen.current;
    setPhase("starting");
    setError(null);
    setRunId(null);
    setLast(null);
    marksRef.current([]);
    try {
      const vid = await props.prepare();
      if (gen.current !== mine) return;
      if (!vid) {
        setPhase("choose");
        return;
      }
      const res = await api.call(apiRoutes.opsTestRun, {
        params: { id: props.agent.id, vid },
        body: {
          workflow: props.slug,
          payload: parsed.value,
          ...(props.agent.kind === "template" && where ? { clientId: where } : {}),
        },
      });
      if (gen.current !== mine) return;
      setRunId(res.runId);
      setPhase("running");
      const until = Date.now() + FOLLOW_MS;
      let refresh = false;
      for (;;) {
        const run: TryRun = await api.call(apiRoutes.opsRun, {
          params: { id: res.runId },
          refresh,
        });
        refresh = true;
        if (gen.current !== mine) return;
        setLast(run);
        marksRef.current(tryMarks(run, props.workflow));
        if (tryEnded(run.run.status) || run.run.status === "waiting" || Date.now() > until) {
          setPhase("ended");
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (gen.current !== mine) return;
      }
    } catch (e) {
      if (gen.current !== mine) return;
      setError(e);
      setPhase("error");
    }
  }

  const order = walk(props.workflow).map((l) => l.step);
  const busy = phase === "starting" || phase === "running";

  return (
    <aside aria-label="Try it" data-testid="steps-try" className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-ink-muted">Test run</span>
          <h2 className="type-subheading text-ink">Try it</h2>
          <p className="text-sm text-ink-muted">
            Runs this draft once on an example. It never writes to a tool or sends: what it would do
            is shown as proposed.
          </p>
        </div>
        <Button
          variant="ghost"
          className="ds-btn--icon shrink-0"
          aria-label="Close"
          data-testid="steps-try-close"
          onClick={props.onClose}
        >
          <Icon name="close" size={20} />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {props.agent.kind === "template" ? (
          <div className="flex flex-col gap-1 text-sm text-ink">
            <label htmlFor={clientField}>Run it at</label>
            <Select
              id={clientField}
              data-testid="steps-try-client"
              value={where ?? ""}
              onChange={(e) => setClientId(e.target.value || null)}
            >
              {(clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.sandbox ? " (Sandbox)" : ""}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1 text-sm text-ink">
          <label htmlFor={inputField}>What starts it</label>
          <span className="text-xs text-ink-muted">
            The trigger's input as JSON, started from its example. Change it to try another case.
          </span>
          <TextArea
            {...JSON_INPUT_PROPS}
            id={inputField}
            data-testid="steps-try-input"
            rows={8}
            className="font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {!parsed.ok ? <p className="text-sm text-risk-ink">That isn't valid JSON.</p> : null}
        {error ? <ErrorNotice error={error} /> : null}
        {last ? (
          <section className="flex flex-col gap-2" data-testid="steps-try-result">
            <p className="text-sm text-ink" data-testid="steps-try-outcome">
              {phase === "running" ? "It is running…" : outcome(last, marks)}
            </p>
            <ul className="flex flex-col divide-y divide-line border border-line">
              {order
                .map((s) => ({ s, m: marks.find((m) => m.stepId === s.id) }))
                .filter((x) => x.m)
                .map(({ s, m }) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface-muted"
                      onClick={() => props.onSelect(s.id)}
                    >
                      <Badge tone={MARK_TONE[m?.status ?? "skipped"]}>
                        {MARK_WORD[m?.status ?? "skipped"]}
                      </Badge>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm text-ink">{s.name.trim() || "A step"}</span>
                        {m?.summary ? (
                          <span className="text-xs text-ink-muted">{m.summary}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <Button
          variant="primary"
          size="sm"
          data-testid="steps-try-run"
          working={busy}
          disabled={busy || !parsed.ok || (props.agent.kind === "template" && !where)}
          onClick={() => void start()}
        >
          {last ? "Run it again" : "Run the test"}
        </Button>
        {runId ? (
          <Link
            className="text-sm text-slate underline"
            data-testid="steps-try-open"
            to={`${OPS_PATHS.runs}/${runId}`}
          >
            Open the test run
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
