// A client agent's status in words, the one derivation every back-office screen uses (QA,
// 2026-11-22: the AP bill clerk read "Idle · In trial" on Home, "In trial" on the client's
// Overview, "Running · Live" on its Agents tab and "Live · v4 · Active" on its own page).
//
// Three facts, always in this order: where it is on its way live (its stage: from `run_status`
// and `stage`), the version it runs, and what it is doing now (its runs), e.g.
// "In trial · v4 · Idle". Screens that don't have a fact leave it out; none says another word
// for the same fact. "Live" is the live stage only (core `isLiveAgent`): a published version is
// "v4", never "Live · v4", since a published version can still be in trial.
import type { ChipState } from "../ui/status";

/** Where a client agent is: switched off, not started, or a go-live stage while on. */
export type AgentStageKey = "paused" | "retired" | "not_started" | "trial" | "signoff" | "live";

export interface AgentWords {
  state: ChipState;
  words: string;
}

export interface AgentStageWords extends AgentWords {
  key: AgentStageKey;
}

/** What the stage is read from: the agent row's own fields (`AgentSummary`, the command center). */
export interface AgentStageInput {
  /** `run_status`: active, paused, retired, draft, testing; null before it was switched on. */
  runStatus: string | null | undefined;
  /** `stage`: bench, trial, signoff, live; null for an agent from before stages. */
  stage?: string | null | undefined;
  /** Paused by the client or us (the go-live view's `pause`), when the page knows. */
  paused?: boolean | undefined;
}

// DECISION (QA 2026-11-22, over §1.163's "Running" for a live agent): a live agent reads "Live",
// as every count calls it ("2 agents live"), and "Running" is kept for what its runs are doing,
// so the two can't be read as each other (the owner's decision 1: an agent's own status is never
// "Running"). The other words are §1.163's: Paused, Retired, Not started (a draft, or on the
// bench: it makes test runs only), In trial, Waiting on the client's sign-off.
const STAGE: Record<AgentStageKey, AgentWords> = {
  paused: { state: "paused", words: "Paused" },
  retired: { state: "idle", words: "Retired" },
  not_started: { state: "setup", words: "Not started" },
  trial: { state: "running", words: "In trial" },
  signoff: { state: "waiting", words: "Waiting on the client's sign-off" },
  live: { state: "done", words: "Live" },
};

/** Where a client agent is, in words: Paused, Retired, Not started, In trial, sign-off or Live. */
export function agentStage(a: AgentStageInput): AgentStageWords {
  const key = stageKey(a);
  return { key, ...STAGE[key] };
}

function stageKey(a: AgentStageInput): AgentStageKey {
  if (a.paused || a.runStatus === "paused") return "paused";
  if (a.runStatus === "retired") return "retired";
  // Draft, testing or never switched on: nothing runs on the client's work yet.
  if (a.runStatus !== "active") return "not_started";
  switch (a.stage) {
    case "live":
      return "live";
    case "signoff":
      return "signoff";
    case "trial":
      return "trial";
    default:
      // The bench, or no stage (approval stays on: core `effectiveMode`).
      return "not_started";
  }
}

/** What an agent's runs are doing, from what the page knows of them. */
export interface AgentActivityInput {
  /** Its open runs (running or waiting). */
  openRuns: number;
  /** Of those, the ones waiting on a person. */
  waitingRuns?: number | undefined;
  /** How its last run ended, when the page has it. */
  lastRunStatus?: string | null | undefined;
}

/** "Waiting for approval", "Running", "Last run failed" or "Idle". */
export function agentActivity(a: AgentActivityInput): AgentWords {
  if ((a.waitingRuns ?? 0) > 0) return { state: "waiting", words: "Waiting for approval" };
  if (a.openRuns > 0) return { state: "running", words: "Running" };
  if (a.lastRunStatus === "failed") return { state: "failed", words: "Last run failed" };
  return { state: "idle", words: "Idle" };
}

/**
 * The three facts in their one order: "In trial · v4 · Idle". The version and the activity are
 * left out when the page doesn't have them; the activity is also left out for an agent that
 * isn't switched on (a paused or retired agent's runs are not news).
 */
export function agentStatusLine(parts: {
  stage: AgentStageWords;
  version?: number | null | undefined;
  activity?: AgentWords | null | undefined;
}): string {
  const on =
    parts.stage.key === "trial" || parts.stage.key === "signoff" || parts.stage.key === "live";
  return [
    parts.stage.words,
    parts.version != null ? `v${parts.version}` : null,
    on && parts.activity ? parts.activity.words : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
