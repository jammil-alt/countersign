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
  clientLabel,
  DEFAULT_APPROVAL,
  type Duration,
  evaluateRules,
  type ForEachStep,
  type ForkStep,
  lookupSkill,
  type NotifyStep,
  type PersonStep,
  parseDuration,
  type RunContext,
  renderSummary,
  renderTemplate,
  resolveTemplate,
  type SkillStep,
  type Step,
  type StopStep,
  TIMELINE_WORDS,
  type TimelineWords,
  type WaitStep,
  type Workflow,
} from "@countersign/core";
import {
  type AgentPort,
  type InboxPort,
  InboxResolution,
  type NotifyPort,
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
}

export type RunEndStatus = "succeeded" | "failed" | "cancelled";

export interface RunResult {
  status: RunEndStatus;
  /** Why the run ended before its last step, e.g. `rejected`, `timeout`, `stop`, an error. */
  reason?: string;
  /** The durable name of the step that ended it. */
  nodeId?: string;
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
  const ex = new Executor(runner, ctx);
  try {
    await ex.runList(workflow.steps, { prefix: "", scope: { trigger, steps: {} } });
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
  ) {}

  get testRun(): boolean {
    return this.ctx.run.mode === "test";
  }

  /** The platform's words on the client timeline, in the client's language. */
  get words(): TimelineWords {
    return TIMELINE_WORDS[this.ctx.run.language ?? "en"];
  }

  async runList(steps: readonly Step[], frame: Frame): Promise<void> {
    for (const step of steps) await this.runStep(step, frame);
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
      }
    } catch (error) {
      if (error instanceof RunEnd) throw error;
      await this.recordFailure(step, name, message(error));
      throw new RunEnd({ status: "failed", reason: message(error), nodeId: name });
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

  summaryFor(step: SkillStep | ActionStep, output: unknown, rejected: boolean): string {
    if (rejected) return `${clientLabel(step)}: ${this.words.notApproved}`;
    const catalog = this.ctx.catalog ?? {};
    const template =
      step.kind === "skill"
        ? lookupSkill(step.skill, catalog)?.summary
        : catalog.tools?.[step.tool]?.summary;
    if (template) {
      try {
        const line = renderSummary(template, output, this.ctx.run.language).trim();
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
        ? { kind: "done", output: outcome.output ?? null }
        : outcome;
    let update: StepRunUpdate;
    switch (done.kind) {
      case "done":
        update = {
          status: rejected ? "skipped" : "succeeded",
          output: done.output,
          summary: this.summaryFor(step, done.output, rejected),
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
    const { run, agent, log } = this.ctx;
    const approval: Approval =
      step.kind === "action" ? step.approval : (step.approval ?? DEFAULT_APPROVAL);
    const first = await this.runner.do(
      name,
      async () => {
        const input = resolveTemplate(step.input, frame.scope);
        const start = { runId: run.id, nodeId: name, nodeType: step.kind, input } as const;
        const stepRunId = await log.start(
          step.kind === "skill" ? { ...start, skillRef: step.skill } : start,
        );
        const request = { run, nodeId: name, stepRunId, input, approval };
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
        outcome = await this.awaitStep(step, name, stepRunId, outcome.wait, n, rejected);
        continue;
      }
      const pending = outcome.pending;
      const base = `${name}:approval:${n}`;
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

    if (outcome.kind === "escalated") {
      throw new RunEnd({ status: "failed", reason: `escalated: ${outcome.reason}`, nodeId: name });
    }
    if (outcome.kind === "failed") {
      throw new RunEnd({ status: "failed", reason: outcome.error, nodeId: name });
    }
    if (outcome.kind !== "done") throw new Error("unreachable");
    if (rejected && approval.onReject === "stop") {
      // DECISION: a rejected write ends the run as `cancelled` (a person's decision, not a fault).
      throw new RunEnd({ status: "cancelled", reason: "rejected", nodeId: name });
    }
    frame.scope.steps[step.id] = { output: outcome.output };
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
  ): Promise<StepOutcome> {
    const { agent, run } = this.ctx;
    const { waitDone, afterWait } = agent;
    if (!waitDone || !afterWait) {
      throw new Error(`step ${step.id} waits, but the agent port can't wait`);
    }
    const base = `${name}:wait:${n}`;
    const request = { run, step, nodeId: name, stepRunId, wait };
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
      await notify.send({ run, step, nodeId: name, channel: step.channel, to, text, sources });
      await log.update(id, {
        status: "succeeded",
        summary: `${clientLabel(step)}: ${this.words.sent}`,
      });
      return null;
    });
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
