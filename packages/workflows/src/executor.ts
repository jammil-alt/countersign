// The step-list executor (ARCHITECTURE §10.1, §10.3, §10.14; docs/plan.md §1.2, §1.86). It walks
// one process of a client agent's pinned bundle against a StepRunner, so the same code runs inside
// Cloudflare's RunWorkflow and in unit tests. Everything with a side effect (step_run rows, agent
// calls, inbox items, notifications) happens inside a named `runner.do`, so a replayed run repeats
// nothing.
//
// R3: it runs v4 processes only. A stored v3 workflow is read as v4 at load (`./process`), each
// converted step keeping its stored v3 step (its origin) for the ports, so it runs exactly as it
// did: same durable names, same step_run rows, same idempotency keys, same port calls.
//
// Durable names: a step's name is its id, or `${forEachName}:${index}:${childId}` inside a loop
// (so nested loops chain). Suffixes after `:` that are not an index (`:check`, `:wait`, `:done`,
// `:approval:<n>:…`, `:confer:<n>`, `:notify:<n>`, `:help`) can't collide with them because step
// ids never contain `:`.

import {
  type ActionStep,
  type Approval,
  automationSkillRef,
  clientLabel,
  collectRefs,
  DEFAULT_APPROVAL,
  type Duration,
  evaluateRules,
  isPlainObject,
  LEAD_ASSIGNEE,
  lookupSkill,
  type NotifyStep,
  // v0.13 W2-I
  OVERSIGHT_DEFAULT_MAX_PER_RUN,
  OVERSIGHT_MAX_PER_STEP,
  // Wave 6
  type OwnerCheckAttempt,
  type OwnerCheckEntry,
  type OwnerCheckReason,
  // R6
  type OwnerWatchedStep,
  ownerStepApproval,
  type PersonStep,
  parseDuration,
  processes,
  type Rules,
  type RunContext,
  renderSummary,
  renderTemplate,
  resolvePath,
  resolveTemplate,
  runErrorKey,
  type SkillStep,
  singleRef,
  stepStateLabel,
  TIMELINE_WORDS,
  type TimelineWords,
  type Step as V3Step,
  type Workflow,
  // v0.13 M32
  workflowCheckpoints,
} from "@countersign/core";
import {
  type AutomationResolver,
  ExpandError,
  expandAutomations,
  expandProcesses,
  type ProcessExpansions,
} from "./expand";
// R6: the owner's watch over the v0.13 loop (one loop, one port).
import {
  type AfterSuccess,
  type OwnerWatch,
  ownerAfterSuccess,
  ownerErrorKey,
  ownerReviewsFailureOf,
} from "./oversight";
import {
  type AgentPort,
  type ConferPort,
  type ConversationPort,
  type ConversationRequest,
  type ConversationResult,
  conversationEventType,
  type HoursAnswer,
  type HoursPort,
  type InboxPort,
  InboxResolution,
  NeedsHelp,
  type NotifyPort,
  // v0.13 W2-I
  type OversightPort,
  type OversightVerdict,
  // Wave 6
  type OwnerCheckLog,
  type PendingApproval,
  type ResolvedAction,
  type RunInfo,
  type StepCatalog,
  type StepLog,
  type StepOutcome,
  type StepRunUpdate,
  type StepWait,
} from "./ports";
import {
  type AnyWorkflow,
  askView,
  gateApproval,
  type LoadedProcess,
  loadProcess,
  NO_LOOKUP,
  type Origins,
  ProcessLoadError,
  personView,
  storedKind,
  toolOf,
  workView,
} from "./process";
import { inboxEventType, isWaitTimeout, type StepConfig, type StepRunner } from "./runner";

export interface ExecutorContext {
  run: RunInfo;
  agent: AgentPort;
  inbox: InboxPort;
  notify: NotifyPort;
  log: StepLog;
  /** Skill and tool definitions for summary templates; without them summaries fall back. */
  catalog?: StepCatalog;
  /** Retries and timeout for skill and action steps. */
  stepConfig?: StepConfig;
  /** How long a write waits for approval when its step names no timeout. */
  approvalTimeout?: Duration;
  // v0.12 W1-E: retry from the failed step (ARCHITECTURE §10.10; docs/plan.md §1.40).
  /** A retry: the top-level steps before `from` are not run again, their outputs reused. */
  resume?: RunResume;
  // v0.12 W2-B: automations (ARCHITECTURE §10.7; docs/plan.md §1.45).
  /** The automation versions the workflow's use steps pin, loaded in the run's load step. */
  automations?: AutomationResolver;
  // v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54).
  /** The run's own agent reviewing failed steps; absent: no step is reviewed, as before. */
  oversight?: ExecutorOversight;
  // Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)")
  /** Where the owner's check on each attempt at a native v4 step is kept; absent: nowhere. */
  ownerChecks?: OwnerCheckLog;
  // R3: the process model (ARCHITECTURE §10.14; docs/plan.md §1.86, §9).
  /**
   * How v3 workflows are read as v4 (`processes.ConvertLookup`, from packages/agents' registries).
   * Absent: tool-wrapper skills stay skill steps. Converted steps run through their stored v3 step
   * either way, so it changes only the kinds a v4 reader sees.
   */
  lookup?: processes.ConvertLookup;
  /** Stored business hours and away dates; absent: the default week in `run.timeZone`. */
  hours?: HoursPort;
  /** Conversation steps; absent: a conversation step fails the run. */
  conversation?: ConversationPort;
  /** AI reviewers for confer checks; absent: an AI reviewer's verdict is `no_answer`. */
  confer?: ConferPort;
}

/** What a retry starts from. Small JSON: apps/api loads it in a durable step. */
export interface RunResume {
  /** The top-level step the retry runs from (the failed one, or the fork or loop it was in). */
  from: string;
  /** The run retried, as people see it (`R-1a2b3c`), for the reused steps' summaries. */
  of: string;
  /**
   * Top-level step id → its row in the run retried (succeeded or skipped, or wave 5: failed and
   * carried on past with `onError: continue`), output as stored. `record`: how it ended, rebuilt
   * from the run retried's rows and items (core's `reusedStepOf`), for a later `if` to route on
   * as the run retried did; absent, its outcome word is read from the row alone.
   */
  reused: Record<
    string,
    {
      status: "succeeded" | "skipped" | "failed";
      output: unknown;
      /** What later steps read as its output (absent: `processes.scopeOutputOfRow`). */
      stepOutput?: unknown;
      record?: processes.StepRecord;
    }
  >;
}

export type RunEndStatus = "succeeded" | "failed" | "cancelled";

export interface RunResult {
  status: RunEndStatus;
  /** Why the run ended before its last step, e.g. `rejected`, `timeout`, `stop`, an error. */
  reason?: string;
  /** The durable name of the step that ended it. */
  nodeId?: string;
  /** A failure's `error.key`: `<tool id or step kind>:<code>` of the step that failed (W1-E). */
  errorKey?: string;
  // v0.13 W2-I
  /** A failure the run's agent reviewed: its last decision's note (operator side only). */
  diagnosis?: string;
}

// v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54). R6: the owner, whose
// `settings` are the agent's `definition.oversight` (absent: `off`, a step may still say `always`)
// and whose `watch` (v4 processes) adds the cheap watch's signals.
export interface ExecutorOversight extends OwnerWatch {
  port: OversightPort;
}

/** How one attempt at a skill or action step ended. */
interface Attempt {
  stepRunId: string;
  outcome: StepOutcome;
  rejected: boolean;
  // R3
  /** Nobody answered its approval and `ifNoAnswer` is `skip`: skipped whatever `onReject` says. */
  skipped?: boolean;
  /** It proposed a write (an approval was asked, or a test run's write was recorded unmade). */
  proposed?: boolean;
  // Wave 5
  /** Nobody answered its approval (`ifNoAnswer` `stop` or `skip`): not a person's no. */
  unanswered?: boolean;
  /** Each approval decided, in order: what a later step reads as `steps.<id>.approval`. */
  approvals?: ApprovalRecord[];
}

/** Wave 5: one approval as `steps.<id>.approval` reads it. */
type ApprovalRecord = NonNullable<processes.StepRecord["approval"]>;

/** Wave 5: why a work step didn't run on (`work`'s `ran: false`), as its outcome says it. */
type NotRun = "rejected" | "no_answer" | "skipped";

/** Wave 5: what one approval's asking came to, as a later step reads it. */
function approvalRecord(decided: Decided): ApprovalRecord | null {
  const { resolution } = decided;
  if (decided.proceeded || decided.skip || decided.unanswered) return { outcome: "no_answer" };
  // P-6: a withdrawn item (a conversation taken over) is no decision.
  if (resolution.withdrawn === true) return null;
  return {
    outcome: resolution.approved === true ? "approved" : "rejected",
    by: resolution.by ?? null,
  };
}

/** An oversight retry (or R3: the re-run after the lead's help): its place, input and keys. */
interface AttemptRetry {
  seq: number;
  input: unknown;
  keyNode: string;
  /** R3: its durable name, when not `${name}:retry:${seq}`. */
  at?: string;
}

// R3: what a v4 work step adds to an attempt.
interface WorkOptions {
  /**
   * A native v4 approval check on the writes the step proposes, its approvers (who is away
   * already known): its mode, deadlines and `ifNoAnswer`. Absent (a converted v3 step), the gate's
   * approval is decided exactly as v3 decided it.
   */
  plan?: ApprovalPlan;
  /** A skill step's customization, for the runtime (instructions, rule rows). */
  customize?: processes.SkillCustomization;
  /** The step's row kind when not its port view's: a native `read` or `write`. */
  nodeType?: "read" | "write";
  // R6
  /** The native v4 step the owner watches (absent: the port view, a converted step's v3 step). */
  watched?: OwnerWatchedStep;
  /**
   * Before the approval of each write the step proposes: its confer (a native skill), under `at`
   * (the step's own name for the first attempt's first proposal, else the approval's name).
   */
  beforeApproval?: (proposal: { at: string; input: unknown; output: unknown }) => Promise<void>;
  /** After an attempt that did its work, before the owner reviews it: a read's or skill's confer. */
  afterRun?: (output: unknown) => Promise<void>;
  /** The confer verdicts so far, for the owner's watch. */
  verdicts?: () => ConferEntry[] | undefined;
  /**
   * Skill model (2026-11-10): an action write step's input, resolved, as its tool takes it
   * (`processes.actionToolInput`). Throws `processes.ActionInputError` when the tool can't take it.
   */
  mapInput?: (input: unknown) => unknown;
  /** The connection an action's channel resolved to (`ActionStepRequest.binding`). */
  binding?: { connector: string; connectionId: string };
}

/** What `Executor.work` comes back with: the step ran on, or why it didn't (wave 5). */
type WorkDone =
  | {
      ran: true;
      output: unknown;
      stepRunId: string;
      proposed: boolean;
      approvals?: ApprovalRecord[];
    }
  | { ran: false; output: unknown; why: NotRun; approvals?: ApprovalRecord[] };

/** One approver of an approval check, planned before the step runs. */
interface PlannedApprover {
  who?: string | undefined;
  deadline?: processes.Deadline | undefined;
  away: boolean;
}

interface ApprovalPlan {
  check: processes.ApprovalCheck;
  approvers: PlannedApprover[];
}

/** How an approval's asking ended. */
interface Decided {
  resolution: InboxResolution;
  /** Nobody answered; `ifNoAnswer: proceed`. */
  proceeded?: boolean;
  /** Nobody answered; `ifNoAnswer: skip`. */
  skip?: boolean;
  /** Nobody answered; `ifNoAnswer: stop` (the resolution reads as not approved). */
  unanswered?: boolean;
}

/** How one approval is asked (`Executor.approve`): a write's gate approval or a sign-off. */
interface ApprovalAsking {
  /** Asks one more approver; null when the port can't (only the gate's item is asked). */
  ask: Asker | null;
  /** The item the gate made for the first approver present (a write); absent: asked here. */
  first?: string;
  /** How long the first approver has when their deadline isn't set. */
  fallback: Duration;
  /** Approver k's durable name. */
  nameOf: (k: number) => string;
}

/** One confer reviewer's answer, as checks read it (`confer.<n>.verdict`); null: not asked. */
type ConferEntry = { verdict: processes.ConferVerdict; note: string; by: string } | null;

/** One confer reviewer's verdict, as the owner's watch reads it. */
function verdictsOf(entries: readonly ConferEntry[] | undefined): processes.ConferVerdict[] {
  return (entries ?? []).flatMap((e) => (e ? [e.verdict] : []));
}

/** Who an approver without a `who` is: the client's admin, as the gate's default asks. */
const DEFAULT_APPROVER = "client_admin";

/** Asks one more person (an approver, an escalation): creates the item, says how long to wait. */
type Asker = (
  base: string,
  who: string,
  deadline: processes.Deadline | undefined,
) => Promise<{ item: string; timeout: Duration }>;

function failedAttempt(a: Attempt | { thrown: unknown }): boolean {
  return "thrown" in a || a.outcome.kind === "failed";
}

/**
 * Wave 6: how an attempt ended, for the owner's check. Review: an escalation (a budget reached), a
 * person's no and nobody answering are named as such, not as a failure or as nothing off.
 */
function attemptOutcomeOf(a: Attempt | { thrown: unknown }): OwnerCheckAttempt {
  if ("thrown" in a) return "failed";
  if (a.outcome.kind === "escalated") return "escalated";
  if (a.outcome.kind !== "done") return "failed";
  if (a.rejected) return a.unanswered ? "unanswered" : "rejected";
  return "succeeded";
}

function withDiagnosis(diagnosis: string | undefined): { diagnosis?: string } {
  return diagnosis === undefined ? {} : { diagnosis };
}

/**
 * v0.13 M32: a step's key among the checkpoints. Inside a use step (`…${use}/${inner}`, the use
 * step's own name may carry a loop's `${loop}:${i}:`), the use step's id and the inner step's id.
 */
function checkpointKey(name: string, stepId: string): string {
  const slash = name.indexOf("/");
  if (slash < 0) return stepId;
  const useName = name.slice(0, slash);
  const useId = useName.slice(useName.lastIndexOf(":") + 1);
  return `${useId}/${stepId}`;
}

// DECISION: a write step whose approval names no timeout waits 7 days, then counts as not
// approved (its onReject applies). An unanswered approval must never turn into a write.
export const DEFAULT_APPROVAL_TIMEOUT: Duration = "7 days";

// DECISION (R3): a skill that needs help asks the lead, who has one business day to answer; no
// answer stops the run (owner, 2026-11-10: "ask the lead").
const HELP_DEADLINE: processes.Deadline = {
  after: "1 day",
  hours: "business",
  ifNoAnswer: "stop",
};

/**
 * Wave 5 review: a v4 notice's durable step, retried as skill and action steps are (apps/api's
 * step config) rather than on the platform's defaults, so its last try is known: only that try's
 * failure is final (`notice`).
 */
const NOTICE_STEP_CONFIG = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
} as const satisfies StepConfig;

/** A person conferee's quick answers. */
const CONFER_CHOICES: NonNullable<PersonStep["choices"]> = [
  { value: "agree", label: "Agree" },
  { value: "disagree", label: "Disagree" },
  { value: "unsure", label: "Not sure" },
];

/**
 * Wave 5: a failure the step itself reported (a failed or escalated outcome, help nobody gave, a
 * conversation that failed), which a step with `onError: continue` goes on past. What it carries
 * comes from stored durable results only, so a replay goes on the same way. Absent on a RunEnd: the
 * run ends whatever the step says (a person's no, nobody answering with `stop`, a stop step, a
 * write that may have happened, an exception).
 */
interface Continued {
  outcome: "failed" | "needs_help";
  /** The error as the step's row says it. */
  error: string;
  /** The approvals decided before it failed. */
  approvals?: NonNullable<processes.StepRecord["approval"]>[];
}

class RunEnd extends Error {
  constructor(
    readonly result: RunResult,
    readonly continued?: Continued,
  ) {
    super(`run ended: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  }
}

/** The error of a failure a step went on past, as its row keeps it. */
function carriedError(ended: RunEnd | undefined): string {
  return ended?.continued?.error ?? ended?.result.reason ?? "";
}

/**
 * Wave 6 review: how an attempt the run ended in the middle of ended, for the owner's check. Only a
 * person can end a run inside an attempt today (a confer reviewer nobody answered with `stop`):
 * a cancel is their no, a timeout nobody answering.
 */
function endedOutcome(end: RunEnd): OwnerCheckAttempt {
  if (end.result.status === "cancelled") return "rejected";
  return end.result.reason === "timeout" ? "unanswered" : "failed";
}

/** A RunEnd a step with `onError: continue` may go on past. */
function continuable(error: unknown): error is RunEnd & { continued: Continued } {
  return error instanceof RunEnd && error.result.status === "failed" && !!error.continued;
}

interface Frame {
  /** Prepended to step ids for durable names: "" at the top, `${loop}:${i}:` inside a loop. */
  prefix: string;
  scope: RunContext;
  /** The workflow's own step list (not a fork path or a loop): where a retry resumes. */
  top?: boolean;
  // v0.12 W2-B
  /** Inside a use step: the automation (`slug@version`) its steps come from. */
  automation?: string;
  // Wave 6 review
  /**
   * Inside a for each: the loop's owner checks, written together in one durable step when the
   * outermost loop ends (`Executor.writeChecks`), not one per attempt.
   */
  checks?: OwnerCheckEntry[];
}

type WorkStep = processes.ReadStep | processes.SkillStep | processes.WriteStep;

/**
 * The label helpers read only a step's `name`, `client` and `kind`, which v4 steps share with v3
 * ones: one cast, here, rather than a second copy of them.
 */
const asLabelled = (step: processes.Step): V3Step => step as unknown as V3Step;

/**
 * Runs `workflow` (a stored v3 workflow or a v4 process) for `ctx.run` with `trigger` as the
 * trigger payload. Returns how the run ended; apps/api records it on `run`. Throws only if the
 * runner itself fails outside any step.
 */
export async function executeWorkflow(
  runner: StepRunner,
  ctx: ExecutorContext,
  workflow: AnyWorkflow,
  trigger: unknown,
): Promise<RunResult> {
  // R3: v4 only. Pure over immutable versions, so a replay or a retry reads the same steps.
  let loaded: LoadedProcess;
  try {
    loaded = loadProcess(workflow, ctx.lookup ?? NO_LOOKUP);
  } catch (error) {
    if (!(error instanceof ProcessLoadError)) throw error;
    return {
      status: "failed",
      reason: error.message,
      errorKey: runErrorKey({ tool: null, kind: "run" }, error.message),
    };
  }
  // v0.12 W2-B: automations expand before execution (ARCHITECTURE §10.7; docs/plan.md §1.45).
  // DECISION: a pinned version the run can't load fails the run at its use step before any step
  // runs, rather than part-way through.
  let expansions: ProcessExpansions;
  // R3: the approval checks a v4 process step sets on its automation's steps (native v4 checks).
  const overrides = new WeakSet<object>();
  try {
    expansions = expandProcesses(
      loaded.process,
      ctx.automations ?? {},
      ctx.lookup ?? NO_LOOKUP,
      loaded.origins,
      overrides,
    );
  } catch (error) {
    if (!(error instanceof ExpandError)) throw error;
    return {
      status: "failed",
      reason: error.message,
      nodeId: error.stepId,
      errorKey: runErrorKey(
        { tool: null, kind: loaded.v3 ? "use_automation" : "process" },
        error.message,
      ),
    };
  }
  const ex = new Executor(runner, ctx, expansions, loaded.origins, overrides);
  // DECISION (wave 5): outcomes are recorded for native v4 processes only; a converted v3 workflow's
  // scope stays `{ output }` (its conditions can't name an outcome, and nothing it reads changes).
  ex.records = loaded.v3 === null;
  // v0.13 M32: checkpoints, from the version's steps and the automations they expand to. Pure over
  // immutable versions, so a replay computes the same set.
  if (ctx.oversight) ex.checkpoints = checkpointsOf(loaded, ctx, expansions);
  try {
    await ex.runList(loaded.process.steps, {
      prefix: "",
      scope: { trigger, steps: {} },
      top: true,
    });
    return { status: "succeeded" };
  } catch (error) {
    if (error instanceof RunEnd) return error.result;
    throw error;
  }
}

/**
 * v0.13 M32: a stored v3 workflow's checkpoints as they always were (core's v3
 * `workflowCheckpoints`); R6: a v4 process's by core's v4 rule (`processes.processCheckpoints`),
 * its process steps' inner checkpoints as `${processStepId}/${innerId}`.
 */
function checkpointsOf(
  loaded: LoadedProcess,
  ctx: ExecutorContext,
  expansions: ProcessExpansions,
): Set<string> {
  const typing = {
    ...(ctx.catalog?.skills ? { skills: ctx.catalog.skills } : {}),
    ...(ctx.catalog?.tools ? { tools: ctx.catalog.tools } : {}),
  };
  if (loaded.v3) {
    const v3 = expandAutomations(loaded.v3, ctx.automations ?? {});
    return new Set(
      workflowCheckpoints(loaded.v3, {
        ...typing,
        automations: Object.fromEntries(Object.values(v3).map((e) => [e.ref, { steps: e.steps }])),
      }),
    );
  }
  return new Set(
    processes.processCheckpoints(loaded.process, {
      ...typing,
      // The pinned versions as the run reads them (v4, with the step's approval overrides).
      processes: Object.fromEntries(Object.values(expansions).map((e) => [e.ref, e])),
    }),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A business-hours wait as the runner takes it: whole seconds until `dueAt`, at least one. */
function untilDue(dueAt: string): Duration {
  return `${Math.max(1, Math.ceil((Date.parse(dueAt) - Date.now()) / 1000))} seconds`;
}

/** How long to wait for a deadline due at `dueAt`: a clock deadline's own duration, as before. */
function timeoutOf(deadline: processes.Deadline, dueAt: string): Duration {
  return deadline.hours === "business" ? untilDue(dueAt) : deadline.after;
}

/** A deadline's `ifNoAnswer`, `stop` when the stored step left it out. */
function thenOf(d: processes.Deadline | undefined): processes.DeadlineThen {
  return d?.ifNoAnswer ?? "stop";
}

class Executor {
  constructor(
    readonly runner: StepRunner,
    readonly ctx: ExecutorContext,
    // v0.12 W2-B
    readonly expansions: ProcessExpansions = {},
    // R3
    readonly origins: Origins = new WeakMap(),
    /** Approval checks a v4 process step set on its automation's (converted) steps. */
    readonly overrides: WeakSet<object> = new WeakSet(),
  ) {}

  // v0.13 W2-I
  /** Oversight decisions taken in this run so far (each counts toward `maxPerRun`). */
  interventions = 0;
  /**
   * v0.13 M32: the workflow's checkpoints (`workflowCheckpoints`): a step by its id, an
   * automation's inner step as `${useStepId}/${innerId}`.
   */
  checkpoints: ReadonlySet<string> = new Set();
  /**
   * Wave 5: whether steps record how they ended beside their output (`steps.<id>.outcome`, …):
   * a native v4 process. A stored v3 workflow's scope stays `{ output }` exactly.
   */
  records = false;

  get testRun(): boolean {
    return this.ctx.run.mode === "test";
  }

  /** The platform's words on the client timeline, in the client's language. */
  get words(): TimelineWords {
    return TIMELINE_WORDS[this.ctx.run.language ?? "en"];
  }

  origin(step: processes.Step): V3Step | undefined {
    return this.origins.get(step);
  }

  /**
   * Wave 5: a step's place in the run scope: its output and, in a native v4 process, how it ended
   * (`processes.StepRecord`), for an `if` after it to route on. Every value comes from the step's
   * stored durable results, so a replayed run records the same and takes the same path.
   */
  record(frame: Frame, step: processes.Step, output: unknown, rec: processes.StepRecord = {}) {
    const entry: RunContext["steps"][string] = { output };
    if (this.records) {
      for (const [k, v] of Object.entries(rec)) {
        if (v !== undefined) (entry as unknown as Record<string, unknown>)[k] = v;
      }
    }
    frame.scope.steps[step.id] = entry;
  }

  /** Wave 5: whether the step goes on past a failure it reported (`onError: continue`). */
  continues(step: processes.Step): boolean {
    return this.records && step.onError === "continue";
  }

  /**
   * Whether the step's approval is a native v4 check (modes, deadlines, `ifNoAnswer`, away
   * approvers skipped): a native step's, or one a v4 process step set on its automation's step. A
   * converted v3 step's approval is decided exactly as v3 decided it.
   */
  nativeApproval(step: processes.Step): boolean {
    const check = step.checks?.approval;
    return !this.origin(step) || (check !== undefined && this.overrides.has(check));
  }

  async runList(steps: readonly processes.Step[], frame: Frame): Promise<void> {
    const resume = frame.top ? this.ctx.resume : undefined;
    let reached = !resume || !steps.some((s) => s.id === resume.from);
    for (const step of steps) {
      if (resume && !reached) {
        if (step.id === resume.from) reached = true;
        else if (resume.reused[step.id]) {
          await this.reuse(step, resume, frame);
          continue;
        }
      }
      await this.runStep(step, frame);
    }
  }

  /** `step_run.skill_ref` for a step: its skill, or the skill a converted read or write ran. */
  skillRefOf(step: processes.Step): string | undefined {
    const origin = this.origin(step);
    if (origin) return origin.kind === "skill" ? origin.skill : undefined;
    return step.kind === "skill" ? step.skill : undefined;
  }

  /**
   * A retry's step before the failed one (ARCHITECTURE §10.10): not run again. Its row is copied
   * from the run retried, with its output, and the summary says where it came from.
   */
  async reuse(step: processes.Step, resume: RunResume, frame: Frame): Promise<void> {
    const row = resume.reused[step.id];
    if (!row) return;
    await this.runner.do(`${step.id}:reused`, async () => {
      const skillRef = this.skillRefOf(step);
      const id = await this.ctx.log.start({
        runId: this.ctx.run.id,
        nodeId: step.id,
        nodeType: storedKind(step, this.origin(step)) as never,
        ...(skillRef ? { skillRef } : {}),
      });
      // DECISION: a step skipped in the run retried (a write a person turned down, a person step
      // that timed out with `continue`) stays skipped: copying it as succeeded would misreport it.
      // Wave 5 review: one failed and carried on past stays failed, its error kept in its output.
      await this.ctx.log.update(id, {
        status: row.status,
        output: row.output,
        summary: `reused from ${resume.of}`,
      });
      return null;
    });
    // Wave 5: a reused step records how it ended in the run retried, whole (outcome, approval,
    // confer, quick answer, counts, error), so a later `if` routes as it did there, and its
    // output as later steps read it there (a failed row's output holds its error, which is the
    // record's: `scopeOutputOfRow`).
    const outcome = processes.outcomeOfStoredRow(step, row);
    this.record(
      frame,
      step,
      "stepOutput" in row
        ? row.stepOutput
        : processes.scopeOutputOfRow(row.status, row.output, step.kind),
      row.record ?? (outcome ? { outcome } : {}),
    );
  }

  async runStep(step: processes.Step, frame: Frame): Promise<void> {
    const name = `${frame.prefix}${step.id}`;
    try {
      switch (step.kind) {
        case "read":
        case "skill":
        case "write":
          return await this.workStep(step, name, frame);
        case "person":
          return await this.person(step, name, frame);
        case "conversation":
          return await this.conversation(step, name, frame);
        case "if":
          return await this.fork(step, name, frame);
        case "for_each":
          return await this.forEach(step, name, frame);
        case "wait":
          return await this.wait(step, name, frame);
        case "notify":
          return await this.notifyStep(step, name, frame);
        case "stop":
          return await this.stop(step, name);
        // v0.12 W2-B
        case "process":
          return await this.useAutomation(step, name, frame);
      }
    } catch (error) {
      if (error instanceof RunEnd) {
        // The innermost step that failed names the error (`error.key`, docs/plan.md §1.40).
        if (error.result.status === "failed" && error.result.errorKey === undefined) {
          error.result.errorKey = this.errorKeyOf(step, error.result.reason);
        }
        throw error;
      }
      await this.recordFailure(step, name, message(error));
      throw new RunEnd({
        status: "failed",
        reason: message(error),
        nodeId: name,
        errorKey: this.errorKeyOf(step, message(error)),
      });
    }
  }

  /** `<tool id or step kind>:<code>`: a write or read (v3: an action) names its tool. */
  errorKeyOf(step: processes.Step, reason: string | undefined): string {
    const origin = this.origin(step);
    return runErrorKey(
      { tool: toolOf(step, origin), kind: storedKind(step, origin) },
      reason ?? null,
    );
  }

  /** Best effort: the step's row says why it failed. The run fails either way. */
  async recordFailure(step: processes.Step, name: string, error: string): Promise<void> {
    try {
      await this.runner.do(`${name}:failed`, async () => {
        const id = await this.ctx.log.start({
          runId: this.ctx.run.id,
          nodeId: name,
          nodeType: storedKind(step, this.origin(step)) as never,
        });
        await this.ctx.log.update(id, {
          status: "failed",
          error,
          summary: `${stepStateLabel(asLabelled(step), false)}: ${this.words.failed}`,
        });
        return null;
      });
    } catch {
      // The log itself failing must not hide the step's own error.
    }
  }

  // ── R3: hours and deadlines ───────────────────────────────────────────────────────────────────

  /** Whose hours: the stored ones, or the default week in the client's zone. */
  async hoursOf(who: string): Promise<HoursAnswer> {
    const { hours, run } = this.ctx;
    if (hours) return hours.hoursFor({ tenantId: run.tenantId, who });
    // DECISION: without stored hours, the default week (Mon to Fri, 8 to 6) in the run's zone.
    return { client: processes.defaultBusinessHours(run.timeZone ?? "UTC") };
  }

  /**
   * When a deadline asked of `who` now is due, and its reminders. Clock time as before
   * (`now + after`); business time on the person's hours (a role's: while any one is working).
   * Called inside a durable step, so a replay keeps the first due time.
   */
  async dueOf(
    who: string,
    deadline: processes.Deadline,
  ): Promise<{ dueAt: string; remindAt: string[] }> {
    const start = new Date();
    const offsets = deadline.remind ?? [];
    // DECISION: each `remind` is a time after the asking (one reminder each); a v3 step's
    // `remindEvery` becomes one reminder.
    if (deadline.hours !== "business") {
      const at = (d: Duration) => new Date(start.getTime() + parseDuration(d)).toISOString();
      return { dueAt: at(deadline.after), remindAt: offsets.map(at) };
    }
    const h = await this.hoursOf(who);
    // DECISION: hours with no open time for five years (an all-closed week, an away range years
    // long) count the deadline in clock time rather than failing the run: it still comes due, and
    // its `ifNoAnswer` still applies, so nothing is loosened (R4's "never as always closed").
    const at = (d: Duration) => {
      try {
        return (
          h.people && h.people.length > 0
            ? processes.dueAtForMany(start, d, { hours: "business", people: h.people })
            : processes.dueAt(start, d, {
                hours: "business",
                businessHours: processes.effectiveHours(h.client, h.person),
                away: h.person?.away,
              })
        ).toISOString();
      } catch (error) {
        if (!(error instanceof processes.NoOpenTimeError)) throw error;
        return new Date(start.getTime() + parseDuration(d)).toISOString();
      }
    };
    return { dueAt: at(deadline.after), remindAt: offsets.map(at) };
  }

  /** Whether `who` is away today (a role: everyone in it), on the stored hours. */
  async isAway(who: string): Promise<boolean> {
    if (!this.ctx.hours) return false;
    const h = await this.hoursOf(who);
    const now = new Date();
    if (h.people && h.people.length > 0) {
      return h.people.every((p) =>
        processes.isAway(now, { hours: p.businessHours, away: [...(p.away ?? [])] }, h.client),
      );
    }
    return h.person ? processes.isAway(now, h.person, h.client) : false;
  }

  /** A deadline passed: its `tell` people are told (only `operator` without the port's `tell`). */
  async tell(
    to: readonly string[] | undefined,
    notice: { nodeId: string; inboxItemId: string | null; reason: string },
  ): Promise<void> {
    if (!to || to.length === 0) return;
    const { notify, run } = this.ctx;
    if (notify.tell) {
      await notify.tell({ run, ...notice, to: [...to] });
      return;
    }
    if (to.includes("operator") && notice.inboxItemId) {
      await notify.notifyOperator({
        run,
        nodeId: notice.nodeId,
        inboxItemId: notice.inboxItemId,
        reason: notice.reason,
      });
    }
  }

  /**
   * An `escalate` chain: the same question to `to`, with its own deadline, then its own
   * `ifNoAnswer`, recursively. Ends with an answer, or with `stop`, `proceed` or `skip`.
   */
  async escalate(
    base: string,
    then: processes.DeadlineThen,
    ask: Asker | null,
    depth = 1,
  ): Promise<{ resolution: InboxResolution } | { ended: "stop" | "proceed" | "skip" }> {
    if (typeof then === "string") return { ended: then };
    // DECISION: an escalation with nobody to ask it through (a port without `askApprover`) stops,
    // the safe side: it never turns into `proceed` without a person.
    if (!ask) return { ended: "stop" };
    const { to, deadline } = then.escalate;
    const b = `${base}:esc${depth}`;
    const asked = await ask(b, to, deadline);
    const answer = await this.awaitResolution(b, asked.item, asked.timeout);
    if (answer) return { resolution: answer };
    if (deadline.tell?.length) {
      await this.runner.do(`${b}:tell`, async () => {
        await this.tell(deadline.tell, {
          nodeId: b,
          inboxItemId: asked.item,
          reason: `no answer from ${to} within ${deadline.after}`,
        });
        return null;
      });
    }
    return this.escalate(base, thenOf(deadline), ask, depth + 1);
  }

  /** Asks a person through the inbox (a conferee, an escalated question, a sign-off). */
  personAsker(
    stepRunId: string,
    item: {
      stepId: string;
      name: string;
      title: string;
      payload: unknown;
      mode?: "ask" | "approve";
      choices?: PersonStep["choices"];
    },
  ): Asker {
    return async (b, who, deadline) => {
      const d = deadline ?? { after: DEFAULT_APPROVAL_TIMEOUT, hours: "clock", ifNoAnswer: "stop" };
      const created = await this.runner.do(`${b}:ask`, async () => {
        const { dueAt, remindAt } = await this.dueOf(who, d);
        const view = askView({
          id: item.stepId,
          name: item.name,
          who,
          title: item.title,
          after: d.after,
          ...(item.mode ? { mode: item.mode } : {}),
          ...(item.choices ? { choices: item.choices } : {}),
        });
        const made = await this.ctx.inbox.createForPerson({
          run: this.ctx.run,
          step: view,
          nodeId: b,
          stepRunId,
          kind: item.mode === "approve" ? "approval" : "request",
          title: item.title,
          payload: item.payload,
          dueAt,
          ...(remindAt.length > 0 ? { remindAt } : {}),
        });
        return { item: made.id, dueAt };
      });
      return { item: created.item, timeout: timeoutOf(d, created.dueAt) };
    };
  }

  // ── skill and action steps ────────────────────────────────────────────────────────────────────

  /**
   * The step's timeline line. A test run's write says what would have been done, in one place for
   * every tool (its summary template describes a write that happened). A template that can't fill
   * every slot falls back to the label: never a sentence with a gap.
   */
  summaryFor(
    step: SkillStep | ActionStep,
    output: unknown,
    rejected: boolean,
    notWritten = false,
  ): string {
    if (rejected) return `${stepStateLabel(step, false)}: ${this.words.notApproved}`;
    if (notWritten) return this.words.wouldWrite(step.name);
    const catalog = this.ctx.catalog ?? {};
    const template =
      step.kind === "skill"
        ? lookupSkill(step.skill, catalog)?.summary
        : catalog.tools?.[step.tool]?.summary;
    if (template) {
      try {
        const line = renderSummary(template, output, this.ctx.run.language);
        if (line) return line;
      } catch {
        // A broken template falls back to the label: the timeline never shows model text.
      }
    }
    return `${clientLabel(step)}: ${this.words.done}`;
  }

  /**
   * Records an outcome on the step's row (inside the caller's `do`) and returns it, turning a
   * test run's approval into "would have done": test runs never wait on, or make, a write.
   */
  async settle(
    step: SkillStep | ActionStep,
    stepRunId: string,
    outcome: StepOutcome,
    rejected: boolean,
    // R3: a write that went ahead without an answer says so on its row.
    extra: Pick<StepRunUpdate, "proceededWithoutAnswer" | "externalActionId"> = {},
  ): Promise<StepOutcome> {
    const done: StepOutcome =
      outcome.kind === "approval" && this.testRun
        ? { kind: "done", output: outcome.output ?? null, notWritten: true }
        : outcome;
    // P-6: a person who ended the step (a live conversation) turned it down (§1.68).
    const turnedDown = rejected || (done.kind === "done" && done.declined === true);
    let update: StepRunUpdate;
    switch (done.kind) {
      case "done":
        update = {
          status: turnedDown ? "skipped" : "succeeded",
          output: done.output,
          summary: this.summaryFor(
            step,
            done.output,
            turnedDown,
            this.testRun && done.notWritten === true,
          ),
          ...extra,
        };
        if (done.costUsd !== undefined) update.costUsd = done.costUsd;
        if (done.tokensIn !== undefined) update.tokensIn = done.tokensIn;
        if (done.tokensOut !== undefined) update.tokensOut = done.tokensOut;
        break;
      case "approval":
        update = {
          status: "waiting",
          // Not done yet: "Itemize the bill", never the done label "Itemized the bill".
          summary: `${stepStateLabel(step, false)}: ${
            // P-4: a conversation handed to a person waits for their answer (§1.66).
            done.pending.waitingFor === "answer"
              ? this.words.waitingForAnswer
              : this.words.waitingForApproval
          }`,
        };
        break;
      case "waiting":
        update = {
          status: "waiting",
          summary: `${stepStateLabel(step, false)}: ${done.wait.reason === "release" ? this.words.waitingForRelease : "waiting for a reply"}`,
        };
        break;
      case "escalated":
        update = {
          status: "failed",
          error: `escalated: ${done.reason}`,
          summary: `${stepStateLabel(step, false)}: ${this.words.needsOperator}`,
        };
        break;
      case "failed":
        update = {
          status: "failed",
          error: done.error,
          summary: `${stepStateLabel(step, false)}: ${this.words.failed}`,
        };
        break;
    }
    await this.ctx.log.update(stepRunId, update);
    return done;
  }

  /**
   * R3: a read, skill or write step, with its checks in order: confer, then approval, then the
   * step's write, then notify. A write confers on its input before it is proposed. A skill that
   * proposes a write confers on it before its approval is decided (the gate's approval, in the
   * check's mode, deadlines and `ifNoAnswer`), so the write follows both. A read, or a skill that
   * proposed no write, runs first, confers on its output, and its approval is a sign-off of that
   * output. Converted v3 steps carry only an approval, which the gate takes exactly as before.
   */
  async workStep(
    step: WorkStep,
    name: string,
    frame: Frame,
    mapInput?: (input: unknown) => unknown,
    binding?: { connector: string; connectionId: string },
  ): Promise<void> {
    // Skill model (2026-11-10): an action resolves to its tool first (durably), then runs exactly
    // as a write step calling that tool, its input mapped to the tool's when each attempt starts.
    if (step.kind === "write" && step.action !== undefined) {
      const { action, via: _via, ...rest } = step;
      const resolved = await this.resolveAction(name, action, step.via);
      const concrete: processes.WriteStep = {
        ...rest,
        tool: resolved.tool,
        name: processes.actionStepLabel(action, resolved.connector, step.name),
      };
      return this.workStep(
        concrete,
        name,
        frame,
        (input) => processes.actionToolInput(action, resolved.tool, input),
        resolved.connectionId
          ? { connector: resolved.connector, connectionId: resolved.connectionId }
          : undefined,
      );
    }
    const origin = this.origin(step);
    const checks = step.checks;
    const check = checks?.approval;
    // A read, or a skill the catalog knows writes nothing and contacts nobody: its output exists
    // when its approval is asked (the validator's rule), so the approval signs off that output.
    const readLike = processes.outputBeforeChecks(step, this.typing());
    let runs: WorkStep = step;
    let custom: processes.CustomizedSkill | undefined;
    if (step.kind === "skill" && step.customize) {
      custom = this.customized(step, step.customize);
      // The step's two layers; the skill's defaults and the agent's own settings for the skill
      // are the runtime's, beneath them (run-agent's `resolveSkillSettings`).
      const settings = processes.stepSkillSettings(
        { settings: [] },
        { step: step.settings, customization: custom.settings },
      );
      // DECISION: a step `model` beats the customization's.
      const model = step.model ?? step.customize.model;
      runs = {
        ...step,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(model ? { model } : {}),
      };
    }
    // Only the customized output's fields, when the customization keeps some.
    const shape = (output: unknown): unknown =>
      custom && step.kind === "skill" && step.customize?.keep
        ? keptFields(output, custom.definition.output)
        : output;

    // Confer: before a write step's write is proposed (once), before each write a skill proposes
    // (its own durable names), or else once on a read's or skill's output. `conferred` is the
    // latest verdicts, which the approval's and notifications' conditions read.
    let conferred: ConferEntry[] | undefined;
    let outputConferred = false;
    let proposalConferred = false;
    const conferOn = async (
      at: string,
      data: { input: unknown; output?: unknown; own?: { id: string; output: unknown } },
    ) => {
      if (!checks?.confer) return;
      conferred = await this.confer(step, at, frame.scope, checks.confer, data);
    };
    const input = () => resolveTemplate(step.input, frame.scope);
    if (step.kind === "write") await conferOn(name, { input: input() });
    const conferOutput = async (output: unknown) => {
      // A skill whose proposed writes were conferred on isn't conferred on again.
      if (outputConferred || proposalConferred) return;
      outputConferred = true;
      await conferOn(name, { input: input(), output, own: { id: step.id, output } });
    };

    // A native approval is planned (who is away known); a converted one goes to the gate as v3's.
    const plan =
      check && this.nativeApproval(step) ? await this.approverPlan(name, check) : undefined;
    const firstWho = plan?.approvers.find((a) => !a.away)?.who ?? null;
    let gate = gateApproval(check, plan ? firstWho : undefined);
    // An approval limited to some runs (`when`) doesn't apply on the others: the gate decides
    // those as `not_required` (still held to the matrix, the grant and the mode, §9.5). A sign-off's
    // `when` reads the step's own output, after it runs (below). Before the run, a `when` that
    // reads what isn't there yet (a skill's verdicts, which come after its proposal) applies.
    // DECISION: the gate takes a write's approval before the skill runs, so a `when` that reads
    // the verdicts of the confer on a skill's proposed write keeps the approval required: once
    // the write is proposed, only the gate could loosen it, and it has already decided. Where the
    // `when` can still decide after the confer (the sign-off of a skill that proposed no write),
    // it is read there. A verdict never loosens a write.
    if (gate && check?.when && !(plan && readLike)) {
      const applies = await this.runner.do(`${name}:approval:when`, async () =>
        approvalApplies(
          check.when as NonNullable<typeof check.when>,
          checkScope(frame.scope, undefined, conferred),
        ),
      );
      if (!applies) gate = { ...gate, required: "not_required" };
    }
    const view = workView(runs, origin, gate);
    const approval: Approval =
      view.kind === "action" ? view.approval : (view.approval ?? DEFAULT_APPROVAL);
    const opts: WorkOptions = {
      // Any write the step proposes is signed in the native check's mode (a read-like skill's too,
      // should it propose one after all).
      ...(plan ? { plan } : {}),
      ...(step.kind === "skill" && step.customize ? { customize: step.customize } : {}),
      // A converted step's row keeps its stored kind; a native read or write is named as such.
      ...(!origin && step.kind !== "skill" ? { nodeType: step.kind } : {}),
      // R6: the owner watches the native step itself (a converted step as its stored v3 step).
      ...(!origin ? { watched: step } : {}),
      verdicts: () => conferred,
      ...(mapInput ? { mapInput } : {}),
      ...(binding ? { binding } : {}),
    };
    if (step.kind === "skill" && checks?.confer) {
      opts.beforeApproval = async (proposal) => {
        proposalConferred = true;
        await conferOn(proposal.at, { input: proposal.input, output: proposal.output });
      };
    }
    if (step.kind !== "write" && checks?.confer) {
      opts.afterRun = async (output) => {
        // A request for help isn't the step's result: it is conferred on once answered.
        if (needsHelpOf(output, !origin)) return;
        await conferOutput(shape(output));
      };
    }
    // Wave 5: how it ended, for a later `if` (`steps.<id>.outcome`, `.approval`, `.confer`).
    let approvals: ApprovalRecord[] = [];
    const recorded = (outcome: string, extra: processes.StepRecord = {}): processes.StepRecord => ({
      outcome,
      approval: processes.combinedApproval(approvals),
      ...(conferred ? { confer: processes.conferRecord(conferred) } : {}),
      ...extra,
    });
    let output: unknown;
    let proposed: boolean;
    let stepRunId: string;
    let why: NotRun | undefined;
    try {
      const done = await this.work(view, name, frame, approval, opts);
      approvals = done.approvals ?? [];
      if (!done.ran) {
        this.record(frame, step, done.output, recorded(done.why));
        return;
      }
      output = done.output;
      proposed = done.proposed;
      stepRunId = done.stepRunId;

      // R3: a native skill that couldn't do it asks the lead, then runs once more with the answer.
      // Wave 4: so does a native read or write step whose tool asked (a recorded script whose page
      // changed answers `needsHelp`, docs/plan.md §1.86 "Scripts (wave 4)").
      // DECISION: any native work step's `needsHelp` output asks; a converted v3 step's never does.
      if (!origin) {
        const helped = await this.needsHelp(view, name, frame, approval, done, opts);
        output = helped.output;
        proposed = helped.proposed;
        why = helped.why;
        if (helped.approvals) approvals = [...approvals, ...helped.approvals];
      }
    } catch (error) {
      // Wave 5 review: a skill or write whose failure came with a write made, or one that may have
      // been (the runtime's `notWritten` missing on a failed action), is never gone on past, here
      // or by a loop or sub-process around it: the run ends there and the operator checks it.
      if (
        this.records &&
        step.kind !== "read" &&
        continuable(error) &&
        error.result.nodeId === name &&
        (await this.wrote(name))
      ) {
        throw new RunEnd(error.result);
      }
      // Wave 5: `onError: continue` goes on past a failure the step reported, its row already
      // failed; it records the outcome and a plain reason. Nothing is retried, and nothing was
      // written (`wrote` above; a write that may have happened, `finishWork` never lets past).
      if (!this.continues(step) || !continuable(error) || error.result.nodeId !== name) throw error;
      approvals = [...approvals, ...(error.continued.approvals ?? [])];
      this.record(
        frame,
        step,
        null,
        recorded(error.continued.outcome, {
          error: processes.plainError(
            error.continued.error,
            error.continued.outcome === "needs_help" ? "needs_help" : undefined,
          ),
        }),
      );
      return;
    }
    output = shape(output);

    if (step.kind !== "write" && checks?.confer) await conferOutput(output);
    // The sign-off: a read's, or a skill's that proposed no write (a proposed write was signed
    // through the gate above, in the check's mode). A write step's approval is only ever the
    // gate's.
    const signOff = plan && step.kind !== "write" && !proposed ? plan : undefined;
    const signs =
      signOff &&
      gate?.required !== "not_required" &&
      (!check?.when ||
        (await this.runner.do(`${name}:signoff:when`, async () =>
          approvalApplies(
            check.when as NonNullable<typeof check.when>,
            checkScope(frame.scope, { id: step.id, output }, conferred),
          ),
        )));
    if (signOff && signs) {
      const decided = await this.signOff(step, name, stepRunId, signOff, output);
      if (decided.approval) approvals = [...approvals, decided.approval];
      if (!decided.go) {
        this.record(frame, step, null, recorded(decided.why ?? "rejected"));
        return;
      }
    }
    if (checks?.notify?.length) {
      const scope = checkScope(frame.scope, { id: step.id, output }, conferred);
      for (const [i, n] of checks.notify.entries()) {
        await this.notice(n, `${name}:notify:${i}`, scope, clientLabel(view));
      }
    }
    // DECISION (wave 5): a read that found nothing is `empty` (`processes.isEmptyOutput`); a re-run
    // after help that was turned down keeps the output it had and says why.
    const ended =
      why ?? (step.kind === "read" && processes.isEmptyOutput(output) ? "empty" : "done");
    this.record(frame, step, output, recorded(ended));
  }

  /**
   * Skill model (2026-11-10): the tool an action write step runs with for this run's agent
   * (`AgentPort.resolveAction`), resolved once in a durable step (`<name>:action`), so a replay,
   * and every attempt and approval of the step, resolve the same way.
   */
  // DECISION: an action that doesn't resolve (its connection unbound since publish, two without
  // `via`) fails the step before anything is proposed, like a tool that isn't registered; nothing
  // was written, and the run ends there (it isn't a failure `onError: continue` goes on past).
  async resolveAction(
    name: string,
    action: processes.WriteAction,
    via: string | undefined,
  ): Promise<Exclude<ResolvedAction, { refused: string }>> {
    const label = processes.ACTION_SPECS[action].label;
    const port = this.ctx.agent.resolveAction;
    if (!port) throw new Error(`refused: ${label} can't run here: nothing resolves it to a tool`);
    const r = await this.runner.do(`${name}:action`, () =>
      port.call(this.ctx.agent, {
        run: this.ctx.run,
        nodeId: name,
        action,
        ...(via !== undefined ? { via } : {}),
      }),
    );
    if ("refused" in r) throw new Error(`refused: ${r.refused}`);
    if (processes.actionTool(action, r.connector) !== r.tool) {
      throw new Error(`refused: ${label} doesn't run with ${r.tool}`);
    }
    return r;
  }

  /** A work step's input for an attempt: resolved, and as an action's tool takes it. */
  stepInput(step: SkillStep | ActionStep, frame: Frame, opts: WorkOptions): unknown {
    const input = resolveTemplate(step.input, frame.scope);
    return opts.mapInput ? opts.mapInput(input) : input;
  }

  /**
   * Wave 5 review: whether a failed step's writes were made, or may have been (`AgentPort
   * .stepWrites`, read once in a durable step so a replay decides the same way).
   */
  // DECISION (wave 5 review): `onError: continue` goes on past a skill's or a write's failure only
  // when every write the step proposed is known not to have been made (the gate refused it, its
  // input was invalid, its release was refused, its connection was gone, the connector said the
  // provider turned it down): what the external actions say, not the error's words. A skill that
  // made any write and then failed doesn't go on: the run ends with its writes done.
  async wrote(name: string): Promise<boolean> {
    const port = this.ctx.agent.stepWrites;
    if (!port) return false;
    return this.runner.do(`${name}:writes`, () =>
      port.call(this.ctx.agent, { run: this.ctx.run, nodeId: name }),
    );
  }

  /** What the catalog says about skills and tools, as core's typing reads it. */
  typing(): Parameters<typeof lookupSkill>[1] {
    const catalog = this.ctx.catalog ?? {};
    return {
      ...(catalog.skills ? { skills: catalog.skills } : {}),
      ...(catalog.tools ? { tools: catalog.tools } : {}),
    };
  }

  /**
   * A skill step's customization, checked against the catalog's definition
   * (`processes.customizeSkill`, which throws naming every problem): the step fails before it runs.
   */
  // DECISION: a customization the executor can't check (the skill isn't in the catalog), or one
  // that adds instructions or rule rows for a port that doesn't apply them, fails the step: it
  // would otherwise run without what the step says, silently.
  customized(
    step: processes.SkillStep,
    customization: processes.SkillCustomization,
  ): processes.CustomizedSkill {
    const def = lookupSkill(step.skill, this.ctx.catalog ?? {});
    if (!def) {
      throw new Error(
        `the skill ${step.skill} isn't in the catalog, so the step's changes to it can't be checked`,
      );
    }
    const custom = processes.customizeSkill(def, customization);
    if (
      (customization.addInstructions !== undefined || customization.rules !== undefined) &&
      this.ctx.agent.appliesCustomization !== true
    ) {
      throw new Error(
        "the step adds instructions or rule rows to its skill, but the agent port doesn't apply them",
      );
    }
    return custom;
  }

  /**
   * A native approval's approvers, who is away known before the step runs (a durable step, only
   * when stored hours can say so): an away approver is skipped at once, never waited for. Only
   * for native v4 checks: a converted v3 approver is waited for as v3 did.
   */
  async approverPlan(name: string, check: processes.ApprovalCheck): Promise<ApprovalPlan> {
    const list: NonNullable<processes.ApprovalCheck["approvers"]> =
      check.approvers && check.approvers.length > 0 ? check.approvers : [{}];
    if (!this.ctx.hours || list.every((a) => !a.who)) {
      return { check, approvers: list.map((a) => ({ ...a, away: false })) };
    }
    const away = await this.runner.do(`${name}:approvers`, async () =>
      Promise.all(list.map((a) => (a.who ? this.isAway(a.who) : false))),
    );
    return { check, approvers: list.map((a, i) => ({ ...a, away: away[i] === true })) };
  }

  /**
   * A skill or action step (as the ports see it) and its approvals and oversight. Returns its
   * output, or that it was turned down or skipped (nothing after it in the step runs).
   */
  async work(
    step: SkillStep | ActionStep,
    name: string,
    frame: Frame,
    approval: Approval,
    opts: WorkOptions = {},
  ): Promise<WorkDone> {
    // v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54). Without a port, or when
    // this step's failures aren't reviewed, the first attempt is the only one, exactly as before.
    if (this.oversees(step, opts)) {
      const done = await this.overseen(step, name, frame, approval, opts);
      if (done.kind === "thrown") {
        if (done.diagnosis === undefined) throw done.error;
        const reason = message(done.error);
        await this.recordFailure(step as unknown as processes.Step, name, reason);
        throw new RunEnd({
          status: "failed",
          reason,
          nodeId: name,
          errorKey: ownerErrorKey(opts.watched ?? step, reason),
          diagnosis: done.diagnosis,
        });
      }
      if (done.kind === "skipped") return { ran: false, output: null, why: "skipped" };
      // v0.13 M32: stopped at a checkpoint, before the write it feeds.
      if (done.kind === "cancelled") {
        throw new RunEnd({
          status: "cancelled",
          reason: done.reason,
          nodeId: name,
          ...withDiagnosis(done.diagnosis),
        });
      }
      return this.finishWork(name, approval, done.attempt, done.diagnosis);
    }
    // Wave 6: the owner doesn't watch this step (it is off, or the step's review is): recorded too.
    const unwatched = (attemptOutcome: OwnerCheckAttempt) =>
      this.recordCheck(
        name,
        opts,
        {
          attempt: 1,
          result: "not_watched",
          attemptOutcome,
          signals: [],
          reason: opts.watched?.review === "off" ? "step_off" : "owner_off",
        },
        frame,
      );
    let only: Attempt;
    try {
      only = await this.attempt(step, name, frame, approval, undefined, opts);
    } catch (error) {
      // Wave 6 review: a run a person ended during the attempt records its check too.
      await unwatched(error instanceof RunEnd ? endedOutcome(error) : "failed");
      throw error;
    }
    await unwatched(attemptOutcomeOf(only));
    return this.finishWork(name, approval, only);
  }

  /**
   * How the step's last attempt ended decides the run (unchanged by oversight). Wave 5: a failure
   * it reported carries what `onError: continue` needs (`RunEnd.continued`), except one whose
   * write may have happened, which always ends the run (a person checks it, never a route).
   */
  finishWork(
    name: string,
    approval: Approval,
    { outcome, rejected, skipped, unanswered, stepRunId, proposed, approvals = [] }: Attempt,
    diagnosis?: string,
  ): WorkDone {
    if (outcome.kind === "escalated") {
      const reason = `escalated: ${outcome.reason}`;
      throw new RunEnd(
        { status: "failed", reason, nodeId: name },
        { outcome: "failed", error: reason, approvals },
      );
    }
    if (outcome.kind === "failed") {
      throw new RunEnd(
        {
          status: "failed",
          reason: outcome.error,
          nodeId: name,
          // v0.13 W2-I: the last decision's note, for `run.failed` (operator side only).
          ...(diagnosis === undefined ? {} : { diagnosis }),
        },
        // DECISION (wave 5): a failure whose write may have happened (the connector's
        // `UnconfirmedWriteError`) is never gone on past: the action is with the operator to check,
        // and a recovery path must not run beside a write that may be there.
        processes.writeMayHaveHappened(outcome.error)
          ? undefined
          : { outcome: "failed", error: outcome.error, approvals },
      );
    }
    if (outcome.kind !== "done") throw new Error("unreachable");
    if (rejected && approval.onReject === "stop" && !skipped) {
      // DECISION: a rejected write ends the run as `cancelled` (a person's decision, not a fault).
      throw new RunEnd({ status: "cancelled", reason: "rejected", nodeId: name });
    }
    if (rejected) {
      return {
        ran: false,
        output: outcome.output,
        why: unanswered ? "no_answer" : "rejected",
        approvals,
      };
    }
    return { ran: true, output: outcome.output, stepRunId, proposed: proposed === true, approvals };
  }

  /**
   * One attempt at a skill or action step: the step, then its approvals and waits. The first
   * attempt's durable names are the step's own (`name`, `name:approval:n`); v0.13 W2-I: an
   * oversight retry's are under `${name}:retry:${seq}`, on the same step_run row.
   */
  async attempt(
    step: SkillStep | ActionStep,
    name: string,
    frame: Frame,
    approval: Approval,
    retry?: AttemptRetry,
    opts: WorkOptions = {},
  ): Promise<Attempt> {
    const { run, agent, log } = this.ctx;
    const at = retry ? (retry.at ?? `${name}:retry:${retry.seq}`) : name;
    const keyNode = retry && retry.keyNode !== name ? retry.keyNode : undefined;
    const first = await this.runner.do(
      at,
      async (tried) => {
        // Skill model: an action's input the tool can't take is refused before anything is sent.
        let input: unknown;
        let refused: string | undefined;
        try {
          input = retry ? retry.input : this.stepInput(step, frame, opts);
        } catch (error) {
          if (!(error instanceof processes.ActionInputError)) throw error;
          input = resolveTemplate(step.input, frame.scope);
          refused = `refused: ${error.message}`;
        }
        const start = {
          runId: run.id,
          nodeId: name,
          nodeType: opts.nodeType ?? step.kind,
          input,
          // v0.13 W2-I
          ...(retry ? { attempt: retry.seq + 1 } : {}),
          // v0.14 W4-B: a platform retry of this attempt is one more attempt on the step's row.
          ...((tried?.attempt ?? 1) > 1 ? { retried: true } : {}),
        } as const;
        const stepRunId = await log.start(
          step.kind === "skill" ? { ...start, skillRef: step.skill } : start,
        );
        const request = {
          run,
          nodeId: name,
          stepRunId,
          input,
          approval,
          // v0.12 W2-B: an automation's step runs as the using agent, with the automation's skills.
          ...(frame.automation ? { automation: frame.automation } : {}),
          // v0.13 W2-I
          ...(keyNode ? { keyNode } : {}),
        };
        const outcome: StepOutcome =
          refused !== undefined
            ? { kind: "failed", error: refused }
            : step.kind === "skill"
              ? await agent.runSkill({
                  ...request,
                  step,
                  // R3: the runtime applies a v4 step's added instructions and rule rows.
                  ...(opts.customize ? { customize: opts.customize } : {}),
                })
              : await agent.runAction({
                  ...request,
                  step,
                  ...(opts.binding ? { binding: opts.binding } : {}),
                });
        return { stepRunId, outcome: await this.settle(step, stepRunId, outcome, false) };
      },
      this.ctx.stepConfig,
    );

    const { stepRunId } = first;
    let outcome = first.outcome;
    let rejected = false;
    let skipped = false;
    let unanswered = false;
    const approvals: ApprovalRecord[] = [];
    // A test run's write comes back as done, recorded unmade.
    let proposed =
      outcome.kind === "approval" || (outcome.kind === "done" && outcome.notWritten === true);
    for (let n = 1; outcome.kind === "approval" || outcome.kind === "waiting"; n++) {
      if (outcome.kind === "waiting") {
        outcome = await this.awaitStep(
          step,
          name,
          stepRunId,
          outcome.wait,
          n,
          rejected,
          at,
          keyNode,
          opts.binding,
        );
        continue;
      }
      proposed = true;
      const pending = outcome.pending;
      const base = `${at}:approval:${n}`;
      // R3: a native skill's confer comes before the approval of each write it proposes: a later
      // proposal, a corrected retry's or the re-run after the lead's help, has its own.
      if (opts.beforeApproval) {
        await opts.beforeApproval({
          at: at === name && n === 1 ? name : base,
          input: retry ? retry.input : this.stepInput(step, frame, opts),
          output: outcome.output,
        });
      }
      const decided = await this.decideApproval(step, base, stepRunId, pending, approval, opts);
      const resolution = decided.resolution;
      // P-6: a withdrawn item (a conversation taken over) is no decision: the port goes on (§1.68).
      if (resolution.approved !== true && resolution.withdrawn !== true) rejected = true;
      if (decided.skip) skipped = true;
      // Wave 5: nobody answering is no person's no (`no_answer`, not `rejected`).
      if (decided.skip || decided.unanswered) unanswered = true;
      const decision = approvalRecord(decided);
      if (decision) approvals.push(decision);
      const extra = decided.proceeded
        ? {
            proceededWithoutAnswer: true,
            ...(pending.actionId ? { externalActionId: pending.actionId } : {}),
          }
        : {};
      outcome = await this.runner.do(
        `${base}:resume`,
        async () => {
          const next = await agent.resume({
            run,
            step,
            nodeId: name,
            stepRunId,
            pending,
            resolution,
          });
          return this.settle(step, stepRunId, next, rejected, extra);
        },
        this.ctx.stepConfig,
      );
    }
    // P-6: a step a person ended outside an approval takes its onReject (§1.68).
    if (outcome.kind === "done" && outcome.declined === true) rejected = true;
    return {
      stepRunId,
      outcome,
      rejected,
      ...(skipped ? { skipped } : {}),
      ...(proposed ? { proposed } : {}),
      ...(unanswered ? { unanswered } : {}),
      ...(approvals.length > 0 ? { approvals } : {}),
    };
  }

  /**
   * Who signs a write and what came of it. Without a native v4 plan (every converted v3 step),
   * exactly as before: the gate's item, its timeout, and no answer counts as not approved. With
   * one, the approval engine (`approve`), the gate's item asking the first approver present.
   */
  async decideApproval(
    step: SkillStep | ActionStep,
    base: string,
    stepRunId: string,
    pending: PendingApproval,
    approval: Approval,
    opts: WorkOptions,
  ): Promise<Decided> {
    const fallback = approval.timeout ?? this.ctx.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;
    if (!opts.plan) {
      const resolution = await this.awaitResolution(base, pending.inboxItemId, fallback);
      // Wave 5: `unanswered` only says why (for the outcome); it decides as it always did.
      return resolution
        ? { resolution }
        : { resolution: { approved: false, by: null }, unanswered: true };
    }
    const { agent, run } = this.ctx;
    const ask: Asker | null = agent.askApprover
      ? async (b, who, deadline) => {
          const d = deadline ?? { after: fallback, hours: "clock", ifNoAnswer: "stop" };
          const asked = await this.runner.do(`${b}:ask`, async () => {
            const { dueAt, remindAt } = await this.dueOf(who, d);
            const made = await agent.askApprover?.({
              run,
              step,
              nodeId: b,
              stepRunId,
              pending,
              who,
              dueAt,
              ...(remindAt.length > 0 ? { remindAt } : {}),
            });
            if (!made) throw new Error("the agent port can't ask another approver");
            return { item: made.inboxItemId, dueAt };
          });
          return { item: asked.item, timeout: timeoutOf(d, asked.dueAt) };
        }
      : null;
    return this.approve(base, opts.plan, {
      ask,
      first: pending.inboxItemId,
      fallback,
      nameOf: (k) => (k === 0 ? base : `${base}:a${k}`),
    });
  }

  /**
   * The approval engine, for a write's gate approval and a read's or skill's sign-off alike: the
   * check's mode over the approvers present (away ones skipped), each on their own deadline, then
   * `ifNoAnswer` (an escalation asked first). `in_turn`: one at a time, the first answer decides.
   * `any`: everyone at once, the first answer decides. `all`: everyone at once, everyone's yes or
   * the first no. A reject is an answer: it ends the asking at once.
   */
  // DECISION: `all` with more than one approver present and no way to ask more than the gate's
  // one item (a port without `askApprover`) fails the step, the gate's item expired: one signature
  // must never stand for several (invariant 8). `in_turn` and `any` need one answer, so they ask
  // the gate's approver alone and `ifNoAnswer` applies when nobody answers.
  async approve(base: string, plan: ApprovalPlan, how: ApprovalAsking): Promise<Decided> {
    const present = plan.approvers.filter((a) => !a.away);
    const expireFirst = async () => {
      const first = how.first;
      if (!first) return;
      await this.runner.do(`${base}:expire`, async () => {
        await this.ctx.inbox.expire(first);
        return null;
      });
    };
    if (present.length === 0) {
      // Everyone is away: nobody is waited for, and the approval's `ifNoAnswer` applies.
      await expireFirst();
      return this.noAnswer(base, plan.check, how.ask);
    }
    const mode = plan.check.mode ?? "in_turn";
    const { ask } = how;
    if (mode === "all" && present.length > 1 && !ask) {
      await expireFirst();
      throw new Error(
        `the approval needs all ${present.length} approvers to sign, but the agent port can ask only one`,
      );
    }
    const askOne = async (
      k: number,
      a: PlannedApprover,
    ): Promise<{ b: string; item: string; timeout: Duration }> => {
      const b = how.nameOf(k);
      if (k === 0 && how.first) {
        return { b, item: how.first, timeout: await this.firstTimeout(base, a, how.fallback) };
      }
      if (!ask) throw new Error("the agent port can't ask another approver");
      return { b, ...(await ask(b, a.who ?? DEFAULT_APPROVER, a.deadline)) };
    };
    if (mode === "in_turn" || present.length === 1 || !ask) {
      // One at a time, in order; the next once the one before's deadline passes.
      for (const [k, a] of present.entries()) {
        if (k > 0 && !ask) break;
        const asked = await askOne(k, a);
        const resolution = await this.awaitResolution(asked.b, asked.item, asked.timeout);
        if (resolution) return { resolution };
        await this.tellPassed(asked.b, a, asked.item);
      }
      return this.noAnswer(base, plan.check, ask);
    }
    // `any` and `all`: everyone at once.
    const entries: { b: string; item: string; timeout: Duration; a: PlannedApprover }[] = [];
    for (const [k, a] of present.entries()) entries.push({ ...(await askOne(k, a)), a });
    const resolution = await this.awaitGroup(base, entries, mode);
    if (resolution) return { resolution };
    for (const e of entries) await this.tellPassed(e.b, e.a, e.item);
    return this.noAnswer(base, plan.check, ask);
  }

  /** How long the approver the gate asked has: their deadline (business: on their hours). */
  async firstTimeout(base: string, a: PlannedApprover, fallback: Duration): Promise<Duration> {
    const d = a.deadline;
    if (!d) return fallback;
    if (d.hours !== "business") return d.after;
    const { dueAt } = await this.runner.do(`${base}:due`, () =>
      this.dueOf(a.who ?? DEFAULT_APPROVER, d),
    );
    return untilDue(dueAt);
  }

  /** An approver's deadline passed: whoever it tells is told. */
  async tellPassed(b: string, a: PlannedApprover, item: string): Promise<void> {
    if (!a.deadline?.tell?.length) return;
    await this.runner.do(`${b}:tell`, async () => {
      await this.tell(a.deadline?.tell, {
        nodeId: b,
        inboxItemId: item,
        reason: `no answer from ${a.who ?? "the approver"} within ${a.deadline?.after}`,
      });
      return null;
    });
  }

  /** The approval's `ifNoAnswer` once nobody has answered (an escalation asked first). */
  async noAnswer(
    base: string,
    check: processes.ApprovalCheck,
    ask: Asker | null,
  ): Promise<Decided> {
    const notApproved: InboxResolution = { approved: false, by: null };
    const end = await this.escalate(base, check.ifNoAnswer ?? "stop", ask);
    if ("resolution" in end) return { resolution: end.resolution };
    // DECISION: `stop` on a write's approval is what a timeout always was: not approved, so the
    // step's `onReject` applies (a converted step behaves exactly as before). A sign-off that
    // nobody answered ends the run as a timeout (`signOff`).
    if (end.ended === "stop") return { resolution: notApproved, unanswered: true };
    if (end.ended === "skip") return { resolution: notApproved, skip: true };
    return { resolution: { approved: true, by: null, proceeded: true }, proceeded: true };
  }

  /**
   * Several items at once (`any`, `all`): wakes on whichever answers, reads them all from the
   * inbox (the truth) in a durable step each round, and decides. `any`: the first answer. `all`:
   * everyone approving, or the first reject. Null once every open item's deadline has passed.
   */
  // DECISION: one waiter per item for the whole asking, raced; each round's decision is read in
  // its own durable step, so a replay decides the same way whichever stored wait wakes it first.
  async awaitGroup(
    base: string,
    entries: { b: string; item: string; timeout: Duration }[],
    mode: "any" | "all",
  ): Promise<InboxResolution | null> {
    const { inbox } = this.ctx;
    const waits = new Map<number, Promise<{ k: number; timedOut: boolean }>>();
    const timedOut = new Set<number>();
    const tries = new Map<number, number>();
    for (let round = 0; ; round++) {
      const answers = (
        await this.runner.do(`${base}:round:${round}`, () =>
          Promise.all(entries.map((e) => inbox.resolution(e.item))),
        )
      ).map((r) => (r ? InboxResolution.parse(r) : null));
      const decided = decideGroup(answers, mode);
      if (decided) {
        await this.runner.do(`${base}:close`, async () => {
          for (const [k, e] of entries.entries()) {
            if (answers[k]) await inbox.received(e.item);
            else await inbox.expire(e.item);
          }
          return null;
        });
        return decided;
      }
      const open = entries.map((_, k) => k).filter((k) => !answers[k] && !timedOut.has(k));
      if (open.length === 0) {
        await this.runner.do(`${base}:close`, async () => {
          for (const [k, e] of entries.entries()) {
            if (answers[k]) await inbox.received(e.item);
            else await inbox.expire(e.item);
          }
          return null;
        });
        return null;
      }
      for (const k of open) {
        if (waits.has(k)) continue;
        const e = entries[k] as (typeof entries)[number];
        const n = tries.get(k) ?? 0;
        tries.set(k, n + 1);
        const p = this.runner
          .waitForEvent(n === 0 ? `${e.b}:wait` : `${e.b}:wait:${n}`, {
            type: inboxEventType(e.item),
            timeout: e.timeout,
          })
          .then(
            () => ({ k, timedOut: false }),
            (error: unknown) => {
              if (!isWaitTimeout(error)) throw error;
              return { k, timedOut: true };
            },
          );
        p.catch(() => {});
        waits.set(k, p);
      }
      const woke = await Promise.race([...waits.values()]);
      waits.delete(woke.k);
      if (woke.timedOut) timedOut.add(woke.k);
    }
  }

  /**
   * A step waiting on something outside the run (a reach-out's reply): check-before-wait, then the
   * event or the timeout, then the port says what came of it (its record is the truth).
   */
  async awaitStep(
    step: SkillStep | ActionStep,
    name: string,
    stepRunId: string,
    wait: StepWait,
    n: number,
    rejected: boolean,
    // v0.13 W2-I: an oversight retry's durable names and key node.
    at: string = name,
    keyNode?: string,
    // Review: an action's resolved channel, for the run again after the wait.
    binding?: { connector: string; connectionId: string },
  ): Promise<StepOutcome> {
    const { agent, run } = this.ctx;
    const { waitDone, afterWait } = agent;
    if (!waitDone || !afterWait) {
      throw new Error(`step ${step.id} waits, but the agent port can't wait`);
    }
    const base = `${at}:wait:${n}`;
    const request = {
      run,
      step,
      nodeId: name,
      stepRunId,
      wait,
      ...(keyNode ? { keyNode } : {}),
      ...(binding ? { binding } : {}),
    };
    const done = await this.runner.do(`${base}:check`, () => waitDone.call(agent, request));
    let timedOut = false;
    if (!done) {
      try {
        await this.runner.waitForEvent(`${base}:wait`, {
          type: wait.eventType,
          timeout: wait.timeout,
        });
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        timedOut = true;
      }
    }
    return this.runner.do(
      `${base}:resume`,
      async () => {
        const next = await afterWait.call(agent, { ...request, timedOut });
        return this.settle(step, stepRunId, next, rejected);
      },
      this.ctx.stepConfig,
    );
  }

  /**
   * Check-before-wait (docs/plan.md §1.2 "Waiting on inbox items"): the item may have been
   * resolved before the wait began, and its event would then never arrive. Null on timeout, after
   * marking the item expired.
   */
  async awaitResolution(
    base: string,
    inboxItemId: string,
    timeout: Duration,
  ): Promise<InboxResolution | null> {
    // Recorded once the run holds the resolution, so the cron stops re-sending its event.
    const received = async (resolution: InboxResolution) => {
      await this.runner.do(`${base}:received`, async () => {
        await this.ctx.inbox.received(inboxItemId);
        return null;
      });
      return resolution;
    };
    const early = await this.runner.do(`${base}:check`, () =>
      this.ctx.inbox.resolution(inboxItemId),
    );
    if (early) return received(InboxResolution.parse(early));
    try {
      const event = await this.runner.waitForEvent(`${base}:wait`, {
        type: inboxEventType(inboxItemId),
        timeout,
      });
      return received(InboxResolution.parse(event.payload ?? {}));
    } catch (error) {
      if (!isWaitTimeout(error)) throw error;
      await this.runner.do(`${base}:expire`, async () => {
        await this.ctx.inbox.expire(inboxItemId);
        return null;
      });
      return null;
    }
  }

  // ── R3: confer, sign-off, notifications, help ─────────────────────────────────────────────────

  /**
   * Confer: each reviewer in order (a reviewer's `when` reads the verdicts before it), each its
   * own client-visible row (`${name}:confer:<n>`): "Checked by Dana: agree", "A second check:
   * agree" (never its model, prompt or cost). Advice only: the step's output is never changed.
   */
  async confer(
    step: WorkStep,
    name: string,
    base: RunContext,
    check: processes.ConferCheck,
    data: { input: unknown; output?: unknown; own?: { id: string; output: unknown } },
  ): Promise<ConferEntry[] | undefined> {
    const { run, log } = this.ctx;
    const scopeWith = (verdicts: ConferEntry[]) => checkScope(base, data.own, verdicts);
    if (check.when) {
      const applies = await this.runner.do(`${name}:confer:when`, async () =>
        evaluateRules(check.when as NonNullable<typeof check.when>, scopeWith([])),
      );
      if (!applies) return undefined;
    }
    const verdicts: ConferEntry[] = [];
    for (const [i, reviewer] of check.with.entries()) {
      const b = `${name}:confer:${i}`;
      if (reviewer.when) {
        const applies = await this.runner.do(`${b}:when`, async () =>
          evaluateRules(
            reviewer.when as NonNullable<typeof reviewer.when>,
            scopeWith([...verdicts]),
          ),
        );
        if (!applies) {
          verdicts.push(null);
          continue;
        }
      }
      if ("ai" in reviewer) {
        const entry = await this.runner.do(
          b,
          async () => {
            const id = await log.start({
              runId: run.id,
              nodeId: b,
              nodeType: "confer",
              input: { reviewer: "ai" },
            });
            // The focus is the reviewer's instruction: sent as written, never rendered with run
            // data (invariant 9). What its references stand for goes as data beside it.
            const focus = reviewer.ai.focus;
            const scope = scopeWith([...verdicts]);
            const refs = collectRefs(focus).refs;
            const references =
              refs.length > 0
                ? Object.fromEntries(refs.map((r) => [r.expr, resolvePath(scope, r.path)]))
                : undefined;
            const port = this.ctx.confer;
            // DECISION: without an AI reviewer wired, the verdict is `no_answer`: advice that never
            // came, which conditions can test; the step goes on (confer never blocks a step).
            const answer = port
              ? await port.ai({
                  run,
                  nodeId: b,
                  stepRunId: id,
                  stepId: step.id,
                  stepName: step.name,
                  focus,
                  ...(references ? { references } : {}),
                  ...(reviewer.ai.model ? { model: reviewer.ai.model } : {}),
                  ...(step.kind === "skill" && step.model ? { stepModel: step.model } : {}),
                  input: data.input,
                  ...(data.output !== undefined ? { output: data.output } : {}),
                })
              : { verdict: "no_answer" as const, note: "no reviewer was available" };
            const e = { verdict: answer.verdict, note: answer.note, by: "ai" };
            await log.update(id, {
              status: "succeeded",
              output: e,
              summary: `A second check: ${e.verdict.replace("_", " ")}`,
            });
            return e;
          },
          this.ctx.stepConfig,
        );
        verdicts.push(entry);
        continue;
      }
      verdicts.push(
        await this.conferPerson(
          step,
          b,
          reviewer,
          scopeWith([...verdicts]),
          data.output ?? data.input,
        ),
      );
    }
    return verdicts;
  }

  /** A person conferee: an ask with agree / disagree / not sure, on their deadline. */
  async conferPerson(
    step: WorkStep,
    b: string,
    reviewer: Extract<processes.Conferee, { person: string }>,
    scope: unknown,
    shown: unknown,
  ): Promise<ConferEntry> {
    const { run, log } = this.ctx;
    const who = reviewer.person;
    const label = clientLabel(asLabelled(step));
    const title = `Check: ${label}`;
    const started = await this.runner.do(b, async () => {
      const id = await log.start({
        runId: run.id,
        nodeId: b,
        nodeType: "confer",
        input: { reviewer: who },
      });
      // A person who is away is skipped at once.
      if (await this.isAway(who)) {
        const e = { verdict: "no_answer" as const, note: "away", by: who };
        await log.update(id, { status: "skipped", output: e, summary: `Checked by ${who}: away` });
        return { id, away: e };
      }
      await log.update(id, {
        status: "waiting",
        summary: `${title}: ${this.words.waitingForAnswer}`,
      });
      return { id, away: null };
    });
    if (started.away) return started.away;
    const payload =
      reviewer.show !== undefined ? resolveTemplate(reviewer.show, scope) : { value: shown };
    const ask = this.personAsker(started.id, {
      stepId: step.id,
      name: step.name,
      title,
      payload,
      choices: CONFER_CHOICES,
    });
    const asked = await ask(b, who, reviewer.deadline);
    let answer = await this.awaitResolution(b, asked.item, asked.timeout);
    let by = who;
    if (!answer) {
      if (reviewer.deadline.tell?.length) {
        await this.runner.do(`${b}:tell`, async () => {
          await this.tell(reviewer.deadline.tell, {
            nodeId: b,
            inboxItemId: asked.item,
            reason: `no answer from ${who} to "${title}" within ${reviewer.deadline.after}`,
          });
          return null;
        });
      }
      const end = await this.escalate(b, thenOf(reviewer.deadline), ask);
      if ("resolution" in end) {
        answer = end.resolution;
        by = end.resolution.by ?? who;
      } else if (end.ended === "stop") {
        await this.runner.do(`${b}:done`, async () => {
          await log.update(started.id, {
            status: "failed",
            output: { verdict: "no_answer", note: "", by: who },
            summary: `${title}: ${this.words.noAnswerInTime}`,
          });
          return null;
        });
        throw new RunEnd({ status: "failed", reason: "timeout", nodeId: b });
      }
    }
    const entry = answer ? verdictOf(answer, by) : { verdict: "no_answer" as const, note: "", by };
    await this.runner.do(`${b}:done`, async () => {
      await log.update(started.id, {
        status: answer ? "succeeded" : "skipped",
        output: entry,
        summary: `Checked by ${who}: ${entry.verdict.replace("_", " ")}`,
      });
      return null;
    });
    return entry;
  }

  /**
   * A native read's or skill's approval when it proposed no write: its result signed off before
   * the run goes on, on the approval engine (`approve`), people asked through the inbox. `go`, or
   * `skip` (turned down with `onReject: continue`, or nobody answered with `ifNoAnswer: skip`).
   * Turned down with `onReject: stop` cancels the run (`rejected`); nobody answering with
   * `ifNoAnswer: stop` fails it (`timeout`), as a person step that nobody answered does.
   */
  async signOff(
    step: WorkStep,
    name: string,
    stepRunId: string,
    plan: ApprovalPlan,
    output: unknown,
  ): Promise<{ go: boolean; why?: NotRun; approval: ApprovalRecord | null }> {
    const base = `${name}:signoff`;
    const label = clientLabel(asLabelled(step));
    const ask = this.personAsker(stepRunId, {
      stepId: step.id,
      name: step.name,
      title: label,
      payload: { value: output },
      mode: "approve",
    });
    const decided = await this.approve(base, plan, {
      ask,
      fallback: DEFAULT_APPROVAL_TIMEOUT,
      nameOf: (k) => `${base}:a${k}`,
    });
    // Wave 5: what a later step reads as `steps.<id>.approval`.
    const approval = approvalRecord(decided);
    if (decided.proceeded) return { go: true, approval };
    const { resolution } = decided;
    const answered = !decided.skip && !decided.unanswered;
    if (answered && (resolution.approved === true || resolution.withdrawn === true)) {
      return { go: true, approval };
    }
    await this.runner.do(`${base}:done`, async () => {
      await this.ctx.log.update(stepRunId, {
        status: decided.unanswered ? "failed" : "skipped",
        ...(decided.unanswered ? { error: "no answer to the sign-off in time" } : {}),
        summary: answered
          ? `${stepStateLabel(asLabelled(step), false)}: ${this.words.notApproved}`
          : `${label}: ${this.words.noAnswerInTime}`,
      });
      return null;
    });
    if (decided.unanswered) throw new RunEnd({ status: "failed", reason: "timeout", nodeId: name });
    if (decided.skip) return { go: false, why: "no_answer", approval };
    if (plan.check.onReject === "continue") return { go: false, why: "rejected", approval };
    throw new RunEnd({ status: "cancelled", reason: "rejected", nodeId: name });
  }

  /**
   * A v4 notification (a notify step's or a check's), to the client's team or ours. A test run
   * records it and sends nothing. An urgent one goes at once and needs a "Seen" within
   * `ackWithin`, else its `ifNoAnswer`.
   */
  async notice(
    n: processes.NotifyCheck,
    nodeName: string,
    scope: unknown,
    label: string,
    // Wave 5: a notify step with `onError: continue`: a send that fails is recorded as failed in
    // the durable step's result (so a replay doesn't send again) and the run goes on.
    continues = false,
  ): Promise<{ outcome: "sent" | "skipped" | "not_seen" | "failed"; error?: string }> {
    const { run, log, notify } = this.ctx;
    const sent: {
      sent: boolean;
      ack: string | null;
      urgent: string | null;
      skipped?: boolean;
      failed?: string;
    } = await this.runner.do(
      nodeName,
      async (attempt) => {
        if (n.when && !evaluateRules(n.when, scope)) {
          return { sent: false, ack: null, urgent: null, skipped: true };
        }
        const text = renderTemplate(n.message, scope);
        const sources = noticeSources(n.sources, scope);
        const channel = n.channel ?? "inbox";
        const id = await log.start({
          runId: run.id,
          nodeId: nodeName,
          nodeType: "notify",
          input: { channel, to: n.to, text, ...(sources.length ? { sources } : {}) },
        });
        if (this.testRun) {
          await log.update(id, {
            status: "succeeded",
            output: { sent: false },
            summary: this.words.wouldSend(label),
          });
          return { sent: false, ack: null, urgent: null };
        }
        try {
          const urgent = n.urgent && (!n.urgent.when || evaluateRules(n.urgent.when, scope));
          const urgentDue = urgent
            ? new Date(Date.now() + parseDuration(n.urgent?.ackWithin ?? "1 hour")).toISOString()
            : null;
          let ack: string | null = null;
          if (notify.notify) {
            const r = await notify.notify({
              run,
              nodeId: nodeName,
              to: [...n.to],
              channel,
              text,
              sources,
              ...(urgentDue ? { urgent: { dueAt: urgentDue } } : {}),
            });
            ack = r.ackItemId ?? null;
          } else {
            // DECISION: without the port's v4 notify, each recipient gets the v3 notice (an inbox
            // notice as a thread message, sms as one too); an urgent one isn't waited on.
            const v3: NotifyStep = {
              id: nodeName,
              name: label,
              kind: "notify",
              channel: channel === "email" ? "email" : "thread",
              message: n.message,
              ...(n.sources ? { sources: n.sources } : {}),
            };
            for (const to of n.to) {
              await notify.send({
                run,
                step: v3,
                nodeId: nodeName,
                channel: v3.channel,
                to,
                text,
                sources,
              });
            }
          }
          await log.update(id, { status: "succeeded", summary: `${label}: ${this.words.sent}` });
          return { sent: true, ack, urgent: urgentDue };
        } catch (error) {
          // DECISION (wave 5 review): the send is retried per `NOTICE_STEP_CONFIG`, like any durable
          // step; only its last try's failure is final. With `onError: continue` that one is the
          // step's stored result (never sent again on replay); an earlier one throws to be retried.
          // A runner that can't say which try it is (no `attempt`) has no retries to wait for.
          const last = !attempt || attempt.attempt > NOTICE_STEP_CONFIG.retries.limit;
          if (!continues || !last) throw error;
          await log.update(id, {
            status: "failed",
            error: message(error),
            summary: `${label}: ${this.words.failed}`,
          });
          return { sent: false, ack: null, urgent: null, failed: message(error) };
        }
      },
      NOTICE_STEP_CONFIG,
    );
    if (typeof sent.failed === "string") return { outcome: "failed", error: sent.failed };
    // A test run's notice reads as sent, so it takes the path the live run would.
    if (!sent.sent) return { outcome: sent.skipped || !this.testRun ? "skipped" : "sent" };
    if (!sent.ack || !n.urgent) return { outcome: "sent" };
    const seen = await this.awaitResolution(`${nodeName}:seen`, sent.ack, n.urgent.ackWithin);
    if (seen) return { outcome: "sent" };
    const then = n.urgent.ifNoAnswer ?? "stop";
    if (then === "proceed" || then === "skip") return { outcome: "not_seen" };
    if (then === "stop")
      throw new RunEnd({ status: "failed", reason: "not_seen", nodeId: nodeName });
    // Escalate: the same urgent notice to `to`, with its own time to say "Seen".
    return this.notice(
      {
        ...n,
        to: [then.escalate.to],
        urgent: {
          ackWithin: then.escalate.deadline.after,
          ifNoAnswer: thenOf(then.escalate.deadline),
        },
      },
      `${nodeName}:esc`,
      scope,
      label,
      continues,
    );
  }

  /**
   * R3: a native skill's output said it needs help (`needsHelp`): the lead is asked with what it
   * tried, the answer is kept (`memory.write`) and the step runs once more with `help` in its
   * input, as data. Still stuck after that, the step fails. A converted v3 skill's output is its
   * output, whatever it holds (it never asked before). A tool step's request may name the
   * operator (`to`) and say its answer isn't kept (`keep: false`): a recorded script's does.
   */
  // DECISION (wave 4 review): a script's fixed steps can't change with anyone's answer, so its
  // request for help goes to the operator (the `operator` role, as an escalation's `to` names it),
  // who records the script again and publishes it; once answered the step runs once more, on
  // whatever version is published then, and is failed if it still needs help. The answer is not
  // written to memory: it says what we did to the script, not how to do the work.
  // DECISION (wave 4 integration): the connector says so in the request (`to: "operator"`,
  // `keep: false`, its `scriptNeedsHelp`); the executor names no tool. Both are read only from a
  // tool step's output (code wrote it), never a skill's, whose output may come from a model.
  async needsHelp(
    view: SkillStep | ActionStep,
    name: string,
    frame: Frame,
    approval: Approval,
    done: { output: unknown; stepRunId: string; proposed: boolean },
    opts: WorkOptions,
  ): Promise<{ output: unknown; proposed: boolean; why?: NotRun; approvals?: ApprovalRecord[] }> {
    const need = needsHelpOf(done.output, true);
    if (!need) return { output: done.output, proposed: done.proposed };
    const { run, log, agent } = this.ctx;
    const label = clientLabel(view);
    // The answer goes into the input as one more field: an input that isn't an object can't hold it.
    const base = this.stepInput(view, frame, opts);
    if (!isPlainObject(base)) {
      throw new Error(
        "the skill needs help, but its input isn't an object the answer can be added to",
      );
    }
    const ask = this.personAsker(done.stepRunId, {
      stepId: view.id,
      name: view.name,
      title: need.question,
      payload: {
        tried: need.tried,
        ...(need.screenshots ? { screenshots: need.screenshots } : {}),
      },
    });
    const b = `${name}:help`;
    // What a tool step asks for: who answers, and whether the answer is kept as a note.
    const fromTool = "tool" in view;
    const toOperator = fromTool && need.to === "operator";
    const keep = !fromTool || need.keep !== false;
    await this.runner.do(`${b}:waiting`, async () => {
      await log.update(done.stepRunId, {
        status: "waiting",
        summary: `${stepStateLabel(view, false)}: ${this.words.waitingForAnswer}`,
      });
      return null;
    });
    const asked = await ask(b, toOperator ? "operator" : LEAD_ASSIGNEE, HELP_DEADLINE);
    const answer = await this.awaitResolution(b, asked.item, asked.timeout);
    if (!answer || answer.approved === false || answer.answer === undefined) {
      const error = toOperator
        ? "needs help: it needs our work first, and we didn't answer in time"
        : "needs help: no answer from the lead";
      await this.runner.do(`${b}:done`, async () => {
        await log.update(done.stepRunId, {
          status: "failed",
          error,
          summary: `${label}: ${this.words.noAnswerInTime}`,
        });
        return null;
      });
      // Wave 5: help nobody gave is the step's own failure (`needs_help`), gone on past with
      // `onError: continue`.
      throw new RunEnd(
        { status: "failed", reason: "needs_help", nodeId: name },
        { outcome: "needs_help", error },
      );
    }
    const help = answer.answer;
    // Kept for next time. A note that fails to save never fails the step, but its row says so.
    // An answer the request says not to keep (a script's: what we did to it) is not.
    if (keep) {
      await this.runner.do(`${b}:memory`, async () => {
        const text = typeof help === "string" ? help : JSON.stringify(help);
        // DECISION: a browsing skill's answer (one with `remember`) is kept by the port, as the
        // platform's own note in the browse scope, so the same skill on the same sites gets it back
        // and nothing the model writes reads as the lead's answer (invariant 9). Any other answer,
        // or a port without `keepHelp`, is an ordinary memory note.
        const note = `Asked "${need.question}", the lead answered: ${text}`.slice(0, 2000);
        let problem: string | null = null;
        try {
          if (need.remember && agent.keepHelp) {
            await agent.keepHelp({
              run,
              stepRunId: done.stepRunId,
              nodeId: `${b}:memory`,
              remember: need.remember,
              question: need.question,
              answer: text,
            });
            return null;
          }
          const kept = await agent.runAction({
            run,
            step: {
              id: view.id,
              name: view.name,
              kind: "action",
              tool: "memory.write",
              input: { note },
              approval: DEFAULT_APPROVAL,
            },
            nodeId: `${b}:memory`,
            stepRunId: done.stepRunId,
            input: { note },
            approval: DEFAULT_APPROVAL,
          });
          if (kept.kind === "failed") problem = kept.error;
          else if (kept.kind === "escalated") problem = kept.reason;
          else if (kept.kind !== "done") problem = "it wasn't written at once";
        } catch (error) {
          problem = message(error);
        }
        if (problem !== null) {
          await log.update(done.stepRunId, {
            status: "waiting",
            error: `the lead's answer wasn't kept: ${problem}`,
          });
        }
        return null;
      });
    }
    const input = { ...base, help };
    // DECISION: the re-run has its own durable name and its own idempotency keys (`${name}:h1`):
    // its input changed, so any write it proposes is decided afresh.
    const again = this.finishWork(
      name,
      approval,
      await this.attempt(
        view,
        name,
        frame,
        approval,
        { seq: 1, input, keyNode: `${name}:h1`, at: `${b}:run` },
        opts,
      ),
    );
    if (!again.ran) {
      return {
        output: again.output,
        proposed: done.proposed,
        why: again.why,
        ...(again.approvals ? { approvals: again.approvals } : {}),
      };
    }
    if (needsHelpOf(again.output, true))
      throw new Error("still needs help after the lead's answer");
    return {
      output: again.output,
      proposed: done.proposed || again.proposed,
      ...(again.approvals ? { approvals: again.approvals } : {}),
    };
  }

  // ── person steps ─────────────────────────────────────────────────────────────────────────────

  async person(step: processes.PersonStep, name: string, frame: Frame): Promise<void> {
    const { run, inbox, log } = this.ctx;
    const view = personView(step, this.origin(step));
    const deadline = step.deadline;
    const created = await this.runner.do(name, async () => {
      const title = renderTemplate(step.title, frame.scope);
      const payload = resolveTemplate(step.payload, frame.scope);
      const stepRunId = await log.start({
        runId: run.id,
        nodeId: name,
        nodeType: "person",
        input: { title, payload },
      });
      // Inside the `do`, so a replay keeps the first due date. R3: on the assignee's hours.
      const { dueAt, remindAt } = await this.dueOf(step.assignee, deadline);
      const item = await inbox.createForPerson({
        run,
        step: view,
        nodeId: name,
        stepRunId,
        kind: step.mode === "approve" ? "approval" : "request",
        title,
        payload,
        dueAt,
        ...(remindAt.length > 0 ? { remindAt } : {}),
      });
      await log.update(stepRunId, {
        status: "waiting",
        summary: `${clientLabel(view)}: ${step.mode === "approve" ? this.words.waitingForApproval : this.words.waitingForAnswer}`,
      });
      return { stepRunId, inboxItemId: item.id, dueAt };
    });

    let resolution = await this.awaitResolution(
      name,
      created.inboxItemId,
      timeoutOf(deadline, created.dueAt),
    );
    const label = clientLabel(view);
    const reason = `no answer to "${label}" within ${deadline.after}`;
    let told = false;
    if (!resolution && typeof deadline.ifNoAnswer === "object") {
      // R3: escalate, after telling whoever the deadline tells.
      await this.runner.do(`${name}:tell`, async () => {
        await this.tell(deadline.tell, {
          nodeId: name,
          inboxItemId: created.inboxItemId,
          reason,
        });
        return null;
      });
      told = true;
      const ask = this.personAsker(created.stepRunId, {
        stepId: step.id,
        name: step.name,
        title: renderTemplate(step.title, frame.scope),
        payload: resolveTemplate(step.payload, frame.scope),
        mode: step.mode,
        ...(step.choices ? { choices: step.choices } : {}),
      });
      const end = await this.escalate(name, deadline.ifNoAnswer, ask);
      if ("resolution" in end) resolution = end.resolution;
      else return this.personNoAnswer(step, name, frame, created, end.ended, reason, told);
    }
    if (!resolution) {
      const then = thenOf(deadline);
      return this.personNoAnswer(
        step,
        name,
        frame,
        created,
        typeof then === "object" ? "stop" : then,
        reason,
        told,
      );
    }

    // An answer to an `ask` counts as approved unless the resolver said otherwise.
    const approved =
      step.mode === "approve" ? resolution.approved === true : resolution.approved !== false;
    const output = { approved, answer: resolution.answer ?? null, by: resolution.by };
    const summary =
      step.mode === "approve"
        ? `${label}: ${approved ? this.words.approved : this.words.notApproved}`
        : `${label}: ${approved ? this.words.answered : this.words.declined}`;
    await this.runner.do(`${name}:done`, async () => {
      await log.update(created.stepRunId, { status: "succeeded", output, summary });
      return null;
    });
    if (step.mode === "approve" && !approved && step.onReject === "stop") {
      throw new RunEnd({ status: "cancelled", reason: "rejected", nodeId: name });
    }
    // Wave 5: answered, and the quick answer chosen (one of the step's own values) to route on.
    const choice =
      typeof output.answer === "string" && step.choices?.some((c) => c.value === output.answer)
        ? output.answer
        : undefined;
    this.record(frame, step, output, { outcome: "answered", ...(choice ? { choice } : {}) });
  }

  /**
   * Nobody answered a person step. `stop` fails the run (`timeout`), as a timeout always has;
   * `skip` goes on with the step skipped and its output saying nobody answered. `proceed` goes on
   * as §10.14's table says for a native v4 step, as if the answer were yes; a converted v3 step's
   * (v3's `continue`) as v3 did, `approved: false`.
   */
  // DECISION: `proceed` on a converted v3 person step goes on with `approved: false`, the step
  // skipped: nobody said yes, and its stored workflow's later `if` was written for that (v3's
  // `continue` did exactly this). On a native v4 step it reads as a yes (`approved: true`, `by`
  // null, `proceeded: true`, the row succeeded), as §10.14's table says. A person step writes
  // nothing itself: every write after it still has its own approval (invariant 8).
  async personNoAnswer(
    step: processes.PersonStep,
    name: string,
    frame: Frame,
    created: { stepRunId: string; inboxItemId: string },
    then: "stop" | "proceed" | "skip",
    reason: string,
    told: boolean,
  ): Promise<void> {
    const label = clientLabel(asLabelled(step));
    const yes = then === "proceed" && !this.origin(step);
    const output = yes
      ? { approved: true, answer: null, by: null, proceeded: true }
      : { approved: false, answer: null, by: null };
    await this.runner.do(`${name}:done`, async () => {
      await this.ctx.log.update(created.stepRunId, {
        status: then === "stop" ? "failed" : yes ? "succeeded" : "skipped",
        output,
        summary: `${label}: ${this.words.noAnswerInTime}`,
      });
      // DECISION: v3 `notify_operator` (now `tell: ['operator']`) tells the operator and then ends
      // the run like `stop`: it can't go on without the person, and the operator decides.
      if (!told) {
        await this.tell(step.deadline.tell, {
          nodeId: name,
          inboxItemId: created.inboxItemId,
          reason,
        });
      }
      return null;
    });
    if (then === "stop") throw new RunEnd({ status: "failed", reason: "timeout", nodeId: name });
    this.record(frame, step, output, { outcome: "no_answer" });
  }

  // ── R3: conversation steps ───────────────────────────────────────────────────────────────────

  /**
   * A conversation (R7's port): started in a durable step; while under way the run waits for its
   * event, its `wakeAt` or the step's deadline (on the hours of who it is with), whichever comes
   * first, then asks the port again with what woke it (its record is the truth). Its output is
   * what it found (`processes.ConversationOutput`). Nobody answering in time takes the deadline's
   * `ifNoAnswer`; a conversation turned down (a message not approved, a person ending it) takes
   * `checks.approval.onReject`.
   */
  async conversation(step: processes.ConversationStep, name: string, frame: Frame): Promise<void> {
    const port = this.ctx.conversation;
    if (!port) throw new Error("conversation steps need the conversation service");
    const { run, log } = this.ctx;
    const label = clientLabel(asLabelled(step));
    const waiting = async (stepRunId: string, result: ConversationResult) => {
      if (result.status !== "pending") return;
      const on = result.waitingOn ?? "reply";
      await log.update(stepRunId, {
        status: "waiting",
        summary: `${label}: ${
          on === "signature"
            ? this.words.waitingForApproval
            : on === "answer"
              ? this.words.waitingForAnswer
              : this.words.waitingForReply
        }`,
      });
    };
    const started = await this.runner.do(
      name,
      async () => {
        // Who it is with may be templated; the goal is fixed text, the model's instructions
        // (invariant 9; the validator refuses a templated one), so it goes as written.
        const resolved: processes.ConversationStep = {
          ...step,
          with: renderTemplate(step.with, frame.scope),
        };
        const stepRunId = await log.start({
          runId: run.id,
          nodeId: name,
          nodeType: "conversation",
          input: { with: resolved.with, goal: resolved.goal, channel: step.channel },
        });
        const { dueAt } = await this.dueOf(resolved.with, step.deadline);
        const request: ConversationRequest = {
          runId: run.id,
          stepId: name,
          step: resolved,
          tenantId: run.tenantId,
          agentVersionId: run.agentVersionId,
          mode: run.mode,
          stepRunId,
        };
        const result = await port.conversation(request);
        await waiting(stepRunId, result);
        return { stepRunId, dueAt, request, result };
      },
      this.ctx.stepConfig,
    );
    let result: ConversationResult = started.result;
    for (let n = 1; result.status === "pending"; n++) {
      // Check before waiting, as for an inbox item: it may have moved on while the run wasn't
      // listening (a replay after a restart reads the stored result above). A call without a
      // wake only reports where the conversation is; still pending, it is what the run waits on
      // (its event, its wake time) and what the step's row says it waits for.
      result = await this.runner.do(
        `${name}:check:${n}`,
        async () => {
          const now = await port.conversation(started.request);
          await waiting(started.stepRunId, now);
          return now;
        },
        this.ctx.stepConfig,
      );
      if (result.status !== "pending") break;
      const type =
        result.waitFor ??
        (result.conversationId ? conversationEventType(result.conversationId) : null);
      if (!type) throw new Error("the conversation has nothing to wait on");
      // The deadline, or the engine's own wake time if sooner (a reply's wait).
      const wakeAt = result.wakeAt ?? null;
      const deadlineFirst = wakeAt === null || Date.parse(started.dueAt) <= Date.parse(wakeAt);
      let wake: NonNullable<ConversationRequest["wake"]>;
      try {
        const event = await this.runner.waitForEvent(`${name}:wait:${n}`, {
          type,
          timeout: untilDue(deadlineFirst ? started.dueAt : (wakeAt as string)),
        });
        wake = event.payload === undefined ? {} : { payload: event.payload };
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        wake = deadlineFirst ? { deadlinePassed: true } : { timedOut: true };
      }
      result = await this.runner.do(
        `${name}:result:${n}`,
        async () => {
          const next = await port.conversation({ ...started.request, wake });
          await waiting(started.stepRunId, next);
          return next;
        },
        this.ctx.stepConfig,
      );
      // The deadline passed: whatever the port says, the step stops waiting.
      if (wake.deadlinePassed && result.status === "pending") {
        result = { ...result, status: "no_answer" };
      }
    }
    const output = {
      status: result.status,
      found: result.found,
      summary: result.summary,
      conversationId: result.conversationId,
      ...(result.sources?.length ? { sources: result.sources } : {}),
    };
    if (result.declined === true) {
      // A message wasn't approved, or a person ended it: the step's approval `onReject`.
      const onReject = step.checks?.approval?.onReject ?? "stop";
      await this.runner.do(`${name}:done`, async () => {
        await log.update(started.stepRunId, {
          status: "skipped",
          output,
          summary: `${label}: ${this.words.declined}`,
        });
        return null;
      });
      if (onReject === "stop") {
        throw new RunEnd({ status: "cancelled", reason: "rejected", nodeId: name });
      }
      this.record(frame, step, output, { outcome: "declined" });
      return;
    }
    if (result.status === "failed") {
      const error = result.summary || "the conversation failed";
      await this.runner.do(`${name}:done`, async () => {
        await log.update(started.stepRunId, {
          status: "failed",
          output,
          error,
          summary: `${stepStateLabel(asLabelled(step), false)}: ${this.words.failed}`,
        });
        return null;
      });
      // Wave 5: with `onError: continue` the run goes on with what it found and why it failed.
      if (this.continues(step)) {
        this.record(frame, step, output, {
          outcome: "failed",
          error: processes.plainError(error),
        });
        return;
      }
      throw new RunEnd({
        status: "failed",
        reason: result.summary || "conversation failed",
        nodeId: name,
      });
    }
    if (result.status === "no_answer") {
      const then = thenOf(step.deadline);
      let end: { resolution: InboxResolution } | { ended: "stop" | "proceed" | "skip" } =
        typeof then === "string" ? { ended: then } : { ended: "stop" };
      if (typeof then === "object") {
        const ask = this.personAsker(started.stepRunId, {
          stepId: step.id,
          name: step.name,
          title: label,
          payload: { with: started.request.step.with, found: result.found },
        });
        end = await this.escalate(name, then, ask);
      }
      const answered = "resolution" in end ? end.resolution : null;
      const final = answered ? { ...output, answer: answered.answer ?? null } : output;
      const ended = "ended" in end ? end.ended : null;
      await this.runner.do(`${name}:done`, async () => {
        await log.update(started.stepRunId, {
          // `proceed` goes on with what it found so far; `skip` skips the step.
          status:
            answered || ended === "proceed" ? "succeeded" : ended === "stop" ? "failed" : "skipped",
          output: final,
          summary: `${label}: ${answered ? this.words.answered : this.words.noAnswerInTime}`,
        });
        await this.tell(step.deadline.tell, {
          nodeId: name,
          inboxItemId: null,
          reason: `no answer to "${label}" within ${step.deadline.after}`,
        });
        return null;
      });
      if (ended === "stop") throw new RunEnd({ status: "failed", reason: "timeout", nodeId: name });
      // Wave 5: the contact didn't answer in time, whatever the escalation or `ifNoAnswer` did.
      this.record(frame, step, final, { outcome: "no_answer" });
      return;
    }
    await this.runner.do(`${name}:done`, async () => {
      await log.update(started.stepRunId, {
        status: "succeeded",
        output,
        summary: result.summary ? result.summary : `${label}: ${this.words.done}`,
      });
      return null;
    });
    this.record(frame, step, output, { outcome: result.status });
  }

  // ── logic ────────────────────────────────────────────────────────────────────────────────────

  async fork(step: processes.IfStep, name: string, frame: Frame): Promise<void> {
    const { run, log } = this.ctx;
    // The choice is made inside the `do`, so a replay takes the same path even if data or the
    // rules engine changed in between.
    const chosen = await this.runner.do(name, async () => {
      const stepRunId = await log.start({
        runId: run.id,
        nodeId: name,
        nodeType: storedKind(step, this.origin(step)) as never,
      });
      const index = step.paths.findIndex((p) => evaluateRules(p.when, frame.scope));
      const path = index >= 0 ? step.paths[index] : undefined;
      const output = path
        ? { pathId: path.id, pathName: path.name }
        : { pathId: step.otherwise.id, pathName: "Otherwise" };
      await log.update(stepRunId, {
        status: "succeeded",
        output,
        summary: `${clientLabel(asLabelled(step))}: ${path ? output.pathName : this.words.otherwise}`,
      });
      return { index, output };
    });
    const branch = chosen.index >= 0 ? step.paths[chosen.index]?.steps : step.otherwise.steps;
    if (!branch) throw new Error(`fork ${step.id} has no path ${chosen.index}`);
    // Outputs inside the branch are not visible after the join (ARCHITECTURE §10.2).
    await this.runList(branch, {
      prefix: frame.prefix,
      scope: { ...frame.scope, steps: { ...frame.scope.steps } },
      ...(frame.checks ? { checks: frame.checks } : {}),
    });
    this.record(frame, step, chosen.output);
  }

  async forEach(step: processes.ForEachStep, name: string, frame: Frame): Promise<void> {
    const { run, log } = this.ctx;
    const items = resolveTemplate(step.over, frame.scope);
    if (!Array.isArray(items)) {
      throw new Error(`for_each ${step.id}: "${step.over}" is not a list`);
    }
    const { stepRunId } = await this.runner.do(name, async () => {
      const id = await log.start({
        runId: run.id,
        nodeId: name,
        nodeType: "for_each",
        input: { count: items.length },
      });
      await log.update(id, { status: "running" });
      return { stepRunId: id };
    });

    let ended: RunEnd | undefined;
    // Wave 5: with `onError: continue`, an item whose steps failed (a failure they reported) doesn't
    // stop the others; it is counted. Anything else (a no, a stop, no answer) still ends the run.
    const continues = this.continues(step);
    const failedItems = new Set<number>();
    // Wave 6 review: the outermost loop gathers the owner's checks of every attempt inside it.
    const own: OwnerCheckEntry[] | undefined =
      this.ctx.ownerChecks && !frame.checks ? [] : undefined;
    const checks = frame.checks ?? own;
    try {
      await pool(items.length, step.concurrency ?? 10, async (i) => {
        try {
          await this.runList(step.steps, {
            prefix: `${name}:${i}:`,
            scope: {
              ...frame.scope,
              steps: { ...frame.scope.steps },
              item: items[i],
              index: i,
            },
            ...(checks ? { checks } : {}),
          });
        } catch (error) {
          if (!continues || !continuable(error)) throw error;
          failedItems.add(i);
        }
      });
    } catch (error) {
      if (!(error instanceof RunEnd)) {
        await this.writeChecks(name, own);
        throw error;
      }
      ended = error;
    }
    await this.writeChecks(name, own);

    const failed = failedItems.size;
    const output = failed > 0 ? { count: items.length, failed } : { count: items.length };
    await this.runner.do(`${name}:done`, async () => {
      await log.update(stepRunId, {
        status: ended?.result.status === "failed" ? "failed" : "succeeded",
        output,
        summary: `${clientLabel(asLabelled(step))}: ${this.words.items(items.length)}`,
      });
      return null;
    });
    if (ended) throw ended;
    // DECISION (wave 5): `all_failed` only when there were items and every one failed; a loop over
    // nothing is `done`.
    const outcome = failed === 0 ? "done" : failed === items.length ? "all_failed" : "some_failed";
    this.record(frame, step, output, { outcome, counts: { items: items.length, failed } });
  }

  async wait(step: processes.WaitStep, name: string, frame: Frame): Promise<void> {
    const { run, log } = this.ctx;
    const label = clientLabel(asLabelled(step));
    const { stepRunId } = await this.runner.do(name, async () => {
      const id = await log.start({ runId: run.id, nodeId: name, nodeType: "wait" });
      await log.update(id, {
        status: "waiting",
        summary: `${label}: ${this.words.waiting(step.for)}`,
      });
      return { stepRunId: id };
    });
    await this.runner.sleep(`${name}:sleep`, step.for);
    await this.runner.do(`${name}:done`, async () => {
      await log.update(stepRunId, {
        status: "succeeded",
        summary: `${label}: ${this.words.waited(step.for)}`,
      });
      return null;
    });
    // Wave 5: a wait for a duration ends when its time runs out.
    this.record(frame, step, null, { outcome: "timed_out" });
  }

  /** A notify step: a converted one exactly as v3 sent it; a v4 one through `notice`. */
  async notifyStep(step: processes.NotifyStep, name: string, frame: Frame): Promise<void> {
    const origin = this.origin(step);
    if (origin?.kind === "notify") return this.notifyV3(origin, name, frame);
    const ended = await this.notice(
      step.notify,
      name,
      frame.scope,
      step.name,
      this.continues(step),
    );
    // Wave 5: sent, skipped (its `when`), not seen in time (urgent, the run went on), or failed.
    this.record(frame, step, null, {
      outcome: ended.outcome,
      ...(ended.error ? { error: processes.plainError(ended.error) } : {}),
    });
  }

  async notifyV3(step: NotifyStep, name: string, frame: Frame): Promise<void> {
    const { run, log, notify } = this.ctx;
    await this.runner.do(name, async () => {
      const text = renderTemplate(step.message, frame.scope);
      const to = step.to === undefined ? null : renderTemplate(step.to, frame.scope);
      const sources = noticeSources(step.sources, frame.scope);
      const id = await log.start({
        runId: run.id,
        nodeId: name,
        nodeType: "notify",
        input: { channel: step.channel, to, text, ...(sources.length ? { sources } : {}) },
      });
      // DECISION: a test run's notice is not sent anywhere, not even as an operator-only thread
      // message in the client's data: its text stays on the step (the run log shows it), and the
      // timeline says it would have been sent (ARCHITECTURE §10.4: test runs never reach clients).
      if (this.testRun) {
        await log.update(id, {
          status: "succeeded",
          output: { sent: false },
          summary: this.words.wouldSend(step.name),
        });
        return null;
      }
      await notify.send({ run, step, nodeId: name, channel: step.channel, to, text, sources });
      await log.update(id, {
        status: "succeeded",
        summary: `${clientLabel(step)}: ${this.words.sent}`,
      });
      return null;
    });
  }

  // ── v0.12 W2-B: use steps (ARCHITECTURE §10.7; docs/plan.md §1.45); R3: `process` steps ──────

  /**
   * A process (use) step: its input resolved, then the automation's steps under `${name}/`,
   * reading only `{{input...}}` and each other; then its output from the automation's `output`.
   * Nothing after it sees an inner step. Its own row (`skill_ref` `automation:<slug>@<version>`)
   * takes its status from its children.
   */
  async useAutomation(step: processes.SubProcessStep, name: string, frame: Frame): Promise<void> {
    const { run, log } = this.ctx;
    const expanded = this.expansions[step.id];
    if (!expanded) throw new Error(`automation ${step.process} was not expanded`);
    const started = await this.runner.do(name, async () => {
      const input = resolveTemplate(step.input, frame.scope);
      const id = await log.start({
        runId: run.id,
        nodeId: name,
        nodeType: storedKind(step, this.origin(step)) as never,
        skillRef: automationSkillRef(expanded.ref),
        input,
      });
      await log.update(id, { status: "running" });
      return { stepRunId: id, input };
    });
    // DECISION: inside, only `{{input...}}` and the automation's own steps: not the trigger, not
    // an enclosing loop's item, not the workflow's steps (ARCHITECTURE §10.7). A stop step inside
    // ends the run, as anywhere.
    const inner: Frame = {
      prefix: `${name}/`,
      scope: { trigger: undefined, input: started.input, steps: {} },
      automation: expanded.ref,
      ...(frame.checks ? { checks: frame.checks } : {}),
    };
    let ended: RunEnd | undefined;
    try {
      await this.runList(expanded.steps, inner);
    } catch (error) {
      if (!(error instanceof RunEnd)) throw error;
      ended = error;
    }
    // Wave 5: with `onError: continue`, a stop step inside ends the sub-process alone (`stopped`)
    // and a failure a step inside reported is the process step's (`failed`); a no, nobody
    // answering with `stop`, or an exception still ends the run.
    // DECISION (wave 5): without `onError: continue` a stop inside ends the whole run, as always.
    const goesOn =
      ended !== undefined &&
      this.continues(step) &&
      (ended.result.reason === "stop" || continuable(ended));
    const output = ended ? null : resolveTemplate(expanded.output, inner.scope);
    const label = clientLabel(asLabelled(step));
    await this.runner.do(`${name}:done`, async () => {
      const status = ended?.result.status;
      await log.update(started.stepRunId, {
        // DECISION: a use step's row has no `cancelled` status: one its steps cancelled (a
        // rejected write, a stop) is `skipped`, like a write a person turned down.
        // Wave 5: one gone on past says how it ended: a stop inside `skipped` (stopped), a failure
        // `failed`, whatever the stop's own status.
        status:
          goesOn && ended?.result.reason === "stop"
            ? "skipped"
            : status === "failed"
              ? "failed"
              : status === "cancelled"
                ? "skipped"
                : "succeeded",
        // Fix 3: a stop gone on past keeps how it would have ended the run on the process's own
        // row (`{ stopStatus }`), which a retry copies whole, so a retry of a retry reads it too.
        ...(ended
          ? goesOn && ended.result.reason === "stop"
            ? { output: { stopStatus: ended.result.status } }
            : {}
          : { output }),
        // Wave 5 review: a failure gone on past keeps its error on the row, where a retry that
        // reuses the step reads it back (`steps.<id>.error`).
        ...(goesOn && ended?.result.reason !== "stop" ? { error: carriedError(ended) } : {}),
        summary: `${label}: ${
          status === undefined
            ? this.words.done
            : status === "failed"
              ? this.words.failed
              : this.words.stopped[status]
        }`,
      });
      return null;
    });
    if (ended && !goesOn) throw ended;
    if (ended) {
      const stopped = ended.result.reason === "stop";
      // Wave 5 review: a stop inside keeps how it would have ended the run (`stopStatus`), so a
      // route that ends the run after it ends it the same way.
      this.record(frame, step, null, {
        outcome: stopped ? "stopped" : "failed",
        ...(stopped
          ? { stopStatus: ended.result.status }
          : { error: processes.plainError(carriedError(ended)) }),
      });
      return;
    }
    this.record(frame, step, output, { outcome: "completed" });
  }

  // ── v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54) ──────────────────────

  /**
   * Whether a failure of this step goes to the run's own agent (its owner, R6): the native v4
   * step it runs for when there is one, else the port view (a converted step's stored v3 step).
   */
  oversees(step: SkillStep | ActionStep, opts: WorkOptions = {}): boolean {
    return ownerReviewsFailureOf(this.ctx.oversight, opts.watched ?? step);
  }

  /**
   * v0.13 M32: whether an attempt that succeeded is reviewed before the run goes on: done (not a
   * write a person turned down), and a checkpoint under `checkpoints`, any step under `all`, or a
   * step with `review: 'always'`. R6: or (v4, with the owner's watch) a signal that its result is
   * plainly off, which rides on the review.
   */
  afterSuccess(
    step: SkillStep | ActionStep,
    name: string,
    attempt: Attempt | { thrown: unknown },
    opts: WorkOptions,
  ): AfterSuccess {
    if ("thrown" in attempt || attempt.outcome.kind !== "done" || attempt.rejected) {
      return { review: false, signals: [], found: [] };
    }
    const verdicts = verdictsOf(opts.verdicts?.());
    return ownerAfterSuccess(this.ctx.oversight, opts.watched ?? step, {
      name,
      checkpoint: this.checkpoints.has(checkpointKey(name, step.id)),
      output: attempt.outcome.output,
      ...(verdicts.length > 0 ? { confer: verdicts } : {}),
    });
  }

  /**
   * Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the owner's check on one attempt at a native
   * v4 step, recorded in a durable step of its own (`${name}:owner:${attempt}`), so a replay reuses
   * it; the port keeps one row per run, node and attempt besides. A converted v3 step records
   * nothing, so a v3 run keeps exactly the durable steps it had.
   */
  // DECISION (wave 6): only native v4 steps (`opts.watched`) record a check; a converted v3 step,
  // which has no cheap watch, records none, so a v3 run keeps exactly the durable steps it had.
  // DECISION (wave 6): a check that can't be written never fails the step or the run: the step's
  // own result stands and the run view shows no check for that attempt.
  // DECISION (wave 6 review): inside a for each the check is kept on the loop's frame and the
  // outermost loop writes all of them in one durable step (`${loop}:owner`) when it ends, finished
  // or not; so a v4 run with a loop of n items adds one durable step for the loop, not n.
  async recordCheck(
    name: string,
    opts: WorkOptions,
    entry: Omit<OwnerCheckEntry, "runId" | "nodeId">,
    frame?: Frame,
  ): Promise<void> {
    const log = this.ctx.ownerChecks;
    if (!log || !opts.watched) return;
    if (frame?.checks) {
      frame.checks.push({ runId: this.ctx.run.id, nodeId: name, ...entry });
      return;
    }
    try {
      await this.runner.do(
        `${name}:owner:${entry.attempt}`,
        async () => {
          await log.record({ runId: this.ctx.run.id, nodeId: name, ...entry });
          return null;
        },
        this.ctx.stepConfig,
      );
    } catch (error) {
      if (error instanceof RunEnd) throw error;
    }
  }

  /** A loop's owner checks, in one durable step (`${name}:owner`); none: no step. */
  async writeChecks(name: string, batch: readonly OwnerCheckEntry[] | undefined): Promise<void> {
    const log = this.ctx.ownerChecks;
    if (!log || !batch || batch.length === 0) return;
    const entries = [...batch];
    try {
      await this.runner.do(
        `${name}:owner`,
        async () => {
          if (log.recordMany) await log.recordMany(entries);
          else for (const e of entries) await log.record(e);
          return null;
        },
        this.ctx.stepConfig,
      );
    } catch (error) {
      if (error instanceof RunEnd) throw error;
    }
  }

  /**
   * Wave 6 review: the check on an attempt the run ended in the middle of (a person's no, or
   * nobody answering, `ended_by_person`): the owner never looked, and the line says why.
   */
  async recordEnded(
    name: string,
    opts: WorkOptions,
    frame: Frame,
    attempt: number,
    end: RunEnd,
  ): Promise<void> {
    const attemptOutcome = endedOutcome(end);
    await this.recordCheck(
      name,
      opts,
      {
        attempt,
        result: attemptOutcome === "failed" ? "flagged" : "clean",
        attemptOutcome,
        signals: [],
        reason: "ended_by_person",
      },
      frame,
    );
  }

  /** The first attempt and its thrown error, if any: a review never hides the step's own error. */
  async tryAttempt(
    step: SkillStep | ActionStep,
    name: string,
    frame: Frame,
    approval: Approval,
    retry: AttemptRetry | undefined,
    opts: WorkOptions,
  ): Promise<Attempt | { thrown: unknown }> {
    try {
      return await this.attempt(step, name, frame, approval, retry, opts);
    } catch (error) {
      if (error instanceof RunEnd) {
        // Wave 6 review: the run ended during the attempt; its check is recorded all the same.
        await this.recordEnded(name, opts, frame, retry ? retry.seq + 1 : 1, error);
        throw error;
      }
      return { thrown: error };
    }
  }

  /**
   * The step under oversight: while an attempt fails (its outcome `failed`, or an error thrown),
   * the agent reviews it (`${name}:oversee:${seq}`, a durable step) and the executor applies the
   * verdict: run it again (`${name}:retry:${seq}`) as it was or with the corrected input, wait for
   * a person's answer first, or stop. Past 2 reviews for the step or `maxPerRun` for the run, or on
   * a verdict of `none`, the last attempt stands and the step fails exactly as without oversight.
   */
  async overseen(
    step: SkillStep | ActionStep,
    name: string,
    frame: Frame,
    approval: Approval,
    opts: WorkOptions = {},
  ): Promise<
    | { kind: "attempt"; attempt: Attempt; diagnosis?: string }
    | { kind: "thrown"; error: unknown; diagnosis?: string }
    | { kind: "skipped" }
    // v0.13 M32: a checkpoint the agent (or the person it asked) stopped.
    | { kind: "cancelled"; reason: string; diagnosis?: string }
  > {
    const oversight = this.ctx.oversight;
    if (!oversight) throw new Error("unreachable");
    const { run, log } = this.ctx;
    const maxPerRun = oversight.settings?.maxPerRun ?? OVERSIGHT_DEFAULT_MAX_PER_RUN;
    // R6: the owner reviews the native v4 step; a converted step as its stored v3 step, as before.
    const watched = opts.watched ?? step;
    // As the owner is shown it: a native check's approvers who are away left out, so an ask goes
    // to the first approver present, as the step's own approval does.
    const reviewed = opts.watched && opts.plan ? presentFirst(opts.watched, opts.plan) : watched;
    const nodeType = opts.nodeType ?? step.kind;
    let current = await this.tryAttempt(step, name, frame, approval, undefined, opts);
    let input: unknown;
    let keyNode = name;
    let diagnosis: string | undefined;
    const result = () =>
      "thrown" in current
        ? { kind: "thrown" as const, error: current.thrown, ...withDiagnosis(diagnosis) }
        : { kind: "attempt" as const, attempt: current, ...withDiagnosis(diagnosis) };

    // A failed attempt is reviewed when the step's failures are; one that succeeded (v0.13 M32)
    // when it is a checkpoint under `checkpoints`, under `all`, or with `review: 'always'`; R6:
    // or when the owner's watch sees a signal (a v4 read's or skill's confer runs first, so a
    // "no" from it is one).
    for (let seq = 1; ; seq++) {
      const failing = failedAttempt(current);
      if (!failing && opts.afterRun && !("thrown" in current) && !current.rejected) {
        if (current.outcome.kind === "done") {
          try {
            await opts.afterRun(current.outcome.output);
          } catch (error) {
            // Wave 6 review: a confer nobody answered ended the run; the check says so.
            if (error instanceof RunEnd) await this.recordEnded(name, opts, frame, seq, error);
            throw error;
          }
        }
      }
      const after = failing ? null : this.afterSuccess(step, name, current, opts);
      // Wave 6: the owner's check on this attempt, recorded whatever came of it.
      const attemptOutcome = attemptOutcomeOf(current);
      const seen = after?.signals ?? [];
      // Wave 6 review: why a review was due on a step that succeeded (checkpoint, all, always).
      const due = after?.why;
      const cause = failing ? ("failed" as const) : ("checkpoint" as const);
      // DECISION (wave 6 review): a check is flagged only when the attempt failed (or escalated)
      // or the watch saw a signal. A clean step whose routine review (a checkpoint, `all`,
      // `always`) wasn't made stays clean, with why the review wasn't made and why it was due.
      const off =
        attemptOutcome === "failed" ||
        attemptOutcome === "escalated" ||
        (after?.found.length ?? 0) > 0;
      const flag = (reason: OwnerCheckReason) =>
        this.recordCheck(
          name,
          opts,
          {
            attempt: seq,
            result: off ? "flagged" : "clean",
            attemptOutcome,
            signals: seen,
            reason,
            cause,
            ...(due ? { reviewDue: due } : {}),
          },
          frame,
        );
      if (after && !after.review) {
        // Nothing off, or (an escalation, a signal on a step whose review is off) off and not
        // reviewed by the setting; a person's no or nobody answering, nothing for the owner.
        await this.recordCheck(
          name,
          opts,
          {
            attempt: seq,
            result: off ? "flagged" : "clean",
            attemptOutcome,
            signals: after.found,
          },
          frame,
        );
        break;
      }
      // DECISION: the executor counts interventions per step and per run (a replay counts the same
      // stored verdicts again); the port holds the cost limit, from the decisions' recorded cost.
      if (seq > OVERSIGHT_MAX_PER_STEP || this.interventions >= maxPerRun) {
        await flag("limit");
        break;
      }
      if (seq === 1) {
        try {
          input = this.stepInput(step, frame, opts);
        } catch {
          await flag("input_unresolved");
          break;
        }
      }
      const failed = current;
      const error = !failing
        ? ""
        : "thrown" in failed
          ? message(failed.thrown)
          : failed.outcome.kind === "failed"
            ? failed.outcome.error
            : "failed";
      const output =
        !("thrown" in failed) && failed.outcome.kind === "done" ? failed.outcome.output : undefined;
      let verdict: OversightVerdict;
      try {
        verdict = await this.runner.do(
          `${name}:oversee:${seq}`,
          async () => {
            // A step that threw may not have handed back its row: the upsert finds it (or makes it).
            const stepRunId =
              "thrown" in failed
                ? await log.start({
                    runId: run.id,
                    nodeId: name,
                    nodeType,
                    ...(step.kind === "skill" ? { skillRef: step.skill } : {}),
                  })
                : failed.stepRunId;
            return oversight.port.review({
              run,
              step: reviewed,
              nodeId: name,
              stepRunId,
              seq,
              cause,
              input,
              error,
              errorKey: failing ? ownerErrorKey(watched, error) : "",
              ...(failing ? {} : { output }),
              ...(after && after.signals.length > 0 ? { signals: after.signals } : {}),
              attempts: seq,
              ...(frame.automation ? { automation: frame.automation } : {}),
            });
          },
          this.ctx.stepConfig,
        );
      } catch {
        // A review that fails is no intervention: the step's own error (or output) stands.
        await flag("review_failed");
        break;
      }
      if (verdict.action === "none") {
        await flag("no_decision");
        break;
      }
      // Wave 6: recorded before the verdict is applied, so a run waiting on an ask shows it
      // (inside a loop, once the loop ends).
      await this.recordCheck(
        name,
        opts,
        {
          attempt: seq,
          result: "reviewed",
          attemptOutcome,
          signals: seen,
          cause,
          verdict: verdict.action,
          ...(due ? { reviewDue: due } : {}),
        },
        frame,
      );
      // DECISION: `continue` after a checkpoint changes nothing, so it is not an intervention: it
      // counts toward neither limit (docs/plan.md §1.54).
      if (verdict.action === "continue") break;
      this.interventions += 1;
      diagnosis = verdict.note;
      if (verdict.action === "stop") {
        // v0.13 M32: a stop at a checkpoint cancels the run before the write it feeds.
        if (!failing) return { kind: "cancelled", reason: "oversight_stop", diagnosis };
        break;
      }
      if (verdict.action === "ask") {
        // R6: an ask follows the step's approval (core `ownerStepApproval`): a v3 step's own, a v4
        // step's first approver's deadline and its `onReject`. A native check's first approver
        // present (the plan knows who is away) is asked, on their deadline in its own hours.
        const owned = ownerStepApproval(reviewed);
        const fallback = this.ctx.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;
        const askName = `${name}:oversee:${seq}:ask`;
        const present = opts.plan?.approvers.find((a) => !a.away);
        const timeout = present
          ? await this.firstTimeout(askName, present, fallback)
          : (owned.timeout ?? fallback);
        const answer = await this.awaitResolution(askName, verdict.inboxItemId, timeout);
        // v0.13 M32: approved at a checkpoint, the run goes on with the output as it is.
        if (answer?.approved === true && !failing) break;
        if (answer?.approved !== true) {
          // DECISION: a person who declines (or doesn't answer) is the step's `onReject`:
          // `continue` skips the step and the run goes on; `stop` fails it with its own error
          // (a failure) or cancels the run (a checkpoint, as a rejected write does).
          if (owned.onReject !== "continue") {
            if (!failing) return { kind: "cancelled", reason: "rejected", diagnosis };
            break;
          }
          await this.runner.do(`${name}:oversee:${seq}:skipped`, async () => {
            const stepRunId =
              "thrown" in failed
                ? await log.start({ runId: run.id, nodeId: name, nodeType })
                : failed.stepRunId;
            await log.update(stepRunId, {
              status: "skipped",
              summary: `${stepStateLabel(step, false)}: ${this.words.notApproved}`,
            });
            return null;
          });
          return { kind: "skipped" };
        }
      }
      if (verdict.action === "retry") {
        await this.runner.sleep(`${name}:retry:${seq}:sleep`, verdict.after);
      }
      if (verdict.action === "retry_with") {
        input = verdict.input;
        // A new input is a new change: its own idempotency keys, so the gate decides it afresh
        // and an approval given for the old input never carries (ARCHITECTURE §10.11).
        keyNode = `${name}:o${seq}`;
      }
      current = await this.tryAttempt(step, name, frame, approval, { seq, input, keyNode }, opts);
    }
    return result();
  }

  async stop(step: processes.StopStep, name: string): Promise<void> {
    const { run, log } = this.ctx;
    await this.runner.do(name, async () => {
      const id = await log.start({ runId: run.id, nodeId: name, nodeType: "stop" });
      await log.update(id, {
        status: "succeeded",
        // Wave 5 review: how it ends the run, which a retry reads back as a stopped process's
        // `stopStatus` (core's `recordOfStoredStep`).
        output: { status: step.status },
        summary: `${clientLabel(asLabelled(step))}: ${this.words.stopped[step.status]}`,
      });
      return null;
    });
    throw new RunEnd({ status: step.status, reason: "stop", nodeId: name });
  }
}

/** What a step's checks read: the run, the step's own output when it has one, the verdicts. */
function checkScope(
  base: RunContext,
  own: { id: string; output: unknown } | undefined,
  confer: ConferEntry[] | undefined,
): RunContext & { confer?: ConferEntry[] } {
  return {
    ...base,
    steps: own ? { ...base.steps, [own.id]: { output: own.output } } : base.steps,
    ...(confer ? { confer } : {}),
  };
}

/**
 * Whether an approval's `when` applies, on the safe side: a rule that reads something the run
 * doesn't have yet (a step that hasn't run, verdicts before the confer, a field the data lacks)
 * can't say the approval is off, so the approval applies. Only a `when` whose every reference
 * resolves is evaluated. An `exists` rule's own field may be absent (that is its answer), so only
 * what it reads from (the trigger, the step, the verdicts) must be there.
 */
// DECISION: an unresolved reference in an approval's `when` means "approval required", never a
// value of null compared (`null < 100` is true), so a missing value can't switch an approval off
// (invariant 8).
function approvalApplies(rules: Rules, scope: unknown): boolean {
  const resolves = (ref: string, leaf: boolean): boolean => {
    const path = singleRef(ref);
    if (!path) return true;
    const source = path[0] === "steps" ? path.slice(0, 2) : path.slice(0, 1);
    const value = resolvePath(scope, leaf ? path : source);
    // DECISION: a compared value that is null or empty counts as unresolved too, so the approval
    // applies: `null < 100` is true in JavaScript and must never switch an approval off.
    return leaf ? value !== undefined && value !== null && value !== "" : value !== undefined;
  };
  for (const rule of rules.rules) {
    if (!resolves(rule.field, rule.op !== "exists")) return true;
    if (typeof rule.value === "string" && rule.value.startsWith("{{")) {
      if (!resolves(rule.value, true)) return true;
    }
  }
  return evaluateRules(rules, scope);
}

/**
 * A native step as the owner reviews it: its approval's approvers who are away left out (when
 * someone is present), so the owner's ask (`ownerStepApproval`, by the first approver) goes to the
 * first approver present.
 */
function presentFirst(step: OwnerWatchedStep, plan: ApprovalPlan): OwnerWatchedStep {
  const check = "checks" in step ? step.checks?.approval : undefined;
  if (!check?.approvers || !("checks" in step)) return step;
  const present = plan.approvers.filter((a) => !a.away).map(({ away: _, ...a }) => a);
  if (present.length === 0 || present.length === check.approvers.length) return step;
  return { ...step, checks: { ...step.checks, approval: { ...check, approvers: present } } };
}

/** A person conferee's answer as a verdict: one of the quick answers, else `unsure`. */
function verdictOf(answer: InboxResolution, by: string): NonNullable<ConferEntry> {
  const a = answer.answer;
  const value = isPlainObject(a) ? a.verdict : a;
  const note = isPlainObject(a) && typeof a.note === "string" ? a.note : "";
  const verdict =
    value === "agree" || value === "disagree" || value === "unsure" ? value : "unsure";
  return { verdict, note, by: answer.by ?? by };
}

/** `any`: the first answer. `all`: the first reject, or everyone approving. Null: still open. */
function decideGroup(
  answers: readonly (InboxResolution | null)[],
  mode: "any" | "all",
): InboxResolution | null {
  const given = answers.filter((a): a is InboxResolution => a !== null && a.withdrawn !== true);
  if (mode === "any") return given[0] ?? null;
  const reject = given.find((a) => a.approved !== true);
  if (reject) return reject;
  if (given.length === answers.length && given.length > 0) {
    return { approved: true, answer: null, by: given[given.length - 1]?.by ?? null };
  }
  return null;
}

/**
 * A skill step's output with only the fields of its customized output schema
 * (`processes.customizeSkill`'s definition: the `keep` fields, and an alert skill's `sources`).
 */
function keptFields(output: unknown, schema: Record<string, unknown>): unknown {
  if (!isPlainObject(output) || !isPlainObject(schema.properties)) return output;
  const props = schema.properties;
  return Object.fromEntries(Object.entries(output).filter(([k]) => Object.hasOwn(props, k)));
}

/** A native skill's request for help in its output (`needsHelp`), else null. */
function needsHelpOf(output: unknown, native: boolean): NeedsHelp | null {
  if (!native || !isPlainObject(output)) return null;
  const need = NeedsHelp.safeParse(output.needsHelp);
  return need.success ? need.data : null;
}

/**
 * Where a retry of a run that failed at `nodeId` resumes (docs/plan.md §1.40): the top-level step
 * that is, or holds, the failed one. Only top-level steps are resumable, so a failure inside a fork
 * (`if`) path or a loop resumes at that fork or loop. Null when no step matches (it failed before
 * any). R3: v3 workflows and v4 processes alike.
 */
export function resumePoint(
  workflow: Pick<Workflow, "steps"> | Pick<processes.Process, "steps">,
  nodeId: string | null,
): string | null {
  if (!nodeId) return null;
  // A durable name is the step id, `${loop}:${i}:${child}` in a loop, or a suffix after `:`;
  // v0.12 W2-B: inside a use step, `${use}/${inner}` (the use step is what resumes).
  const id = nodeId.split(/[:/]/)[0] ?? nodeId;
  const holds = (step: V3Step | processes.Step): boolean => {
    if (step.id === id) return true;
    if (step.kind === "fork" || step.kind === "if") {
      const inner: (V3Step | processes.Step)[] = [
        ...step.paths.flatMap((p: { steps: (V3Step | processes.Step)[] }) => p.steps),
        ...step.otherwise.steps,
      ];
      return inner.some(holds);
    }
    return step.kind === "for_each" && (step.steps as (V3Step | processes.Step)[]).some(holds);
  };
  const steps = workflow.steps as (V3Step | processes.Step)[];
  return steps.find(holds)?.id ?? null;
}

/**
 * A notify step's sources as record ids: each entry resolved, lists flattened, anything that isn't
 * a non-empty string dropped, duplicates removed, in order.
 */
export function noticeSources(entries: readonly string[] | undefined, scope: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) add(x);
    else if (typeof v === "string" && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  };
  for (const e of entries ?? []) add(resolveTemplate(e, scope));
  return out;
}

/**
 * Runs `fn(0..count-1)` with at most `limit` at once. After the first failure it starts no new
 * items, lets the running ones finish, and rethrows that failure.
 */
export async function pool(
  count: number,
  limit: number,
  fn: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < count) {
      const i = next++;
      try {
        await fn(i);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, count)) }, worker));
  if (failure) throw failure.error;
}
