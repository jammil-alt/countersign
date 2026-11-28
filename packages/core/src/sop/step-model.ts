// The SOP reads a v5 workflow as the chart's own kinds (read, write, skill, person, notify, if...):
// the engine each Do step runs on (`doEngine`, docs/step-model-plan.md §4) picks the kind, so the
// SOP, the timeline and the executor read a Do step the same way. Pure.

import type { ToolSpec } from "../schemas/tool";
import { type ActionKind, actionKind, mergedAction } from "../steps/catalog";
import { doEngine } from "../steps/engine";
import type { DoStep, Step } from "../steps/schema";

/** A step in the SOP's reading: the chart's kinds, fields as the SOP's lines read them. */
export type ChartStep = { id: string; name: string; kind: string } & Record<string, unknown>;

/** An action's kind from the tools the SOP knows; a merged one by the first of its tools there is. */
export function kindOfAction(
  tools: Readonly<Record<string, ToolSpec>>,
): (action: string) => ActionKind | undefined {
  return (action) => {
    const own = tools[action];
    if (own) return actionKind(own);
    for (const tool of Object.values(mergedAction(action)?.tools ?? {})) {
      const spec = tools[tool];
      if (spec) return actionKind(spec);
    }
    return undefined;
  };
}

function common(step: Step): ChartStep {
  const out: ChartStep = { id: step.id, name: step.name, kind: "" };
  const s = step as { purpose?: unknown; client?: unknown; checks?: unknown };
  if (s.purpose !== undefined) out.purpose = s.purpose;
  if (s.client !== undefined) out.client = s.client;
  if (s.checks !== undefined) out.checks = s.checks;
  return out;
}

function doStep(step: DoStep, kindOf: (action: string) => ActionKind | undefined): ChartStep {
  const base = common(step);
  let engine: ReturnType<typeof doEngine>;
  try {
    engine = doEngine(step, kindOf);
  } catch {
    return { ...base, kind: "missing", need: step.name };
  }
  switch (engine.engine) {
    case "read":
      return { ...base, kind: "read", tool: engine.action, input: step.input };
    case "write":
      return { ...base, kind: "write", tool: engine.action, input: step.input };
    case "rules":
    case "ai":
      return {
        ...base,
        kind: "skill",
        skill: engine.skill ?? "steps.written",
        input: step.input,
        ...(engine.engine === "ai" && step.ai?.model ? { model: step.ai.model } : {}),
      };
    case "match":
      return { ...base, kind: "skill", skill: "steps.match", input: step.input };
    case "tell":
      return { ...base, kind: "notify", notify: step.tell ?? { to: [], channel: "inbox" } };
    case "person": {
      const p = step.person;
      return {
        ...base,
        kind: "person",
        mode: p?.mode ?? "ask",
        assignee: p?.who ?? "client_admin",
        title: p?.question ?? step.name,
        payload: p?.show ?? {},
        deadline: p?.deadline,
        ...(p?.choices ? { choices: p.choices } : {}),
      };
    }
    case "collect":
      return { ...base, kind: "collect", ...(step.collect ?? { items: [] }) };
    case "contact":
      return {
        ...base,
        kind: "conversation",
        with: step.contact?.with ?? "",
        channel: step.contact?.channel ?? "email",
        goal: step.contact?.goal ?? "",
        deadline: step.contact?.deadline,
      };
    case "automation":
      return { ...base, kind: "process", process: engine.automation, input: step.input };
    case "missing":
      return { ...base, kind: "missing", need: engine.need };
  }
}

/**
 * A v5 workflow's steps as the chart's kinds, at every depth. The End that closes the workflow
 * itself is left out: every workflow has one, so it says nothing; an End inside a path (the run
 * stops there) is a step of its own.
 */
export function chartSteps(
  steps: readonly Step[],
  kindOf: (action: string) => ActionKind | undefined,
): ChartStep[] {
  const last = steps.at(-1);
  return chartList(last?.kind === "end" ? steps.slice(0, -1) : steps, kindOf);
}

function chartList(
  steps: readonly Step[],
  kindOf: (action: string) => ActionKind | undefined,
): ChartStep[] {
  const each = (list: readonly Step[]) => chartList(list, kindOf);
  return steps.map((step): ChartStep => {
    switch (step.kind) {
      case "do":
        return doStep(step, kindOf);
      case "loop":
        return {
          ...common(step),
          kind: "skill",
          skill: step.skill ?? "steps.loop",
          input: step.input,
        };
      case "fork":
        return {
          ...common(step),
          kind: "if",
          paths: step.paths.map((p) => ({ ...p, steps: each(p.steps) })),
          otherwise: { ...step.otherwise, steps: each(step.otherwise.steps) },
          ...(step.decide ? { decide: step.decide } : {}),
        };
      case "for_each":
        return { ...common(step), kind: "for_each", over: step.over, steps: each(step.steps) };
      case "repeat":
        return { ...common(step), kind: "repeat", until: step.until, steps: each(step.steps) };
      case "wait":
        return { ...common(step), kind: "wait", for: step.for };
      case "handoff":
        return { ...common(step), kind: "handoff", to: step.to, input: step.input };
      case "end":
        return { ...common(step), kind: "stop" };
      default:
        return { ...common(step), kind: "missing" };
    }
  });
}
