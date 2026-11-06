// Go-live stages (ARCHITECTURE §10.9): a client agent goes bench → trial → signoff → live. On
// the bench it only test-runs; in trial and signoff it runs live on the client's data but every
// write needs a signature, whatever the step, matrix or mode say; live, the step, matrix, grant
// and mode decide as before. The stage is read fresh at every write decision through
// `effectiveMode`, used by the permission gate, reach out and inbound call answering.

import { z } from "zod";
import { GO_LIVE_WORDS } from "../i18n/lifecycle";
import type { Locale } from "../i18n/locale";
import type { AgentDefinition } from "../schemas/agent";
import type { AgentMode } from "../schemas/permissions";

export const AGENT_STAGES = ["bench", "trial", "signoff", "live"] as const;
export const AgentStage = z.enum(AGENT_STAGES);
export type AgentStage = z.infer<typeof AgentStage>;

/** A trial lasts at least this many days… */
export const DEFAULT_TRIAL_MIN_DAYS = 14;
/** …and at least this many finished live runs, whichever comes later. */
export const DEFAULT_TRIAL_MIN_RUNS = 25;
/** The bounds the operator may set (a year; a thousand runs). */
export const MAX_TRIAL_MIN_DAYS = 365;
export const MAX_TRIAL_MIN_RUNS = 1000;

/** The logged reason when an agent with no write to a client's tool goes from bench to live. */
export const NO_WRITES_REASON = "no writes";

const Iso = z.string().min(1);

export const TrialState = z.object({
  startedAt: Iso,
  minDays: z.number().int().min(0).max(MAX_TRIAL_MIN_DAYS),
  minRuns: z.number().int().min(0).max(MAX_TRIAL_MIN_RUNS),
  /** Who started it (or changed its minimums last); null for the platform. */
  setBy: z.string().nullable(),
});
export type TrialState = z.infer<typeof TrialState>;

export const StageSkip = z.object({
  stage: AgentStage,
  reason: z.string(),
  by: z.string().nullable(),
  at: Iso,
});
export type StageSkip = z.infer<typeof StageSkip>;

export const StageRejection = z.object({
  reason: z.string(),
  by: z.string().nullable(),
  at: Iso,
  inboxItemId: z.string().nullable(),
});
export type StageRejection = z.infer<typeof StageRejection>;

/** `agent.stage_state` (ARCHITECTURE §5.5). Unknown keys are kept, so later fields survive. */
export const StageState = z
  .object({
    trial: TrialState.optional(),
    signoff: z.object({ inboxItemId: z.string(), askedAt: Iso }).optional(),
    skipped: z.array(StageSkip).optional(),
    // DECISION: the client admin's rejections are kept on the agent too (newest last), so the
    // reason is never lost while the lead's thread (W1-C) does not exist yet.
    rejections: z.array(StageRejection).optional(),
  })
  .loose();
export type StageState = z.infer<typeof StageState>;

/** A stored `stage_state`, read leniently: anything that doesn't parse reads as empty. */
export function readStageState(value: unknown): StageState {
  const parsed = StageState.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * The mode the gate uses for an agent at a stage. Only a live agent acts as its definition says;
 * trial and signoff are treated as `suggest_only` (every write needs a signature), and so is the
 * bench (it never writes: it only test-runs, and test runs never write).
 */
// DECISION: a client agent with no stage (rows made before the stage existed, or by an older
// Worker during a deploy) is treated as not live: approval is on by default (invariant 8). The
// migration backfills `live` for every agent that was running before, so none is held back.
export function effectiveMode(
  definition: { permissions: Pick<AgentDefinition["permissions"], "mode"> },
  stage: AgentStage | string | null | undefined,
): AgentMode {
  return stage === "live" ? definition.permissions.mode : "suggest_only";
}

export function stageIndex(stage: AgentStage): number {
  return AGENT_STAGES.indexOf(stage);
}

/** The stage after `stage`, or null when it is live. */
export function nextStage(stage: AgentStage): AgentStage | null {
  return AGENT_STAGES[stageIndex(stage) + 1] ?? null;
}

/**
 * What moving an agent from one stage to another is: `forward` (the next stage), `skip` (forward
 * past at least one stage), `back`, or `same`.
 */
export function stageMove(from: AgentStage, to: AgentStage): "forward" | "skip" | "back" | "same" {
  const d = stageIndex(to) - stageIndex(from);
  if (d === 0) return "same";
  if (d < 0) return "back";
  return d === 1 ? "forward" : "skip";
}

/** The stages a forward move passes over without staying (bench → live passes trial, signoff). */
export function stagesPassed(from: AgentStage, to: AgentStage): AgentStage[] {
  const a = stageIndex(from);
  const b = stageIndex(to);
  return b > a ? AGENT_STAGES.slice(a + 1, b) : [];
}

/** A fresh trial starting at `at`, keeping the minimums of an earlier one if there was one. */
export function startTrial(
  at: Date,
  setBy: string | null,
  previous?: Pick<TrialState, "minDays" | "minRuns"> | undefined,
): TrialState {
  return {
    startedAt: at.toISOString(),
    minDays: previous?.minDays ?? DEFAULT_TRIAL_MIN_DAYS,
    minRuns: previous?.minRuns ?? DEFAULT_TRIAL_MIN_RUNS,
    setBy,
  };
}

export interface TrialProgress {
  startedAt: string;
  minDays: number;
  minRuns: number;
  /** Whole days since the trial started. */
  days: number;
  /** Finished live runs since the trial started. */
  runs: number;
  /** The day the minimum days are met. */
  daysMetAt: string;
  ready: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Where a trial stands: ready to move to signoff once at least `minDays` have passed **and** at
 * least `minRuns` live runs have finished since it started, whichever comes later.
 */
export function trialProgress(trial: TrialState, finishedRuns: number, now: Date): TrialProgress {
  const started = new Date(trial.startedAt).getTime();
  const elapsed = Math.max(0, now.getTime() - started);
  const daysMetAt = new Date(started + trial.minDays * DAY_MS);
  return {
    startedAt: trial.startedAt,
    minDays: trial.minDays,
    minRuns: trial.minRuns,
    days: Math.floor(elapsed / DAY_MS),
    runs: finishedRuns,
    daysMetAt: daysMetAt.toISOString(),
    ready: now.getTime() >= daysMetAt.getTime() && finishedRuns >= trial.minRuns,
  };
}

/** What the client admin sees on the sign-off item: the trial in numbers. */
export const SignoffSummary = z.object({
  trialStartedAt: Iso,
  /** Finished live runs since the trial started, and how they ended. */
  runs: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  /** Writes to the client's tools that were done. */
  changesMade: z.number().int(),
  /** Writes a person signed (approved). */
  signed: z.number().int(),
  /** Writes a person rejected. */
  rejected: z.number().int(),
});
export type SignoffSummary = z.infer<typeof SignoffSummary>;

/** `inbox_item.subject_type` of the client admin's go-live sign-off (subject_id = the agent). */
export const GO_LIVE_SUBJECT = "go_live";

/** The go-live item's payload: the trial in numbers and its words; nothing internal. */
export const GoLivePayload = z.object({
  goLive: z.object({
    agentId: z.string(),
    summary: SignoffSummary,
    /** The summary in the client's language, as written when it was asked. */
    text: z.string(),
    ask: z.string(),
  }),
});
export type GoLivePayload = z.infer<typeof GoLivePayload>;

/** The sign-off item's title and words, in the client's language. */
export function goLiveItem(
  agentName: string,
  summary: SignoffSummary,
  locale: Locale = "en",
): { title: string; text: string; ask: string } {
  const w = GO_LIVE_WORDS[locale];
  return { title: w.title(agentName), text: w.summary(summary), ask: w.ask };
}
