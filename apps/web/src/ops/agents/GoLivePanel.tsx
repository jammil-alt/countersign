// A client agent's go-live stage (ARCHITECTURE §10.9; docs/plan.md §1.36): where it is (bench,
// trial, sign-off, live), the trial's days and runs against its minimums, the client's sign-off,
// skips and rejections; the operator moves it with a reason, changes the trial's minimums, and runs
// it live on one of the client's past events. Minimal by design: the owner's redesign replaces it.
import type { AgentBundle, AgentStage } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Badge, Button, Card, SectionLabel, type Tone } from "../../ui/primitives";
import { recentEventLabel, triggerEventType, useRecentEvents } from "./TestPayload";
import { errorText, Field, Notice, plural, Select, TextInput, useAction } from "./ui";

const STAGES: AgentStage[] = ["bench", "trial", "signoff", "live"];

export const STAGE_LABEL: Record<AgentStage, string> = {
  bench: "Bench",
  trial: "Trial",
  signoff: "Sign-off",
  live: "Live",
};

// Signal (waiting on someone) for the client's sign-off; positive for live; ink otherwise.
const STAGE_TONE: Record<AgentStage, Tone> = {
  bench: "neutral",
  trial: "neutral",
  signoff: "warning",
  live: "positive",
};

const day = (iso: string) => new Date(iso).toLocaleDateString();

export function GoLivePanel({
  agent,
  liveBundle,
  onChanged,
}: {
  agent: AgentSummary;
  liveBundle: AgentBundle | null;
  onChanged(): void;
}) {
  const state = useApi(apiRoutes.opsAgentGoLive, { params: { id: agent.id } });
  const action = useAction();
  const [to, setTo] = useState<AgentStage | "">("");
  const [reason, setReason] = useState("");
  const [minDays, setMinDays] = useState("");
  const [minRuns, setMinRuns] = useState("");
  const g = state.data?.goLive;
  if (agent.testCopy || agent.kind !== "client") return null;
  if (!g) {
    return state.error ? (
      <Card className="p-5" testId="agent-go-live">
        <Notice tone="warning">The go-live stage could not be loaded.</Notice>
      </Card>
    ) : null;
  }
  const stage = g.stage ?? "bench";
  const forward = to !== "" && STAGES.indexOf(to) > STAGES.indexOf(stage);

  async function move() {
    if (!to) return;
    const res = await action.call(apiRoutes.opsAgentStage, {
      params: { id: agent.id },
      body: { to, ...(reason.trim() ? { reason: reason.trim() } : {}) },
    });
    if (res.ok) {
      setTo("");
      setReason("");
      state.reload();
      onChanged();
    }
  }

  async function saveTrial() {
    const days = minDays === "" ? undefined : Number(minDays);
    const runs = minRuns === "" ? undefined : Number(minRuns);
    if (days === undefined && runs === undefined) return;
    const res = await action.call(apiRoutes.opsAgentTrial, {
      params: { id: agent.id },
      body: {
        ...(days === undefined ? {} : { minDays: days }),
        ...(runs === undefined ? {} : { minRuns: runs }),
      },
    });
    if (res.ok) {
      setMinDays("");
      setMinRuns("");
      state.reload();
    }
  }

  return (
    <Card className="p-5" testId="agent-go-live">
      <SectionLabel>
        <span className="flex items-center gap-2">
          Go-live stage
          <Badge tone={STAGE_TONE[stage]} testId="agent-stage">
            {STAGE_LABEL[stage]}
          </Badge>
        </span>
      </SectionLabel>

      {stage === "bench" ? (
        <p className="text-ink">
          Test runs only.{" "}
          {g.writes
            ? "Start the trial when it is ready: every change it makes then waits for a signature."
            : "It changes nothing in the client's tools, so it goes live when started."}
        </p>
      ) : null}
      {g.trial && (stage === "trial" || stage === "bench") ? (
        <p className="text-ink" data-testid="agent-trial-progress">
          {stage === "trial"
            ? `Trial since ${day(g.trial.startedAt)}: ${plural(g.trial.days, "day")} of ${g.trial.minDays}, ${plural(g.trial.runs, "finished run")} of ${g.trial.minRuns}. Every change waits for a signature.`
            : `Trial minimums: ${plural(g.trial.minDays, "day")}, ${plural(g.trial.minRuns, "run")}.`}
        </p>
      ) : null}
      {stage === "signoff" && g.signoff ? (
        <p className="text-ink" data-testid="agent-signoff">
          Waiting on the client admin's sign-off since {day(g.signoff.askedAt)}
          {g.signoff.summary
            ? `: ${plural(g.signoff.summary.runs, "run")}, ${plural(g.signoff.summary.changesMade, "change")} made, ${g.signoff.summary.signed} signed, ${g.signoff.summary.rejected} rejected.`
            : "."}
        </p>
      ) : null}
      {stage === "live" ? (
        <p className="text-ink">Live: its steps, the client's permissions and its mode decide.</p>
      ) : null}
      {g.pause ? (
        <p className="mt-2 text-ink" data-testid="agent-pause-reason">
          Paused by{" "}
          {g.pause.side === "client"
            ? "the client"
            : g.pause.side === "operator"
              ? "us"
              : "the platform"}{" "}
          on {day(g.pause.at)}: {g.pause.reason}
          {g.pause.until ? ` (until ${day(g.pause.until)})` : ""}
        </p>
      ) : null}
      {g.rejections.length > 0 ? (
        <p className="mt-2 text-ink" data-testid="agent-signoff-rejected">
          Last kept in trial by the client on {day(g.rejections.at(-1)?.at ?? "")}:{" "}
          {g.rejections.at(-1)?.reason}
        </p>
      ) : null}
      {g.skipped.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-muted">
          {g.skipped.map((s) => (
            <li key={`${s.stage}-${s.at}`}>
              {STAGE_LABEL[s.stage]} skipped on {day(s.at)}: {s.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {action.error ? (
        <div className="mt-3">
          <Notice tone="warning" testId="agent-stage-error">
            {errorText(action.error)}
          </Notice>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr_auto] md:items-end">
        <Field label="Move to">
          <Select
            data-testid="agent-stage-select"
            value={to}
            onChange={(e) => setTo(e.target.value as AgentStage | "")}
          >
            <option value="">Choose a stage</option>
            {STAGES.filter((s) => s !== stage).map((s) => (
              <option key={s} value={s}>
                {STAGE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={forward ? "Why (needed to move forward)" : "Why (optional)"}>
          <TextInput
            data-testid="agent-stage-reason-input"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Button
          data-testid="agent-stage-move"
          disabled={action.busy || !to || (forward && !reason.trim())}
          onClick={move}
        >
          Move
        </Button>
      </div>

      {stage === "bench" || stage === "trial" ? (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[180px_180px_auto] md:items-end">
          <Field label="Trial days">
            <TextInput
              data-testid="agent-trial-days-input"
              inputMode="numeric"
              placeholder={String(g.trial?.minDays ?? 14)}
              value={minDays}
              onChange={(e) => setMinDays(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label="Trial runs">
            <TextInput
              data-testid="agent-trial-runs-input"
              inputMode="numeric"
              placeholder={String(g.trial?.minRuns ?? 25)}
              value={minRuns}
              onChange={(e) => setMinRuns(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Button
            variant="ghost"
            data-testid="agent-trial-save"
            disabled={action.busy || (minDays === "" && minRuns === "")}
            onClick={saveTrial}
          >
            Change minimums
          </Button>
        </div>
      ) : null}

      {stage !== "bench" && agent.runStatus === "active" ? (
        <PastEventRun agent={agent} liveBundle={liveBundle} />
      ) : null}
    </Card>
  );
}

/** Runs the live version live on one of the client's past events (the test-run picker's events). */
function PastEventRun({
  agent,
  liveBundle,
}: {
  agent: AgentSummary;
  liveBundle: AgentBundle | null;
}) {
  const workflows = (liveBundle?.workflows ?? []).filter(
    (w) => w.enabled && triggerEventType(w.workflow),
  );
  const [workflow, setWorkflow] = useState(workflows[0]?.slug ?? "");
  const [eventId, setEventId] = useState("");
  const [started, setStarted] = useState<string[]>([]);
  const action = useAction();
  const chosen = workflows.find((w) => w.slug === workflow)?.workflow ?? null;
  const recent = useRecentEvents(agent.tenantId, triggerEventType(chosen));
  if (workflows.length === 0) return null;
  const events = recent.data?.events ?? [];

  async function start() {
    if (!eventId) return;
    const res = await action.call(apiRoutes.opsRunOnEvent, {
      params: { id: agent.id },
      body: { eventId },
    });
    if (res.ok) setStarted(res.data.runs.map((r) => r.runId));
  }

  return (
    <div className="mt-5 border-t border-line pt-4" data-testid="agent-run-event">
      <p className="mb-3 text-sm text-ink-muted">
        Run the live version on an event that came in before it was running. It runs once per event,
        and its changes wait for a signature as in any live run.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_1fr_auto] md:items-end">
        <Field label="Workflow">
          <Select
            data-testid="agent-run-event-workflow-select"
            value={workflow}
            onChange={(e) => {
              setWorkflow(e.target.value);
              setEventId("");
            }}
          >
            {workflows.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Event">
          <Select
            data-testid="agent-run-event-select"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
          >
            <option value="">{events.length ? "Choose an event" : "No events yet"}</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {recentEventLabel(e)}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          data-testid="agent-run-event-start"
          disabled={action.busy || !eventId}
          onClick={start}
        >
          Run live
        </Button>
      </div>
      {started.length > 0 ? (
        <p className="mt-3 text-sm text-ink" data-testid="agent-run-event-started">
          Started.{" "}
          {started.map((id) => (
            <Link key={id} to={`/ops/runs/${id}`} className="mr-2 text-link underline">
              Open the run
            </Link>
          ))}
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
