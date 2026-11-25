// The step model (docs/step-model-plan.md §4, §8, §9; wave 1, stream A): running a v5 workflow on
// the engines the executor already has. Each step is loaded as the step the engine that runs it
// takes: a Do as the engine `steps.doEngine` picks for its done by and uses (a read, a write, a
// skill, a notify, a person, a collect, a conversation, a process, a missing step), a Fork as an
// `if`, and For each, Repeat, Wait and Hand off as themselves. Three steps have no engine of their
// own today and are run by the executor beside its engines, found by `sources`: a Match (stream D's
// port), a Loop (the agents runtime's loop, reads only) and an End (the workflow's outputs).
//
// DECISION (wave 1): a load, not a stored translation. Nothing stored is rewritten (invariant 3)
// and the v5 workflow is what the version holds; what an engine takes is built from it for one
// run, as a v3 workflow is read as v4 today (`./process`). Every step keeps its id, so durable
// names, step rows, idempotency keys, retries and hand-offs are the same as a v4 step's, and its
// outcome is recorded in its engine's words (`steps.ENGINE_OUTCOMES`). When v3 and v4 go (wave 4),
// the engines take these shapes under the step model's names and this load goes with them.

import type { JsonSchema, ToolSpec } from "@countersign/core";
import { processes, steps } from "@countersign/core";
import type { LoadedProcess } from "./process";
import { ProcessLoadError } from "./process";

/** What a v5 workflow's steps are run as, beside the engines' own steps. */
export interface StepModelRun {
  /** Engine step (by object) → the v5 step it runs. */
  sources: WeakMap<object, steps.Step>;
  /** The workflow's declared outputs, by id. */
  outputs: ReadonlyMap<string, steps.WorkflowOutput>;
  /**
   * Engine steps whose `tool` is a merged action (`spreadsheet.rows.append`) with no write action
   * of today's: resolved for the run's agent (`AgentPort.resolveMerged`) before the gate.
   */
  merged: WeakSet<object>;
}

/** A v5 workflow loaded for the executor: its engines' steps and what runs beside them. */
export interface LoadedStepModel extends LoadedProcess {
  stepModel: StepModelRun;
}

/**
 * Merged actions that are today's write actions (`process/actions.ts`): they resolve from the
 * agent's bindings or its channel exactly as an action write step does. `sms.send` is the one-off
 * converter's name for "Send text" (`convert-v4.ts`).
 */
export const STEP_MODEL_WRITE_ACTIONS: Readonly<Record<string, processes.WriteAction>> = {
  "email.send": "send_email",
  "sms.send": "send_text",
  "accounting.bill.create": "create_bill",
  "accounting.vendor.create": "create_vendor",
};

/** The skill ref a Loop written in the step runs under: no Library skill, the step's own loop. */
export const LOOP_SKILL = "steps.loop";
/** The skill ref a Do written in the step carries until it runs (stream F, wave 2). */
export const WRITTEN_SKILL = "steps.written";
/** The skill ref a Match step's row carries (its engine is stream D's port, not a skill). */
export const MATCH_SKILL = "steps.match";

/** An action's kind (`steps.actionKind`) from the catalog's tools; a merged one by its tools'. */
export function catalogKindOf(
  tools: Readonly<Record<string, ToolSpec>> | undefined,
): (action: string) => steps.ActionKind | undefined {
  return (action) => {
    const own = tools?.[action];
    if (own) return steps.actionKind(own);
    const merged = steps.mergedAction(action);
    for (const tool of Object.values(merged?.tools ?? {})) {
      const spec = tools?.[tool];
      if (spec) return steps.actionKind(spec);
    }
    return undefined;
  };
}

/** A step's fields as a JSON schema (a Loop's output, for the runtime's finish). */
export function fieldsSchema(fields: readonly steps.Field[]): JsonSchema {
  const one = (f: steps.Field): Record<string, unknown> => {
    const about = f.about ? { description: f.about } : {};
    switch (f.type) {
      case "number":
        return { type: "number", ...about };
      case "money":
        // Money is decimal (invariant 6): a string, never a float.
        return { type: "string", pattern: "^-?\\d+(\\.\\d+)?$", ...about };
      case "date":
        return { type: "string", format: "date", ...about };
      case "yes_no":
        return { type: "boolean", ...about };
      case "list":
        return { type: "array", items: fieldsSchema(f.of ?? []), ...about };
      case "group":
        return { ...fieldsSchema(f.of ?? []), ...about };
      case "record":
        return { type: "string", ...about, "x-record": f.record };
      case "text":
        return { type: "string", ...about };
    }
  };
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, one(f)])),
    required: fields.filter((f) => f.required).map((f) => f.name),
  } as JsonSchema;
}

type Out = Record<string, unknown>;

/** What every step carries over to its engine's step unchanged. */
function common(step: steps.Step): Out {
  const out: Out = { id: step.id, name: step.name };
  for (const key of ["purpose", "client", "review", "onError", "checks"] as const) {
    const v = step[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * A v5 workflow, loaded to run. `kindOf` says an action's kind (the catalog's); an action it
 * doesn't know runs as a Change (approval on, invariant 8). Throws `ProcessLoadError` when the
 * workflow doesn't parse.
 */
export function loadStepModel(
  workflow: steps.Workflow,
  kindOf: (action: string) => steps.ActionKind | undefined,
): LoadedStepModel {
  const parsed = steps.Workflow.safeParse(workflow);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProcessLoadError(
      `the workflow doesn't parse: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
    );
  }
  const wf = parsed.data;
  // A draft parses (an empty goal, an End with nothing to deliver); only a version that passes
  // the publish checks runs. Structural checks only: what needs the registries was checked at
  // publish, against the catalog of that day.
  // DECISION: refused at load, before any step runs, naming the first problem.
  const problems = steps.validateWorkflow(wf);
  const first = problems[0];
  if (first) {
    throw new ProcessLoadError(
      `the workflow can't run: ${first.message}${first.at ? ` (${first.at})` : ""}`,
    );
  }
  const sources = new WeakMap<object, steps.Step>();
  const merged = new WeakSet<object>();

  const load = (step: steps.Step): processes.Step => {
    const out = loadOne(step, kindOf, load, merged);
    sources.set(out, step);
    return out;
  };
  const process = {
    schemaVersion: 4,
    triggers: wf.triggers,
    steps: wf.steps.map(load),
  } as processes.Process;
  return {
    process,
    origins: new WeakMap(),
    v3: null,
    stepModel: { sources, outputs: new Map(wf.outputs.map((o) => [o.id, o])), merged },
  };
}

function loadOne(
  step: steps.Step,
  kindOf: (action: string) => steps.ActionKind | undefined,
  load: (step: steps.Step) => processes.Step,
  merged: WeakSet<object>,
): processes.Step {
  const base = common(step);
  switch (step.kind) {
    case "do":
      return loadDo(step, base, kindOf, merged);
    case "loop":
      // Run by the executor through the runtime's loop (`Executor.loop`); a skill row, as an
      // agent-mode skill's was.
      return {
        ...base,
        kind: "skill",
        skill: step.skill ?? LOOP_SKILL,
        input: step.input,
        ...(step.model ? { model: step.model } : {}),
      } as processes.Step;
    case "fork":
      return {
        ...base,
        kind: "if",
        paths: step.paths.map((p) => ({
          id: p.id,
          name: p.name,
          when: p.when,
          ...(p.describe !== undefined ? { describe: p.describe } : {}),
          steps: p.steps.map(load),
        })),
        otherwise: { id: step.otherwise.id, steps: step.otherwise.steps.map(load) },
        ...(step.decide ? { decide: step.decide } : {}),
        ...(step.show ? { show: step.show } : {}),
        ...(step.ifUnsure ? { ifUnsure: step.ifUnsure } : {}),
      } as processes.Step;
    case "for_each":
      return {
        ...base,
        kind: "for_each",
        over: step.over,
        concurrency: step.concurrency,
        steps: step.steps.map(load),
      } as processes.Step;
    case "repeat":
      return {
        ...base,
        kind: "repeat",
        steps: step.steps.map(load),
        until: step.until,
        maxTimes: step.maxTimes,
        ...(step.between ? { between: step.between } : {}),
        onLimit: step.onLimit,
      } as processes.Step;
    case "wait":
      return { ...base, kind: "wait", for: step.for } as processes.Step;
    case "handoff":
      return { ...base, kind: "handoff", to: step.to, input: step.input } as processes.Step;
    case "end":
      // Its outputs are delivered by the executor (`Executor.end`), then it ends the run as a Stop.
      return { ...base, kind: "stop", status: step.status } as processes.Step;
  }
}

function loadDo(
  step: steps.DoStep,
  base: Out,
  kindOf: (action: string) => steps.ActionKind | undefined,
  merged: WeakSet<object>,
): processes.Step {
  let engine: steps.DoEngine;
  try {
    engine = steps.doEngine(step, kindOf);
  } catch (error) {
    throw new ProcessLoadError(error instanceof Error ? error.message : String(error));
  }
  const input = step.input;
  switch (engine.engine) {
    case "read": {
      const out = { ...base, kind: "read", tool: engine.action, input } as processes.Step;
      if (steps.mergedAction(engine.action)) merged.add(out);
      return out;
    }
    case "write": {
      const action = STEP_MODEL_WRITE_ACTIONS[engine.action];
      if (action) return { ...base, kind: "write", action, input } as processes.Step;
      const out = { ...base, kind: "write", tool: engine.action, input } as processes.Step;
      if (steps.mergedAction(engine.action)) merged.add(out);
      return out;
    }
    case "rules":
    case "ai": {
      // Written in the step (no skill): stream F's (wave 2). It loads as a skill step the
      // executor refuses when it is reached (`Executor.runStep`), naming why.
      const values = engine.engine === "rules" ? step.rules?.values : step.ai?.values;
      const rows = engine.engine === "rules" ? step.rules?.rows : undefined;
      const text = engine.engine === "ai" ? step.ai?.text?.trim() : undefined;
      const model = engine.engine === "ai" ? step.ai?.model : undefined;
      const customize = {
        ...(rows?.length ? { rules: { add: rows } } : {}),
        ...(text ? { addInstructions: text } : {}),
      };
      return {
        ...base,
        kind: "skill",
        skill: engine.skill ?? WRITTEN_SKILL,
        // Another agent of the same client runs it, as a v4 skill step's `agent`.
        ...(step.agent ? { agent: step.agent } : {}),
        input,
        ...(values && Object.keys(values).length > 0 ? { settings: values } : {}),
        ...(model ? { model } : {}),
        ...(Object.keys(customize).length > 0 ? { customize } : {}),
        // Reshape data: its mapping is the step's translation (the one-off converter's).
        ...(engine.skill &&
        step.translation &&
        processes.RESHAPE_SKILL === engine.skill.split("@")[0]
          ? { reshape: step.translation }
          : {}),
      } as processes.Step;
    }
    case "match":
      return { ...base, kind: "skill", skill: MATCH_SKILL, input } as processes.Step;
    case "tell":
      if (!step.tell) throw new ProcessLoadError(`step ${step.id}: a Tell says nothing`);
      return { ...base, kind: "notify", notify: step.tell } as processes.Step;
    case "person": {
      const p = step.person;
      if (!p) throw new ProcessLoadError(`step ${step.id}: nobody is asked`);
      return {
        ...base,
        kind: "person",
        mode: p.mode,
        assignee: p.who,
        title: p.question,
        payload: p.show,
        deadline: p.deadline,
        channel: p.channel,
        onReject: p.onReject,
        ...(p.choices ? { choices: p.choices } : {}),
      } as processes.Step;
    }
    case "collect": {
      const c = step.collect;
      if (!c) throw new ProcessLoadError(`step ${step.id}: no reports are listed`);
      return {
        ...base,
        kind: "collect",
        items: c.items,
        ...(c.escalate ? { escalate: c.escalate } : {}),
        ifMissing: c.ifMissing,
      } as processes.Step;
    }
    case "contact": {
      const c = step.contact;
      if (!c) throw new ProcessLoadError(`step ${step.id}: nobody is contacted`);
      // What it must find out: its output fields, `?` for optional (the converter's reading).
      const find = Object.fromEntries(
        (step.output ?? []).map((f) => [
          f.name,
          `${f.about ?? f.type}${f.required ? "" : "?"}`.replace(/\?\?$/, "?"),
        ]),
      );
      return {
        ...base,
        kind: "conversation",
        with: c.with,
        channel: c.channel,
        goal: c.goal,
        mayShare: c.mayShare,
        find,
        maxTurns: c.maxTurns,
        messages: c.messages,
        deadline: c.deadline,
      } as processes.Step;
    }
    case "automation":
      return { ...base, kind: "process", process: engine.automation, input } as processes.Step;
    case "missing":
      return { ...base, kind: "missing", need: engine.need } as processes.Step;
  }
}

/** Whether a Do step's work is written in the step itself (rules or AI without a skill). */
export function writtenInStep(step: steps.Step): boolean {
  return (
    step.kind === "do" &&
    step.uses === undefined &&
    (step.doneBy === "rules" || step.doneBy === "ai")
  );
}

/** A Do step's incoming translation that no engine runs yet (stream G's, wave 2). */
export function unrunTranslation(step: steps.Step): boolean {
  if (step.kind !== "do" && step.kind !== "loop") return false;
  if (!step.translation) return false;
  return !(
    step.kind === "do" &&
    step.uses?.type === "skill" &&
    step.uses.skill.split("@")[0] === processes.RESHAPE_SKILL
  );
}

/** A Loop's limits and reads, as the runtime takes them (`SkillStepRequest.loop`). */
export function loopRequest(step: steps.LoopStep, isGet: (action: string) => boolean): StepLoop {
  return {
    goal: step.goal,
    instructions: step.instructions,
    // It never writes: only Get actions reach the runtime, whatever the step lists (§8).
    reads: step.reads.filter(isGet),
    maxTurns: step.maxTurns,
    atLimit: step.atLimit,
    ...(step.output.length > 0 ? { output: fieldsSchema(step.output) } : {}),
  };
}

/** A Loop for the runtime (§8): its goal, read tools, turns and what happens at the limit. */
export interface StepLoop {
  goal: string;
  instructions: string;
  /** The Get actions it may call (a merged read is not offered to a Loop yet). */
  reads: string[];
  maxTurns: number;
  atLimit: "stop" | "hand_back";
  /** Its output fields as a schema; absent: an answer with its sources. */
  output?: JsonSchema;
}
