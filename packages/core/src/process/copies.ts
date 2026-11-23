// Copied steps (owner, 2026-11-23: "multiple ways in if needed, multiple ways out if needed"). Asked
// for a nightly scan, the Builder added a second workflow whose loop held a copy of every step of
// the agent's first one, so the same work had to be kept in two places. A way in that needs its own
// steps first ends by handing off into the main workflow ("@self"); it never repeats its steps.
// This finds the repeats: the Builder's guard asks the model to fix them, and the bundle's
// validation shows them in the chart's "Worth a look".
//
// DECISION: a copy is a run of at least `COPY_MIN_STEPS` (3) steps in a row, in any step list of
// one workflow (top level, an if's path or otherwise, a loop's body), that matches a run in any
// step list of another enabled workflow. Steps match when they are the same kind doing the same
// thing: a read's tool; a write's tool, action and connector; a skill step's skill (by id, any
// version) and agent; an automation's ref; a hand-off's target. A decision or a loop matches only
// when everything inside it does. Steps that call nothing (a person, a notify, a wait, a stop)
// match by kind alone, so a run must also hold at least `COPY_MIN_CALLS` (2) steps that call a
// tool, skill or automation: "ask a person, notify, stop" in two places is not a copy.

import { parseSkillRef } from "../schemas/common";
import type { Step } from "./schema";

/** The fewest steps in a row that make a copy. */
export const COPY_MIN_STEPS = 3;
/** Of those, the fewest that call a tool, a skill or an automation. */
export const COPY_MIN_CALLS = 2;

/** A run of steps one workflow repeats from another. */
export interface CopiedRun {
  /** The workflow the steps are first in (the earlier one in the bundle). */
  from: string;
  /** The workflow that repeats them. */
  in: string;
  /** The repeated steps' ids in `in`, in order. */
  stepIds: string[];
  /** Their names, in order. */
  names: string[];
}

interface Sig {
  key: string;
  calls: boolean;
}

function sigOf(step: Step): Sig {
  switch (step.kind) {
    case "read":
      return { key: `read:${step.tool}`, calls: true };
    case "write":
      return {
        key: `write:${step.tool ?? ""}:${step.action ?? ""}:${step.via ?? ""}`,
        calls: true,
      };
    case "skill":
      return {
        key: `skill:${parseSkillRef(step.skill).id}:${step.agent ?? ""}`,
        calls: true,
      };
    case "process":
      return { key: `process:${step.process}`, calls: true };
    case "handoff": {
      const to = step.to as { agent: string; step: string; workflow?: string };
      return { key: `handoff:${to.agent}:${to.workflow ?? ""}:${to.step}`, calls: false };
    }
    case "if": {
      const inner = [...step.paths.map((p) => p.steps), step.otherwise.steps].map(listSig);
      return {
        key: `if(${inner.map((l) => l.key).join("|")})`,
        calls: inner.some((l) => l.calls),
      };
    }
    case "for_each":
    case "repeat": {
      const inner = listSig(step.steps);
      return { key: `${step.kind}(${inner.key})`, calls: inner.calls };
    }
    default:
      return { key: step.kind, calls: false };
  }
}

function listSig(steps: readonly Step[]): Sig {
  const sigs = steps.map(sigOf);
  return { key: sigs.map((s) => s.key).join(","), calls: sigs.some((s) => s.calls) };
}

/** Every step list of a process: the top level, each path and otherwise, each loop's body. */
function stepLists(steps: readonly Step[], out: Step[][] = []): Step[][] {
  out.push([...steps]);
  for (const s of steps) {
    if (s.kind === "if") {
      for (const p of s.paths) stepLists(p.steps, out);
      stepLists(s.otherwise.steps, out);
    } else if (s.kind === "for_each" || s.kind === "repeat") {
      stepLists(s.steps, out);
    }
  }
  return out.filter((l) => l.length >= COPY_MIN_STEPS);
}

/** The longest run of matching steps between two lists that makes a copy, as a slice of `b`. */
function longestRun(a: readonly Step[], b: readonly Step[]): Step[] | null {
  const sa = a.map(sigOf);
  const sb = b.map(sigOf);
  let best: Step[] | null = null;
  let prev = new Array<number>(sb.length + 1).fill(0);
  for (let i = 1; i <= sa.length; i++) {
    const row = new Array<number>(sb.length + 1).fill(0);
    for (let j = 1; j <= sb.length; j++) {
      if (sa[i - 1]?.key !== sb[j - 1]?.key) continue;
      const n = (prev[j - 1] ?? 0) + 1;
      row[j] = n;
      if (n < COPY_MIN_STEPS || (best && n <= best.length)) continue;
      const run = sb.slice(j - n, j);
      if (run.filter((s) => s.calls).length >= COPY_MIN_CALLS) best = b.slice(j - n, j);
    }
    prev = row;
  }
  return best;
}

/**
 * The copies between a bundle's workflows: for each pair, the longest run of steps the later one
 * repeats from the earlier one. Pass only the workflows that count (enabled ones).
 */
export function copiedSteps(
  workflows: readonly { slug: string; workflow: { steps: readonly Step[] } }[],
): CopiedRun[] {
  const lists = workflows.map((w) => stepLists(w.workflow.steps));
  const out: CopiedRun[] = [];
  for (let i = 0; i < workflows.length; i++) {
    for (let j = i + 1; j < workflows.length; j++) {
      let best: Step[] | null = null;
      for (const a of lists[i] ?? []) {
        for (const b of lists[j] ?? []) {
          const run = longestRun(a, b);
          if (run && (!best || run.length > best.length)) best = run;
        }
      }
      const from = workflows[i]?.slug;
      const into = workflows[j]?.slug;
      if (best && from !== undefined && into !== undefined) {
        out.push({
          from,
          in: into,
          stepIds: best.map((s) => s.id),
          names: best.map((s) => s.name),
        });
      }
    }
  }
  return out;
}

/** The advice for a copy, as the validator and the Builder word it. */
export function copiedStepsMessage(run: CopiedRun): string {
  return `"${run.in}" repeats ${run.names.length} steps of "${run.from}", from "${run.names[0] ?? ""}" on: keep them in "${run.from}" alone and end "${run.in}" by handing off into "${run.from}" with "@self", one hand-off per item`;
}
