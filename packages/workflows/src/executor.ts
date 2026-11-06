// The step-list executor (ARCHITECTURE §10.1, §10.3; docs/plan.md §1.2). It walks one workflow of
// a client agent's pinned bundle against a StepRunner, so the same code runs inside Cloudflare's
// RunWorkflow and in unit tests. Everything with a side effect (step_run rows, agent calls, inbox
// items, notifications) happens inside a named `runner.do`, so a replayed run repeats nothing.
//
// Durable names: a step's name is its id, or `${forEachName}:${index}:${childId}` inside a loop
// (so nested loops chain). Suffixes after `:` that are not an index (`:check`, `:wait`, `:done`,
// `:approval:<n>:…`) can't collide with them because step ids never contain `:`.

import {
  type ActionStep,
  type Approval,
  automationSkillRef,
  clientLabel,
  DEFAULT_APPROVAL,
  type Duration,
  evaluateRules,
  type ForEachStep,
  type ForkStep,
  lookupSkill,
  type NotifyStep,
  // v0.13 W2-I
  OVERSIGHT_DEFAULT_MAX_PER_RUN,
  OVERSIGHT_MAX_PER_STEP,
  type OversightSettings,
  type PersonStep,
  parseDuration,
  type RunContext,
  renderSummary,
  renderTemplate,
  resolveTemplate,
  // v0.13 M32
  reviewsAfterSuccess,
  reviewsFailures,
  runErrorKey,
  type SkillStep,
  type Step,
  type StopStep,
  TIMELINE_WORDS,
  type TimelineWords,
  type UseAutomationStep,
  type WaitStep,
  type Workflow,
  // v0.13 M32
  workflowCheckpoints,
} from "@countersign/core";
import { type AutomationResolver, ExpandError, type Expansions, expandAutomations } from "./expand";
import {
  type AgentPort,
  type InboxPort,
  InboxResolution,
  type NotifyPort,
  // v0.13 W2-I
  type OversightPort,
  type OversightVerdict,
  type RunInfo,
  type StepCatalog,
  type StepLog,
  type StepOutcome,
  type StepRunUpdate,
  type StepWait,
} from "./ports";
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
}

/** An oversight retry: its place, the input it runs with and the node its write keys use. */
interface AttemptRetry {
  seq: number;
  input: unknown;
  keyNode: string;
}

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

/**
 * Runs `workflow` for `ctx.run` with `trigger` as the trigger payload. Returns how the run ended;
 * apps/api records it on `run`. Throws only if the runner itself fails outside any step.
 */
export async function executeWorkflow(
  runner: StepRunner,
  ctx: ExecutorContext,
  workflow: Workflow,
  trigger: unknown,
): Promise<RunResult> {
  // v0.12 W2-B: automations expand before execution (ARCHITECTURE §10.7; docs/plan.md §1.45).
  // Pure and over immutable versions, so a replay or a retry expands the same steps and ids.
  // DECISION: a pinned version the run can't load fails the run at its use step before any step
  // runs, rather than part-way through.
  let expansions: Expansions;
  try {
    expansions = expandAutomations(workflow, ctx.automations ?? {});
  } catch (error) {
    if (!(error instanceof ExpandError)) throw error;
    return {
      status: "failed",
      reason: error.message,
      nodeId: error.stepId,
      errorKey: runErrorKey({ tool: null, kind: "use_automation" }, error.message),
    };
  }
  const ex = new Executor(runner, ctx, expansions);
  // v0.13 M32: checkpoints, from the version's steps and the automations they expand to. Pure over
  // immutable versions, so a replay computes the same set.
  if (ctx.oversight) {
    ex.checkpoints = new Set(
      workflowCheckpoints(workflow, {
        ...(ctx.catalog?.skills ? { skills: ctx.catalog.skills } : {}),
        ...(ctx.catalog?.tools ? { tools: ctx.catalog.tools } : {}),
        automations: Object.fromEntries(
          Object.values(expansions).map((e) => [e.ref, { steps: e.steps }]),
        ),
      }),
    );
  }
  try {
    await ex.runList(workflow.steps, { prefix: "", scope: { trigger, steps: {} }, top: true });
    return { status: "succeeded" };
  } catch (error) {
    if (error instanceof RunEnd) return error.result;
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Executor {
  constructor(
    readonly runner: StepRunner,
    readonly ctx: ExecutorContext,
    // v0.12 W2-B
    readonly expansions: Expansions = {},
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

  async runList(steps: readonly Step[], frame: Frame): Promise<void> {
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

  /**
   * A retry's step before the failed one (ARCHITECTURE §10.10): not run again. Its row is copied
   * from the run retried, with its output, and the summary says where it came from.
   */
  async reuse(step: Step, resume: RunResume, frame: Frame): Promise<void> {
    const row = resume.reused[step.id];
    if (!row) return;
    await this.runner.do(`${step.id}:reused`, async () => {
      const id = await this.ctx.log.start({
        runId: this.ctx.run.id,
        nodeId: step.id,
        nodeType: step.kind,
        ...(step.kind === "skill" ? { skillRef: step.skill } : {}),
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

  async runStep(step: Step, frame: Frame): Promise<void> {
    const name = `${frame.prefix}${step.id}`;
    try {
      switch (step.kind) {
        case "skill":
        case "action":
          return await this.work(step, name, frame);
        case "person":
          return await this.person(step, name, frame);
        case "fork":
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
        case "use_automation":
          return await this.useAutomation(step, name, frame);
      }
    } catch (error) {
      if (error instanceof RunEnd) {
        // The innermost step that failed names the error (`error.key`, docs/plan.md §1.40).
        if (error.result.status === "failed" && error.result.errorKey === undefined) {
          error.result.errorKey = errorKeyOf(step, error.result.reason);
        }
        throw error;
      }
      await this.recordFailure(step, name, message(error));
      throw new RunEnd({
        status: "failed",
        reason: message(error),
        nodeId: name,
        errorKey: errorKeyOf(step, message(error)),
      });
    }
  }

  /** Best effort: the step's row says why it failed. The run fails either way. */
  async recordFailure(step: Step, name: string, error: string): Promise<void> {
    try {
      await this.runner.do(`${name}:failed`, async () => {
        const id = await this.ctx.log.start({
          runId: this.ctx.run.id,
          nodeId: name,
          nodeType: step.kind,
        });
        await this.ctx.log.update(id, {
          status: "failed",
          error,
          summary: `${clientLabel(step)}: ${this.words.failed}`,
        });
        return null;
      });
    } catch {
      // The log itself failing must not hide the step's own error.
    }
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
    if (rejected) return `${clientLabel(step)}: ${this.words.notApproved}`;
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
  ): Promise<StepOutcome> {
    const done: StepOutcome =
      outcome.kind === "approval" && this.testRun
        ? { kind: "done", output: outcome.output ?? null, notWritten: true }
        : outcome;
    let update: StepRunUpdate;
    switch (done.kind) {
      case "done":
        update = {
          status: rejected ? "skipped" : "succeeded",
          output: done.output,
          summary: this.summaryFor(
            step,
            done.output,
            rejected,
            this.testRun && done.notWritten === true,
          ),
        };
        if (done.costUsd !== undefined) update.costUsd = done.costUsd;
        if (done.tokensIn !== undefined) update.tokensIn = done.tokensIn;
        if (done.tokensOut !== undefined) update.tokensOut = done.tokensOut;
        break;
      case "approval":
        update = {
          status: "waiting",
          summary: `${clientLabel(step)}: ${this.words.waitingForApproval}`,
        };
        break;
      case "waiting":
        update = {
          status: "waiting",
          summary: `${clientLabel(step)}: ${done.wait.reason === "release" ? this.words.waitingForRelease : "waiting for a reply"}`,
        };
        break;
      case "escalated":
        update = {
          status: "failed",
          error: `escalated: ${done.reason}`,
          summary: `${clientLabel(step)}: ${this.words.needsOperator}`,
        };
        break;
      case "failed":
        update = {
          status: "failed",
          error: done.error,
          summary: `${clientLabel(step)}: ${this.words.failed}`,
        };
        break;
    }
    await this.ctx.log.update(stepRunId, update);
    return done;
  }

  async work(step: SkillStep | ActionStep, name: string, frame: Frame): Promise<void> {
    const approval: Approval =
      step.kind === "action" ? step.approval : (step.approval ?? DEFAULT_APPROVAL);
    // v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54). Without a port, or when
    // this step's failures aren't reviewed, the first attempt is the only one, exactly as before.
    if (this.oversees(step)) {
      const done = await this.overseen(step, name, frame, approval);
      if (done.kind === "thrown") {
        if (done.diagnosis === undefined) throw done.error;
        const reason = message(done.error);
        await this.recordFailure(step, name, reason);
        throw new RunEnd({
          status: "failed",
          reason,
          nodeId: name,
          errorKey: errorKeyOf(step, reason),
          diagnosis: done.diagnosis,
        });
      }
      if (done.kind === "skipped") {
        frame.scope.steps[step.id] = { output: null };
        return;
      }
      // v0.13 M32: stopped at a checkpoint, before the write it feeds.
      if (done.kind === "cancelled") {
        throw new RunEnd({
          status: "cancelled",
          reason: done.reason,
          nodeId: name,
          ...withDiagnosis(done.diagnosis),
        });
      }
      return this.finishWork(step, name, frame, approval, done.attempt, done.diagnosis);
    }
    return this.finishWork(
      step,
      name,
      frame,
      approval,
      await this.attempt(step, name, frame, approval),
    );
  }

  /** How the step's last attempt ended decides the run (unchanged by oversight). */
  finishWork(
    step: SkillStep | ActionStep,
    name: string,
    frame: Frame,
    approval: Approval,
    { outcome, rejected }: Attempt,
    diagnosis?: string,
  ): void {
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
    if (rejected && approval.onReject === "stop") {
      // DECISION: a rejected write ends the run as `cancelled` (a person's decision, not a fault).
      throw new RunEnd({ status: "cancelled", reason: "rejected", nodeId: name });
    }
    frame.scope.steps[step.id] = { output: outcome.output };
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
  ): Promise<Attempt> {
    const { run, agent, log } = this.ctx;
    const at = retry ? `${name}:retry:${retry.seq}` : name;
    const keyNode = retry && retry.keyNode !== name ? retry.keyNode : undefined;
    const first = await this.runner.do(
      at,
      async () => {
        const input = retry ? retry.input : resolveTemplate(step.input, frame.scope);
        const start = {
          runId: run.id,
          nodeId: name,
          nodeType: step.kind,
          input,
          // v0.13 W2-I
          ...(retry ? { attempt: retry.seq + 1 } : {}),
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
            ? await agent.runSkill({ ...request, step })
            : await agent.runAction({ ...request, step });
        return { stepRunId, outcome: await this.settle(step, stepRunId, outcome, false) };
      },
      this.ctx.stepConfig,
    );

    const { stepRunId } = first;
    let outcome = first.outcome;
    let rejected = false;
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
      const timeout = approval.timeout ?? this.ctx.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;
      const resolution = (await this.awaitResolution(base, pending.inboxItemId, timeout)) ?? {
        approved: false,
        by: null,
      };
      if (resolution.approved !== true) rejected = true;
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
          return this.settle(step, stepRunId, next, rejected);
        },
        this.ctx.stepConfig,
      );
    }
    return { stepRunId, outcome, rejected };
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

  // ── person steps ─────────────────────────────────────────────────────────────────────────────

  async person(step: PersonStep, name: string, frame: Frame): Promise<void> {
    const { run, inbox, log, notify } = this.ctx;
    const created = await this.runner.do(name, async () => {
      const title = renderTemplate(step.title, frame.scope);
      const payload = resolveTemplate(step.payload, frame.scope);
      const stepRunId = await log.start({
        runId: run.id,
        nodeId: name,
        nodeType: "person",
        input: { title, payload },
      });
      // Inside the `do`, so a replay keeps the first due date.
      const dueAt = new Date(Date.now() + parseDuration(step.timeout)).toISOString();
      const item = await inbox.createForPerson({
        run,
        step,
        nodeId: name,
        stepRunId,
        kind: step.mode === "approve" ? "approval" : "request",
        title,
        payload,
        dueAt,
      });
      await log.update(stepRunId, {
        status: "waiting",
        summary: `${clientLabel(step)}: ${step.mode === "approve" ? this.words.waitingForApproval : this.words.waitingForAnswer}`,
      });
      return { stepRunId, inboxItemId: item.id };
    });

    const resolution = await this.awaitResolution(name, created.inboxItemId, step.timeout);
    const label = clientLabel(step);

    if (!resolution) {
      const output = { approved: false, answer: null, by: null };
      await this.runner.do(`${name}:done`, async () => {
        await log.update(created.stepRunId, {
          status: step.onTimeout === "continue" ? "skipped" : "failed",
          output,
          summary: `${label}: ${this.words.noAnswerInTime}`,
        });
        if (step.onTimeout === "notify_operator") {
          await notify.notifyOperator({
            run,
            nodeId: name,
            inboxItemId: created.inboxItemId,
            reason: `no answer to "${label}" within ${step.timeout}`,
          });
        }
        return null;
      });
      // DECISION: `notify_operator` tells the operator and then ends the run like `stop`: the
      // workflow can't go on without the person, and the operator decides what to do next.
      if (step.onTimeout !== "continue") {
        throw new RunEnd({ status: "failed", reason: "timeout", nodeId: name });
      }
      frame.scope.steps[step.id] = { output };
      return;
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

  // ── logic ────────────────────────────────────────────────────────────────────────────────────

  async fork(step: ForkStep, name: string, frame: Frame): Promise<void> {
    const { run, log } = this.ctx;
    // The choice is made inside the `do`, so a replay takes the same path even if data or the
    // rules engine changed in between.
    const chosen = await this.runner.do(name, async () => {
      const stepRunId = await log.start({ runId: run.id, nodeId: name, nodeType: "fork" });
      const index = step.paths.findIndex((p) => evaluateRules(p.when, frame.scope));
      const path = index >= 0 ? step.paths[index] : undefined;
      const output = path
        ? { pathId: path.id, pathName: path.name }
        : { pathId: step.otherwise.id, pathName: "Otherwise" };
      await log.update(stepRunId, {
        status: "succeeded",
        output,
        summary: `${clientLabel(step)}: ${path ? output.pathName : this.words.otherwise}`,
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

  async forEach(step: ForEachStep, name: string, frame: Frame): Promise<void> {
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
      await pool(items.length, step.concurrency, (i) =>
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
        summary: `${clientLabel(step)}: ${this.words.items(items.length)}`,
      });
      return null;
    });
    if (ended) throw ended;
    frame.scope.steps[step.id] = { output };
  }

  async wait(step: WaitStep, name: string, _frame: Frame): Promise<void> {
    const { run, log } = this.ctx;
    const { stepRunId } = await this.runner.do(name, async () => {
      const id = await log.start({ runId: run.id, nodeId: name, nodeType: "wait" });
      await log.update(id, {
        status: "waiting",
        summary: `${clientLabel(step)}: ${this.words.waiting(step.for)}`,
      });
      return { stepRunId: id };
    });
    await this.runner.sleep(`${name}:sleep`, step.for);
    await this.runner.do(`${name}:done`, async () => {
      await log.update(stepRunId, {
        status: "succeeded",
        summary: `${clientLabel(step)}: ${this.words.waited(step.for)}`,
      });
      return null;
    });
  }

  async notifyStep(step: NotifyStep, name: string, frame: Frame): Promise<void> {
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

  // ── v0.12 W2-B: use steps (ARCHITECTURE §10.7; docs/plan.md §1.45) ──────────────────────────

  /**
   * A use step: its input resolved, then the automation's steps under `${name}/`, reading only
   * `{{input...}}` and each other; then its output from the automation's `output`. Nothing after it
   * sees an inner step. Its own row (`skill_ref` `automation:<slug>@<version>`) takes its status
   * from its children.
   */
  async useAutomation(step: UseAutomationStep, name: string, frame: Frame): Promise<void> {
    const { run, log } = this.ctx;
    const expanded = this.expansions[step.id];
    if (!expanded) throw new Error(`automation ${step.automation} was not expanded`);
    const started = await this.runner.do(name, async () => {
      const input = resolveTemplate(step.input, frame.scope);
      const id = await log.start({
        runId: run.id,
        nodeId: name,
        nodeType: "use_automation",
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
    const label = clientLabel(step);
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
    retry?: AttemptRetry,
  ): Promise<Attempt | { thrown: unknown }> {
    try {
      return await this.attempt(step, name, frame, approval, retry);
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
    let current = await this.tryAttempt(step, name, frame, approval);
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
              errorKey: failing ? errorKeyOf(step, error) : "",
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
              summary: `${clientLabel(step)}: ${this.words.notApproved}`,
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
      current = await this.tryAttempt(step, name, frame, approval, { seq, input, keyNode });
    }
    return result();
  }

  async stop(step: StopStep, name: string): Promise<void> {
    const { run, log } = this.ctx;
    await this.runner.do(name, async () => {
      const id = await log.start({ runId: run.id, nodeId: name, nodeType: "stop" });
      await log.update(id, {
        status: "succeeded",
        summary: `${clientLabel(step)}: ${this.words.stopped[step.status]}`,
      });
      return null;
    });
    throw new RunEnd({ status: step.status, reason: "stop", nodeId: name });
  }
}

/** `<tool id or step kind>:<code>`: an action step names its tool, any other step its kind. */
function errorKeyOf(step: Step, reason: string | undefined): string {
  return runErrorKey(
    { tool: step.kind === "action" ? step.tool : null, kind: step.kind },
    reason ?? null,
  );
}

/**
 * Where a retry of a run that failed at `nodeId` resumes (docs/plan.md §1.40): the top-level step
 * that is, or holds, the failed one. Only top-level steps are resumable, so a failure inside a fork
 * path or a loop resumes at that fork or loop. Null when no step matches (it failed before any).
 */
export function resumePoint(
  workflow: Pick<Workflow, "steps">,
  nodeId: string | null,
): string | null {
  if (!nodeId) return null;
  // A durable name is the step id, `${loop}:${i}:${child}` in a loop, or a suffix after `:`;
  // v0.12 W2-B: inside a use step, `${use}/${inner}` (the use step is what resumes).
  const id = nodeId.split(/[:/]/)[0] ?? nodeId;
  const holds = (step: Step): boolean => {
    if (step.id === id) return true;
    if (step.kind === "fork") {
      return [...step.paths.flatMap((p) => p.steps), ...step.otherwise.steps].some(holds);
    }
    return step.kind === "for_each" && step.steps.some(holds);
  };
  return workflow.steps.find(holds)?.id ?? null;
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
