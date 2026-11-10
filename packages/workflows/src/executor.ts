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
  type OversightSettings,
  type PersonStep,
  parseDuration,
  processes,
  type RunContext,
  renderSummary,
  renderTemplate,
  resolveTemplate,
  // v0.13 M32
  reviewsAfterSuccess,
  reviewsFailures,
  runErrorKey,
  type SkillStep,
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
  type PendingApproval,
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
  /** Top-level step id → its row in the run retried (succeeded or skipped), output as stored. */
  reused: Record<string, { status: "succeeded" | "skipped"; output: unknown }>;
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

// v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54).
export interface ExecutorOversight {
  port: OversightPort;
  /** The agent's `definition.oversight`; absent means `off` (a step may still say `always`). */
  settings?: OversightSettings | undefined;
}

/** How one attempt at a skill or action step ended. */
interface Attempt {
  stepRunId: string;
  outcome: StepOutcome;
  rejected: boolean;
  // R3
  /** Nobody answered its approval and `ifNoAnswer` is `skip`: skipped whatever `onReject` says. */
  skipped?: boolean;
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
  /** The step's approval check and its approvers, who is away already known. */
  plan?: ApprovalPlan;
  /** A skill step's customization, for the runtime (instructions, rule rows). */
  customize?: processes.SkillCustomization;
  /** The step's row kind when not its port view's: a native `read` or `write`. */
  nodeType?: "read" | "write";
}

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
}

/** One confer reviewer's answer, as checks read it (`confer.<n>.verdict`); null: not asked. */
type ConferEntry = { verdict: processes.ConferVerdict; note: string; by: string } | null;

/** Asks one more person (an approver, an escalation): creates the item, says how long to wait. */
type Asker = (
  base: string,
  who: string,
  deadline: processes.Deadline | undefined,
) => Promise<{ item: string; timeout: Duration }>;

function failedAttempt(a: Attempt | { thrown: unknown }): boolean {
  return "thrown" in a || a.outcome.kind === "failed";
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

/** A person conferee's quick answers. */
const CONFER_CHOICES: NonNullable<PersonStep["choices"]> = [
  { value: "agree", label: "Agree" },
  { value: "disagree", label: "Disagree" },
  { value: "unsure", label: "Not sure" },
];

class RunEnd extends Error {
  constructor(readonly result: RunResult) {
    super(`run ended: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  }
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
  try {
    expansions = expandProcesses(
      loaded.process,
      ctx.automations ?? {},
      ctx.lookup ?? NO_LOOKUP,
      loaded.origins,
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
  const ex = new Executor(runner, ctx, expansions, loaded.origins);
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
 * `workflowCheckpoints`); a v4 process's by the same rule over v4 steps.
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
  const out = processCheckpoints(loaded.process.steps, typing);
  for (const [useId, e] of Object.entries(expansions)) {
    for (const id of processCheckpoints(e.steps, typing)) out.add(`${useId}/${id}`);
  }
  return out;
}

/**
 * The checkpoints of v4 steps (R3), v3's rule over v4 steps: every read, skill or write step whose
 * output a writing step's input references, and every one with `review: 'always'`.
 */
// DECISION: a step whose skill or tool the catalog doesn't know counts as not writing, as in v3.
function processCheckpoints(
  steps: readonly processes.Step[],
  typing: Parameters<typeof lookupSkill>[1],
): Set<string> {
  const all = processes.allSteps({ steps: [...steps] }).map((l) => l.step);
  const writes = (s: processes.Step): boolean => {
    if (s.kind === "skill" && lookupSkill(s.skill, typing)?.reachesPeople === true) return true;
    return (processes.stepWrites(s, typing)?.length ?? 0) > 0;
  };
  const fed = new Set<string>();
  for (const s of all) {
    if (s.kind !== "write" && s.kind !== "skill") continue;
    if (!writes(s)) continue;
    for (const r of collectRefs(s.input).refs) {
      const [root, id] = r.path;
      if (root === "steps" && id !== undefined) fed.add(id);
    }
  }
  const out = new Set<string>();
  for (const s of all) {
    if (s.kind !== "read" && s.kind !== "skill" && s.kind !== "write") continue;
    if (s.review === "always" || fed.has(s.id)) out.add(s.id);
  }
  return out;
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
  ) {}

  // v0.13 W2-I
  /** Oversight decisions taken in this run so far (each counts toward `maxPerRun`). */
  interventions = 0;
  /**
   * v0.13 M32: the workflow's checkpoints (`workflowCheckpoints`): a step by its id, an
   * automation's inner step as `${useStepId}/${innerId}`.
   */
  checkpoints: ReadonlySet<string> = new Set();

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
      await this.ctx.log.update(id, {
        status: row.status,
        output: row.output,
        summary: `reused from ${resume.of}`,
      });
      return null;
    });
    frame.scope.steps[step.id] = { output: row.output };
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
    const at = (d: Duration) =>
      (h.people && h.people.length > 0
        ? processes.dueAtForMany(start, d, { hours: "business", people: h.people })
        : processes.dueAt(start, d, {
            hours: "business",
            businessHours: processes.effectiveHours(h.client, h.person),
            away: h.person?.away,
          })
      ).toISOString();
    return { dueAt: at(deadline.after), remindAt: offsets.map(at) };
  }

  /** Whether `who` is away today (a role: everyone in it), on the stored hours. */
  async isAway(who: string): Promise<boolean> {
    if (!this.ctx.hours) return false;
    const h = await this.hoursOf(who);
    const now = new Date();
    if (h.people && h.people.length > 0) {
      return h.people.every((p) =>
        processes.isAway(now, { hours: p.businessHours, away: p.away }, h.client),
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
   * step's write, then notify. A write confers on its input before it is proposed; a read or a
   * skill runs first and confers on its output. Converted v3 steps carry only an approval, which
   * the gate takes exactly as before.
   */
  async workStep(step: WorkStep, name: string, frame: Frame): Promise<void> {
    const origin = this.origin(step);
    const checks = step.checks;
    const check = checks?.approval;
    let runs: WorkStep = step;
    let customize: processes.SkillCustomization | undefined;
    if (step.kind === "skill" && step.customize) {
      customize = step.customize;
      // Throws naming every problem: the step fails before it runs.
      const def = lookupSkill(step.skill, this.ctx.catalog ?? {});
      if (def) processes.applyCustomization(def, customize);
      // DECISION: settings layer as agent < step `settings` < the customization's; a step `model`
      // beats the customization's.
      const settings = customize.settings
        ? { ...(step.settings ?? {}), ...customize.settings }
        : step.settings;
      const model = step.model ?? customize.model;
      runs = { ...step, ...(settings ? { settings } : {}), ...(model ? { model } : {}) };
    }

    // Confer on a write's input, before it is proposed.
    let conferred: ConferEntry[] | undefined;
    if (step.kind === "write" && checks?.confer) {
      const input = resolveTemplate(step.input, frame.scope);
      conferred = await this.confer(step, name, frame.scope, checks.confer, { input });
    }

    const plan = check ? await this.approverPlan(name, check) : undefined;
    const firstWho = plan?.approvers.find((a) => !a.away)?.who ?? null;
    let gate = gateApproval(check, plan ? firstWho : undefined);
    // A native read or skill's approval is a sign-off of its result, after it runs (below); the
    // gate gets it too, for any write a skill proposes. Its `when` reads the step's own output.
    const signOff =
      !origin && (step.kind === "read" || step.kind === "skill") && plan ? plan : undefined;
    // An approval limited to some runs (`when`) doesn't apply on the others: the gate decides
    // those as `not_required` (still held to the matrix, the grant and the mode, §9.5).
    if (gate && check?.when && !signOff) {
      const applies = await this.runner.do(`${name}:approval:when`, async () =>
        evaluateRules(
          check.when as NonNullable<typeof check.when>,
          checkScope(frame.scope, undefined, conferred),
        ),
      );
      if (!applies) gate = { ...gate, required: "not_required" };
    }
    const view = workView(runs, origin, gate);
    const approval: Approval =
      view.kind === "action" ? view.approval : (view.approval ?? DEFAULT_APPROVAL);
    const done = await this.work(view, name, frame, approval, {
      ...(plan && !signOff ? { plan } : {}),
      ...(customize ? { customize } : {}),
      // A converted step's row keeps its stored kind; a native read or write is named as such.
      ...(!origin && step.kind !== "skill" ? { nodeType: step.kind } : {}),
    });
    if (!done.ran) {
      frame.scope.steps[step.id] = { output: done.output };
      return;
    }
    let output = done.output;

    // R3: a skill that couldn't do it asks the lead, then runs once more with the answer.
    if (view.kind === "skill") {
      output = await this.needsHelp(view, name, frame, approval, done, customize);
    }
    if (customize?.keep && view.kind === "skill") {
      output = kept(output, customize.keep, this.ctx.catalog, view);
    }

    if ((step.kind === "read" || step.kind === "skill") && checks?.confer) {
      const input = resolveTemplate(step.input, frame.scope);
      conferred = await this.confer(step, name, frame.scope, checks.confer, {
        input,
        output,
        own: { id: step.id, output },
      });
    }
    const signs =
      signOff &&
      gate?.required !== "not_required" &&
      (!check?.when ||
        (await this.runner.do(`${name}:signoff:when`, async () =>
          evaluateRules(
            check.when as NonNullable<typeof check.when>,
            checkScope(frame.scope, { id: step.id, output }, conferred),
          ),
        )));
    if (signOff && signs) {
      const decided = await this.signOff(step, name, done.stepRunId, signOff, output);
      if (decided === "stop") {
        throw new RunEnd({ status: "cancelled", reason: "rejected", nodeId: name });
      }
      if (decided === "skip") {
        frame.scope.steps[step.id] = { output: null };
        return;
      }
    }
    if (checks?.notify?.length) {
      const scope = checkScope(frame.scope, { id: step.id, output }, conferred);
      for (const [i, n] of checks.notify.entries()) {
        await this.notice(n, `${name}:notify:${i}`, scope, clientLabel(view));
      }
    }
    frame.scope.steps[step.id] = { output };
  }

  /**
   * The approval's approvers, who is away known before the step runs (a durable step, only when
   * stored hours can say so): an away approver is skipped at once, never waited for.
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
  ): Promise<
    { ran: true; output: unknown; stepRunId: string } | { ran: false; output: unknown | null }
  > {
    // v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54). Without a port, or when
    // this step's failures aren't reviewed, the first attempt is the only one, exactly as before.
    if (this.oversees(step)) {
      const done = await this.overseen(step, name, frame, approval, opts);
      if (done.kind === "thrown") {
        if (done.diagnosis === undefined) throw done.error;
        const reason = message(done.error);
        await this.recordFailure(step as unknown as processes.Step, name, reason);
        throw new RunEnd({
          status: "failed",
          reason,
          nodeId: name,
          errorKey: runErrorKey(
            { tool: step.kind === "action" ? step.tool : null, kind: step.kind },
            reason,
          ),
          diagnosis: done.diagnosis,
        });
      }
      if (done.kind === "skipped") return { ran: false, output: null };
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
    return this.finishWork(
      name,
      approval,
      await this.attempt(step, name, frame, approval, undefined, opts),
    );
  }

  /** How the step's last attempt ended decides the run (unchanged by oversight). */
  finishWork(
    name: string,
    approval: Approval,
    { outcome, rejected, skipped, stepRunId }: Attempt,
    diagnosis?: string,
  ): { ran: true; output: unknown; stepRunId: string } | { ran: false; output: unknown } {
    if (outcome.kind === "escalated") {
      throw new RunEnd({ status: "failed", reason: `escalated: ${outcome.reason}`, nodeId: name });
    }
    if (outcome.kind === "failed") {
      throw new RunEnd({
        status: "failed",
        reason: outcome.error,
        nodeId: name,
        // v0.13 W2-I: the last decision's note, for `run.failed` (operator side only).
        ...(diagnosis === undefined ? {} : { diagnosis }),
      });
    }
    if (outcome.kind !== "done") throw new Error("unreachable");
    if (rejected && approval.onReject === "stop" && !skipped) {
      // DECISION: a rejected write ends the run as `cancelled` (a person's decision, not a fault).
      throw new RunEnd({ status: "cancelled", reason: "rejected", nodeId: name });
    }
    if (rejected) return { ran: false, output: outcome.output };
    return { ran: true, output: outcome.output, stepRunId };
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
        const input = retry ? retry.input : resolveTemplate(step.input, frame.scope);
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
        const outcome =
          step.kind === "skill"
            ? await agent.runSkill({
                ...request,
                step,
                // R3: the runtime applies a v4 step's added instructions and rule rows.
                ...(opts.customize ? { customize: opts.customize } : {}),
              })
            : await agent.runAction({ ...request, step });
        return { stepRunId, outcome: await this.settle(step, stepRunId, outcome, false) };
      },
      this.ctx.stepConfig,
    );

    const { stepRunId } = first;
    let outcome = first.outcome;
    let rejected = false;
    let skipped = false;
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
        );
        continue;
      }
      const pending = outcome.pending;
      const base = `${at}:approval:${n}`;
      const decided = await this.decideApproval(step, base, stepRunId, pending, approval, opts);
      const resolution = decided.resolution;
      // P-6: a withdrawn item (a conversation taken over) is no decision: the port goes on (§1.68).
      if (resolution.approved !== true && resolution.withdrawn !== true) rejected = true;
      if (decided.skip) skipped = true;
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
    return { stepRunId, outcome, rejected, ...(skipped ? { skipped } : {}) };
  }

  /**
   * Who signs a write and what came of it. Without a v4 plan (a v3 caller), or with one approver
   * and `ifNoAnswer: stop` (every converted step), exactly as before: the gate's item, its
   * timeout, and no answer counts as not approved. Otherwise the plan's mode, each approver's
   * deadline, away approvers skipped, and `ifNoAnswer` at the end.
   */
  async decideApproval(
    step: SkillStep | ActionStep,
    base: string,
    stepRunId: string,
    pending: PendingApproval,
    approval: Approval,
    opts: WorkOptions,
  ): Promise<Decided> {
    const plan = opts.plan;
    const noAnswer: Decided = { resolution: { approved: false, by: null } };
    const fallback = approval.timeout ?? this.ctx.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;
    const present: PlannedApprover[] = plan
      ? plan.approvers.filter((a) => !a.away)
      : [{ away: false }];
    const first = present[0];
    if (!plan || !first) {
      if (plan && !first) {
        // Everyone is away: nobody is waited for, and the approval's `ifNoAnswer` applies.
        await this.runner.do(`${base}:expire`, async () => {
          await this.ctx.inbox.expire(pending.inboxItemId);
          return null;
        });
        return this.noAnswer(base, plan.check, null, noAnswer);
      }
      const resolution = await this.awaitResolution(base, pending.inboxItemId, fallback);
      return resolution ? { resolution } : noAnswer;
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
    // The gate asked the first approver; how long they have.
    const firstTimeout = async (): Promise<Duration> => {
      const d = first.deadline;
      if (!d) return fallback;
      if (d.hours !== "business") return d.after;
      const { dueAt } = await this.runner.do(`${base}:due`, () =>
        this.dueOf(first.who ?? "client_admin", d),
      );
      return untilDue(dueAt);
    };
    const tellPassed = async (b: string, a: PlannedApprover, item: string) => {
      if (!a.deadline?.tell?.length) return;
      await this.runner.do(`${b}:tell`, async () => {
        await this.tell(a.deadline?.tell, {
          nodeId: b,
          inboxItemId: item,
          reason: `no answer from ${a.who ?? "the approver"} within ${a.deadline?.after}`,
        });
        return null;
      });
    };

    const mode = plan.check.mode ?? "in_turn";
    if (mode === "in_turn" || present.length === 1 || !ask) {
      // One at a time, in order; the next once the one before's deadline passes.
      for (const [k, a] of present.entries()) {
        if (k > 0 && !ask) break;
        const b = k === 0 ? base : `${base}:a${k}`;
        const asked =
          k === 0 || !ask
            ? { item: pending.inboxItemId, timeout: await firstTimeout() }
            : await ask(b, a.who ?? "client_admin", a.deadline);
        const resolution = await this.awaitResolution(b, asked.item, asked.timeout);
        if (resolution) return { resolution };
        await tellPassed(b, a, asked.item);
      }
      return this.noAnswer(base, plan.check, ask, noAnswer);
    }

    // `any` and `all`: everyone at once.
    const entries: { b: string; item: string; timeout: Duration; a: PlannedApprover }[] = [];
    for (const [k, a] of present.entries()) {
      const b = k === 0 ? base : `${base}:a${k}`;
      const asked =
        k === 0
          ? { item: pending.inboxItemId, timeout: await firstTimeout() }
          : await ask(b, a.who ?? "client_admin", a.deadline);
      entries.push({ b, item: asked.item, timeout: asked.timeout, a });
    }
    const resolution = await this.awaitGroup(base, entries, mode);
    if (resolution) return { resolution };
    for (const e of entries) await tellPassed(e.b, e.a, e.item);
    return this.noAnswer(base, plan.check, ask, noAnswer);
  }

  /** The approval's `ifNoAnswer` once nobody has answered (an escalation asked first). */
  async noAnswer(
    base: string,
    check: processes.ApprovalCheck,
    ask: Asker | null,
    rejected: Decided,
  ): Promise<Decided> {
    const end = await this.escalate(base, check.ifNoAnswer ?? "stop", ask);
    if ("resolution" in end) return { resolution: end.resolution };
    // DECISION: `stop` on an approval is what a timeout always was: not approved, so the step's
    // `onReject` applies (a converted step behaves exactly as before).
    if (end.ended === "stop") return rejected;
    if (end.ended === "skip") return { ...rejected, skip: true };
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
            const focus = renderTemplate(reviewer.ai.focus, scopeWith([...verdicts]));
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
   * A native read or skill step's approval: its result signed off before the run goes on, by the
   * approvers in the check's mode (people asked through the inbox). `stop` turned down (or no
   * answer, `stop`), `skip`, or `go`.
   */
  async signOff(
    step: WorkStep,
    name: string,
    stepRunId: string,
    plan: ApprovalPlan,
    output: unknown,
  ): Promise<"go" | "stop" | "skip"> {
    const base = `${name}:signoff`;
    const label = clientLabel(asLabelled(step));
    const ask = this.personAsker(stepRunId, {
      stepId: step.id,
      name: step.name,
      title: label,
      payload: { value: output },
      mode: "approve",
    });
    const present = plan.approvers.filter((a) => !a.away);
    const asked: { b: string; item: string; timeout: Duration; a: PlannedApprover }[] = [];
    let resolution: InboxResolution | null = null;
    const mode = plan.check.mode ?? "in_turn";
    if (mode === "in_turn" || present.length <= 1) {
      for (const [k, a] of present.entries()) {
        const b = `${base}:a${k}`;
        const one = await ask(b, a.who ?? "client_admin", a.deadline);
        resolution = await this.awaitResolution(b, one.item, one.timeout);
        if (resolution) break;
      }
    } else {
      for (const [k, a] of present.entries()) {
        const b = `${base}:a${k}`;
        const one = await ask(b, a.who ?? "client_admin", a.deadline);
        asked.push({ b, item: one.item, timeout: one.timeout, a });
      }
      resolution = await this.awaitGroup(base, asked, mode);
    }
    if (!resolution) {
      const end = await this.escalate(base, plan.check.ifNoAnswer ?? "stop", ask);
      if ("resolution" in end) resolution = end.resolution;
      else if (end.ended === "proceed") return "go";
      else if (end.ended === "skip") return "skip";
      else return plan.check.onReject === "continue" ? "skip" : "stop";
    }
    if (resolution.approved === true || resolution.withdrawn === true) return "go";
    await this.runner.do(`${base}:done`, async () => {
      await this.ctx.log.update(stepRunId, {
        status: "skipped",
        summary: `${stepStateLabel(asLabelled(step), false)}: ${this.words.notApproved}`,
      });
      return null;
    });
    return plan.check.onReject === "continue" ? "skip" : "stop";
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
  ): Promise<void> {
    const { run, log, notify } = this.ctx;
    const sent = await this.runner.do(nodeName, async () => {
      if (n.when && !evaluateRules(n.when, scope)) return { sent: false, ack: null, urgent: null };
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
    });
    if (!sent.ack || !n.urgent) return;
    const seen = await this.awaitResolution(`${nodeName}:seen`, sent.ack, n.urgent.ackWithin);
    if (seen) return;
    const then = n.urgent.ifNoAnswer ?? "stop";
    if (then === "proceed" || then === "skip") return;
    if (then === "stop")
      throw new RunEnd({ status: "failed", reason: "not_seen", nodeId: nodeName });
    // Escalate: the same urgent notice to `to`, with its own time to say "Seen".
    await this.notice(
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
    );
  }

  /**
   * R3: a skill's output said it needs help (`needsHelp`): the lead is asked with what it tried,
   * the answer is kept (`memory.write`) and the step runs once more with `help` in its input, as
   * data. Still stuck after that, the step fails.
   */
  async needsHelp(
    view: SkillStep,
    name: string,
    frame: Frame,
    approval: Approval,
    done: { output: unknown; stepRunId: string },
    customize: processes.SkillCustomization | undefined,
  ): Promise<unknown> {
    const need = isPlainObject(done.output) ? NeedsHelp.safeParse(done.output.needsHelp) : null;
    if (!need?.success) return done.output;
    const { run, log, agent } = this.ctx;
    const label = clientLabel(view);
    const ask = this.personAsker(done.stepRunId, {
      stepId: view.id,
      name: view.name,
      title: need.data.question,
      payload: {
        tried: need.data.tried,
        ...(need.data.screenshots ? { screenshots: need.data.screenshots } : {}),
      },
    });
    const b = `${name}:help`;
    await this.runner.do(`${b}:waiting`, async () => {
      await log.update(done.stepRunId, {
        status: "waiting",
        summary: `${stepStateLabel(view, false)}: ${this.words.waitingForAnswer}`,
      });
      return null;
    });
    const asked = await ask(b, LEAD_ASSIGNEE, HELP_DEADLINE);
    const answer = await this.awaitResolution(b, asked.item, asked.timeout);
    if (!answer || answer.approved === false || answer.answer === undefined) {
      await this.runner.do(`${b}:done`, async () => {
        await log.update(done.stepRunId, {
          status: "failed",
          error: "needs help: no answer from the lead",
          summary: `${label}: ${this.words.noAnswerInTime}`,
        });
        return null;
      });
      throw new RunEnd({ status: "failed", reason: "needs_help", nodeId: name });
    }
    const help = answer.answer;
    // Kept for next time; a note that fails to save never fails the step.
    await this.runner.do(`${b}:memory`, async () => {
      const note = `Asked "${need.data.question}", the lead answered: ${
        typeof help === "string" ? help : JSON.stringify(help)
      }`.slice(0, 2000);
      try {
        await agent.runAction({
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
      } catch {
        // Best effort.
      }
      return null;
    });
    const input = { ...(resolveTemplate(view.input, frame.scope) as object), help };
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
        customize ? { customize } : {},
      ),
    );
    if (!again.ran) return again.output;
    const still =
      isPlainObject(again.output) && NeedsHelp.safeParse(again.output.needsHelp).success;
    if (still) throw new Error("still needs help after the lead's answer");
    return again.output;
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
    frame.scope.steps[step.id] = { output };
  }

  /**
   * Nobody answered a person step. `stop` fails the run (`timeout`), as a timeout always has;
   * `proceed` and `skip` go on with the step skipped and its output saying nobody answered.
   */
  // DECISION: `proceed` on a person step goes on with `approved: false`: nobody said yes, and a
  // later `if` should see that (v3's `continue`, which converts to `proceed`, did exactly this).
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
    const output = { approved: false, answer: null, by: null };
    await this.runner.do(`${name}:done`, async () => {
      await this.ctx.log.update(created.stepRunId, {
        status: then === "stop" ? "failed" : "skipped",
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
    frame.scope.steps[step.id] = { output };
  }

  // ── R3: conversation steps ───────────────────────────────────────────────────────────────────

  /**
   * A conversation (R7's port): started in a durable step; while under way the run waits for its
   * event or the step's deadline, then asks the port what came of it (its record is the truth).
   * Its output is what it found. Nobody answering in time takes the deadline's `ifNoAnswer`.
   */
  async conversation(step: processes.ConversationStep, name: string, frame: Frame): Promise<void> {
    const port = this.ctx.conversation;
    if (!port) throw new Error("conversation steps need the conversation service");
    const { run, log } = this.ctx;
    const label = clientLabel(asLabelled(step));
    const started = await this.runner.do(
      name,
      async () => {
        const resolved: processes.ConversationStep = {
          ...step,
          with: renderTemplate(step.with, frame.scope),
          goal: renderTemplate(step.goal, frame.scope),
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
        };
        const result = await port.conversation(request);
        if (result.status === "pending") {
          await log.update(stepRunId, {
            status: "waiting",
            summary: `${label}: ${this.words.waitingForAnswer}`,
          });
        }
        return { stepRunId, dueAt, request, result };
      },
      this.ctx.stepConfig,
    );
    let result: ConversationResult = started.result;
    for (let n = 1; result.status === "pending"; n++) {
      if (!result.conversationId) throw new Error("the conversation has no id to wait on");
      let timedOut = false;
      try {
        await this.runner.waitForEvent(`${name}:wait:${n}`, {
          type: conversationEventType(result.conversationId),
          timeout: untilDue(started.dueAt),
        });
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        timedOut = true;
      }
      result = await this.runner.do(
        `${name}:result:${n}`,
        () => port.conversation(started.request),
        this.ctx.stepConfig,
      );
      if (timedOut && result.status === "pending") result = { ...result, status: "no_answer" };
    }
    const output = {
      status: result.status,
      found: result.found,
      summary: result.summary,
      conversationId: result.conversationId,
    };
    if (result.status === "failed") {
      await this.runner.do(`${name}:done`, async () => {
        await log.update(started.stepRunId, {
          status: "failed",
          output,
          error: result.summary || "the conversation failed",
          summary: `${stepStateLabel(asLabelled(step), false)}: ${this.words.failed}`,
        });
        return null;
      });
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
          title: renderTemplate(step.goal, frame.scope),
          payload: { with: renderTemplate(step.with, frame.scope), found: result.found },
        });
        end = await this.escalate(name, then, ask);
      }
      const answered = "resolution" in end ? end.resolution : null;
      const final = answered ? { ...output, answer: answered.answer ?? null } : output;
      const stop = !answered && "ended" in end && end.ended === "stop";
      await this.runner.do(`${name}:done`, async () => {
        await log.update(started.stepRunId, {
          status: answered ? "succeeded" : stop ? "failed" : "skipped",
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
      if (stop) throw new RunEnd({ status: "failed", reason: "timeout", nodeId: name });
      frame.scope.steps[step.id] = { output: final };
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
    frame.scope.steps[step.id] = { output };
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
    });
    frame.scope.steps[step.id] = { output: chosen.output };
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
    try {
      await pool(items.length, step.concurrency ?? 10, (i) =>
        this.runList(step.steps, {
          prefix: `${name}:${i}:`,
          scope: {
            ...frame.scope,
            steps: { ...frame.scope.steps },
            item: items[i],
            index: i,
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof RunEnd)) throw error;
      ended = error;
    }

    const output = { count: items.length };
    await this.runner.do(`${name}:done`, async () => {
      await log.update(stepRunId, {
        status: ended?.result.status === "failed" ? "failed" : "succeeded",
        output,
        summary: `${clientLabel(asLabelled(step))}: ${this.words.items(items.length)}`,
      });
      return null;
    });
    if (ended) throw ended;
    frame.scope.steps[step.id] = { output };
  }

  async wait(step: processes.WaitStep, name: string, _frame: Frame): Promise<void> {
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
  }

  /** A notify step: a converted one exactly as v3 sent it; a v4 one through `notice`. */
  async notifyStep(step: processes.NotifyStep, name: string, frame: Frame): Promise<void> {
    const origin = this.origin(step);
    if (origin?.kind === "notify") return this.notifyV3(origin, name, frame);
    await this.notice(step.notify, name, frame.scope, step.name);
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
    };
    let ended: RunEnd | undefined;
    try {
      await this.runList(expanded.steps, inner);
    } catch (error) {
      if (!(error instanceof RunEnd)) throw error;
      ended = error;
    }
    const output = ended ? null : resolveTemplate(expanded.output, inner.scope);
    const label = clientLabel(asLabelled(step));
    await this.runner.do(`${name}:done`, async () => {
      const status = ended?.result.status;
      await log.update(started.stepRunId, {
        // DECISION: a use step's row has no `cancelled` status: one its steps cancelled (a
        // rejected write, a stop) is `skipped`, like a write a person turned down.
        status: status === "failed" ? "failed" : status === "cancelled" ? "skipped" : "succeeded",
        ...(ended ? {} : { output }),
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
    if (ended) throw ended;
    frame.scope.steps[step.id] = { output };
  }

  // ── v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54) ──────────────────────

  /** Whether a failure of this step goes to the run's own agent for review. */
  oversees(step: SkillStep | ActionStep): boolean {
    const oversight = this.ctx.oversight;
    return oversight !== undefined && reviewsFailures(oversight.settings, step);
  }

  /**
   * v0.13 M32: whether an attempt that succeeded is reviewed before the run goes on: done (not a
   * write a person turned down), and a checkpoint under `checkpoints`, any step under `all`, or a
   * step with `review: 'always'`.
   */
  checksAfter(step: SkillStep | ActionStep, name: string, attempt: Attempt | { thrown: unknown }) {
    if ("thrown" in attempt || attempt.outcome.kind !== "done" || attempt.rejected) return false;
    return reviewsAfterSuccess(
      this.ctx.oversight?.settings,
      step,
      this.checkpoints.has(checkpointKey(name, step.id)),
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
      if (error instanceof RunEnd) throw error;
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
    let current = await this.tryAttempt(step, name, frame, approval, undefined, opts);
    let input: unknown;
    let keyNode = name;
    let diagnosis: string | undefined;
    const result = () =>
      "thrown" in current
        ? { kind: "thrown" as const, error: current.thrown, ...withDiagnosis(diagnosis) }
        : { kind: "attempt" as const, attempt: current, ...withDiagnosis(diagnosis) };

    // A failed attempt is reviewed when the step's failures are; one that succeeded (v0.13 M32)
    // when it is a checkpoint under `checkpoints`, under `all`, or with `review: 'always'`.
    for (let seq = 1; ; seq++) {
      const failing = failedAttempt(current);
      if (!failing && !this.checksAfter(step, name, current)) break;
      // DECISION: the executor counts interventions per step and per run (a replay counts the same
      // stored verdicts again); the port holds the cost limit, from the decisions' recorded cost.
      if (seq > OVERSIGHT_MAX_PER_STEP || this.interventions >= maxPerRun) break;
      if (seq === 1) {
        try {
          input = resolveTemplate(step.input, frame.scope);
        } catch {
          break;
        }
      }
      const failed = current;
      const cause = failing ? ("failed" as const) : ("checkpoint" as const);
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
                    nodeType: step.kind,
                    ...(step.kind === "skill" ? { skillRef: step.skill } : {}),
                  })
                : failed.stepRunId;
            return oversight.port.review({
              run,
              step,
              nodeId: name,
              stepRunId,
              seq,
              cause,
              input,
              error,
              errorKey: failing
                ? runErrorKey(
                    { tool: step.kind === "action" ? step.tool : null, kind: step.kind },
                    error,
                  )
                : "",
              ...(failing ? {} : { output }),
              attempts: seq,
              ...(frame.automation ? { automation: frame.automation } : {}),
            });
          },
          this.ctx.stepConfig,
        );
      } catch {
        // A review that fails is no intervention: the step's own error (or output) stands.
        break;
      }
      // DECISION: `continue` after a checkpoint changes nothing, so it is not an intervention: it
      // counts toward neither limit (docs/plan.md §1.54).
      if (verdict.action === "none" || verdict.action === "continue") break;
      this.interventions += 1;
      diagnosis = verdict.note;
      if (verdict.action === "stop") {
        // v0.13 M32: a stop at a checkpoint cancels the run before the write it feeds.
        if (!failing) return { kind: "cancelled", reason: "oversight_stop", diagnosis };
        break;
      }
      if (verdict.action === "ask") {
        const timeout = approval.timeout ?? this.ctx.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;
        const answer = await this.awaitResolution(
          `${name}:oversee:${seq}:ask`,
          verdict.inboxItemId,
          timeout,
        );
        // v0.13 M32: approved at a checkpoint, the run goes on with the output as it is.
        if (answer?.approved === true && !failing) break;
        if (answer?.approved !== true) {
          // DECISION: a person who declines (or doesn't answer) is the step's `onReject`:
          // `continue` skips the step and the run goes on; `stop` fails it with its own error
          // (a failure) or cancels the run (a checkpoint, as a rejected write does).
          if (approval.onReject !== "continue") {
            if (!failing) return { kind: "cancelled", reason: "rejected", diagnosis };
            break;
          }
          await this.runner.do(`${name}:oversee:${seq}:skipped`, async () => {
            const stepRunId =
              "thrown" in failed
                ? await log.start({ runId: run.id, nodeId: name, nodeType: step.kind })
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

/** A skill step's output with only the fields its customization keeps (`sources` for alerts). */
function kept(
  output: unknown,
  keep: readonly string[],
  catalog: StepCatalog | undefined,
  step: SkillStep,
): unknown {
  if (!isPlainObject(output)) return output;
  const alerts = lookupSkill(step.skill, catalog ?? {})?.producesAlerts === true;
  const fields = new Set([...keep, ...(alerts ? ["sources"] : [])]);
  return Object.fromEntries(Object.entries(output).filter(([k]) => fields.has(k)));
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
