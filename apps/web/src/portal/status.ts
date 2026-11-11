// The client's status model (QA round 1): one function per kind, which every portal screen calls
// for a run or an agent (sidebar, agent header, Table card, History, Runs, a run's page, Sloan).
//
// A run is Running (working now), Waiting on you (a person of the client must act), Done, Failed
// or Stopped (cancelled). A workflow run waiting on an approval keeps `status = "running"`; the
// API's `waitingOnYou` says it waits, so it is never shown as Running.
//
// An agent is Paused, Setting up (not live yet), Waiting on you (any of its runs waits on the
// client), Working (a run is going) or Ready (live and idle).
import { runState as sharedRunState } from "@countersign/core";
import type { Translate } from "../i18n/catalog";
import { runPollMs, runsPollMs } from "../runs/format";
import type { ChipState } from "../ui/status";

export type RunState = "running" | "waiting" | "done" | "failed" | "stopped";

/** What the API says of a run (any of the portal's run shapes). */
export interface RunFields {
  status: string;
  waitingOnYou?: boolean | undefined;
}

/**
 * A run's state for the client: core's one run state (the back office's too), read with
 * `waitingOnYou`; queued reads as running here.
 */
export function runState(r: RunFields): RunState {
  const s = sharedRunState({ status: r.status, waiting: r.waitingOnYou });
  return s === "queued" ? "running" : s;
}

const RUN_CHIP: Record<RunState, ChipState> = {
  running: "running",
  waiting: "waiting",
  done: "done",
  failed: "failed",
  stopped: "paused",
};

/** A run's state as the chip draws it, in the reader's words. */
export function runChip(r: RunFields, t: Translate): { state: ChipState; label: string } {
  const s = runState(r);
  return { state: RUN_CHIP[s], label: runStateWords(s, t) };
}

export function runStateWords(s: RunState, t: Translate): string {
  switch (s) {
    case "running":
      return t("state.run.running");
    case "waiting":
      return t("common.waitingOnYou");
    case "done":
      return t("state.run.done");
    case "failed":
      return t("state.run.failed");
    case "stopped":
      return t("state.run.stopped");
  }
}

/** Whether a run may still change (it is running or waits on you): its screens poll. */
export function runOpen(r: RunFields): boolean {
  const s = runState(r);
  return s === "running" || s === "waiting";
}

/**
 * How often a portal screen asks again about a run: `fast` while it works, every 30 s while it waits
 * on you, never once it has finished (null). `runOpen` still says what the run is shown as.
 */
export function portalRunPollMs(r: RunFields, fast: number): number | null {
  return runPollMs({ status: r.status, waiting: r.waitingOnYou }, fast);
}

/** A list's poll: the fastest any of its runs needs, or null when none is open. */
export function portalRunsPollMs(runs: readonly RunFields[], fast: number): number | null {
  return runsPollMs(
    runs.map((r) => ({ status: r.status, waiting: r.waitingOnYou })),
    fast,
  );
}

/**
 * Time a run worked: start to finish less the time it waited on the client. Null while it hasn't
 * finished (the screens show "—" then).
 */
export function workedMs(r: {
  startedAt: string | null;
  finishedAt: string | null;
  waitedMs?: number | undefined;
}): number | null {
  if (!r.startedAt || !r.finishedAt) return null;
  const all = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
  return Math.max(0, all - (r.waitedMs ?? 0));
}

export type AgentState = "working" | "waiting" | "ready" | "paused" | "setup";

/** What the API says of an agent: the Table's, the overview's or the agent page's fields. */
export interface AgentFields {
  status: string;
  stage?: string | null | undefined;
  /** Runs going now and runs waiting on the client (any of its runs). */
  runsNow?: { running: number; waitingOnYou: number } | undefined;
  /** Its latest run (the Table): read when `runsNow` isn't there. */
  now?: { status: string; waitingOnYou: boolean } | null | undefined;
}

/** An agent's state for the client. */
export function agentState(a: AgentFields): AgentState {
  if (a.status === "paused") return "paused";
  if (a.stage === "bench" || a.status === "draft" || a.status === "testing") return "setup";
  const latest = a.now && runOpen(a.now) ? runState(a.now) : null;
  if ((a.runsNow?.waitingOnYou ?? 0) > 0 || latest === "waiting") return "waiting";
  if ((a.runsNow?.running ?? 0) > 0 || latest === "running") return "working";
  return "ready";
}

const AGENT_CHIP: Record<AgentState, ChipState> = {
  working: "running",
  waiting: "waiting",
  ready: "idle",
  paused: "paused",
  setup: "setup",
};

export function agentStateWords(s: AgentState, t: Translate): string {
  switch (s) {
    case "working":
      return t("state.agent.working");
    case "waiting":
      return t("common.waitingOnYou");
    case "ready":
      return t("state.agent.ready");
    case "paused":
      return t("state.agent.paused");
    case "setup":
      return t("state.agent.settingUp");
  }
}

/** An agent's state as the chip draws it, in the reader's words. */
export function agentChip(a: AgentFields, t: Translate): { state: ChipState; label: string } {
  const s = agentState(a);
  return { state: AGENT_CHIP[s], label: agentStateWords(s, t) };
}
